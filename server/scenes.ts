// Scenes being edited, kept in memory (plan 8.6, item 2): every change is checked and applied here at once,
// and the scene is written to the database a second after its last change, but at most SAVE_CEILING_MS after its
// first unsaved change even while changes keep coming, and when the server stops.
// A written scene stays in memory until it has not changed for IDLE_UNLOAD_MS. The scenes in memory are at most
// the memory limit as JSON in all: over it, those changed longest ago are written and dropped. A scene not in
// memory is read from the database.

import { applyPatch, parseScene, SceneError } from "../client/src/board/store.ts";
import type { Patch, Scene } from "../client/src/board/store.ts";
import type { Database, SceneInfo, SceneRecord } from "./db.ts";
import { ApiError } from "./errors.ts";
import { MIB } from "./http.ts";

/** Plan 6.2: a scene is at most 2 MiB as JSON. */
const SCENE_MAX_BYTES = 2 * MIB;
/** Plan 8.6: the scene is written this long after its last change. */
export const SAVE_DELAY_MS = 1000;
/** Changes that never pause are still written this long after the first one not written yet. */
export const SAVE_CEILING_MS = 10_000;
/** The scenes in memory are at most this much as JSON in all (many large scenes changed at once must not fill the memory). */
export const MEMORY_LIMIT_BYTES = 32 * MIB;
/** A written scene not changed for this long is dropped from memory. */
export const IDLE_UNLOAD_MS = 60_000;

interface Loaded {
  gameId: number;
  scene: Scene;
  version: number;
  /** The size of the scene as JSON, counted towards the limit. */
  bytes: number;
  /** When the last change came (the `now` clock). */
  changedAt: number;
  /** When the first change not written yet came; null for a written scene. */
  since: number | null;
  /** The write to come, or the drop of a written scene. */
  timer: ReturnType<typeof setTimeout>;
}

export class SceneMemory {
  readonly #db: Database;
  readonly #now: () => number;
  /** A write after the delay failed; the scene stays in memory and is written with its next change or at the stop. */
  readonly #saveFailed: (error: unknown) => void;
  readonly #limit: number;
  /** In the order of the last change, the longest unchanged first. */
  readonly #loaded = new Map<number, Loaded>();
  #bytes = 0;

  constructor(db: Database, now: () => number, saveFailed: (error: unknown) => void, limitBytes = MEMORY_LIMIT_BYTES) {
    this.#db = db;
    this.#now = now;
    this.#saveFailed = saveFailed;
    this.#limit = limitBytes;
  }

  /** The size of the scenes in memory as JSON. */
  get bytes(): number {
    return this.#bytes;
  }

  isLoaded(sceneId: number): boolean {
    return this.#loaded.has(sceneId);
  }

  /** The scene state and version now, with the changes not written yet. The state must not be changed by the caller. */
  read(record: SceneRecord): { scene: unknown; version: number } {
    const loaded = this.#loaded.get(record.id);
    return loaded ? { scene: loaded.scene, version: loaded.version } : { scene: JSON.parse(record.stateJson), version: record.version };
  }

  /** The version now: it counts every accepted change, written or not. */
  version(info: SceneInfo): number {
    return this.#loaded.get(info.id)?.version ?? info.version;
  }

  /**
   * Applies a change (plan 5.2), which applyPatch checks (plan 6.2): a bad change is 400 and a scene over 2 MiB 413,
   * and the scene stays as it was. Returns the new version; the write follows SAVE_DELAY_MS after the last change,
   * or sooner when SAVE_CEILING_MS since the first unsaved change run out first.
   */
  change(record: SceneRecord, patch: Patch): number {
    const loaded = this.#loaded.get(record.id);
    const scene = loaded?.scene ?? parseScene(JSON.parse(record.stateJson));
    let inverse: Patch;
    try {
      inverse = applyPatch(scene, patch);
    } catch (error) {
      if (error instanceof SceneError) throw new ApiError("scene.patch");
      throw error;
    }
    const bytes = Buffer.byteLength(JSON.stringify(scene));
    if (bytes > SCENE_MAX_BYTES) {
      applyPatch(scene, inverse);
      throw new ApiError("scene.tooLarge");
    }
    if (loaded) this.#drop(record.id, loaded);
    const version = (loaded?.version ?? record.version) + 1;
    const now = this.#now();
    const since = loaded?.since ?? now;
    const delay = Math.max(0, Math.min(SAVE_DELAY_MS, since + SAVE_CEILING_MS - now));
    const timer = setTimeout(() => {
      try {
        this.#save(record.id);
      } catch (error) {
        this.#saveFailed(error);
      }
    }, delay);
    // Put back last: the map stays in the order of the last change.
    this.#loaded.set(record.id, { gameId: record.gameId, scene, version, bytes, changedAt: now, since, timer });
    this.#bytes += bytes;
    this.#trim();
    return version;
  }

  /** Writes every unsaved scene and empties the memory (the server stops); throws the first failure after trying them all. */
  saveAll(): void {
    let failure: { error: unknown } | null = null;
    for (const [sceneId, loaded] of this.#loaded) {
      try {
        this.#write(sceneId, loaded);
        this.#drop(sceneId, loaded);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  /** A deleted game: its scenes are dropped, written or not. */
  forgetGame(gameId: number): void {
    for (const [sceneId, loaded] of this.#loaded) if (loaded.gameId === gameId) this.#drop(sceneId, loaded);
  }

  /** Over the limit: the scenes changed longest ago are written and dropped until the rest fit. */
  #trim(): void {
    for (const [sceneId, loaded] of this.#loaded) {
      if (this.#bytes <= this.#limit) return;
      try {
        this.#write(sceneId, loaded);
        this.#drop(sceneId, loaded);
      } catch (error) {
        // An unwritten scene stays: dropping it would lose its changes.
        this.#saveFailed(error);
      }
    }
  }

  /** The timer after a change: writes the scene and keeps it until IDLE_UNLOAD_MS after its last change. */
  #save(sceneId: number): void {
    const loaded = this.#loaded.get(sceneId);
    if (!loaded) return;
    this.#write(sceneId, loaded);
    const unload = setTimeout(() => {
      if (this.#loaded.get(sceneId) === loaded) this.#drop(sceneId, loaded);
    }, Math.max(0, loaded.changedAt + IDLE_UNLOAD_MS - this.#now()));
    // A written scene has nothing to lose: it does not keep the process running.
    unload.unref();
    loaded.timer = unload;
  }

  /** Writes the scene if it has unsaved changes; throws when the database does. */
  #write(sceneId: number, loaded: Loaded): void {
    if (loaded.since === null) return;
    this.#db.saveSceneState(sceneId, JSON.stringify(loaded.scene), loaded.version, this.#now());
    loaded.since = null;
  }

  #drop(sceneId: number, loaded: Loaded): void {
    clearTimeout(loaded.timer);
    this.#loaded.delete(sceneId);
    this.#bytes -= loaded.bytes;
  }
}
