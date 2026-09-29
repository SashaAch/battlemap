// Scenes being edited, kept in memory (plan 8.6, item 2): every change is checked and applied here at once,
// and the scene is written to the database a second after its last change, but at most SAVE_CEILING_MS after its
// first unsaved change even while changes keep coming, and when the server stops.
// A scene with no unsaved change is not kept: it is read from the database.

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

interface Unsaved {
  gameId: number;
  scene: Scene;
  version: number;
  /** When the first change not written yet came (the `now` clock). */
  since: number;
  timer: ReturnType<typeof setTimeout>;
}

export class SceneMemory {
  readonly #db: Database;
  readonly #now: () => number;
  /** A write after the delay failed; the scene stays in memory and is written with its next change or at the stop. */
  readonly #saveFailed: (error: unknown) => void;
  readonly #unsaved = new Map<number, Unsaved>();

  constructor(db: Database, now: () => number, saveFailed: (error: unknown) => void) {
    this.#db = db;
    this.#now = now;
    this.#saveFailed = saveFailed;
  }

  /** The scene state and version now, with the changes not written yet. The state must not be changed by the caller. */
  read(record: SceneRecord): { scene: unknown; version: number } {
    const unsaved = this.#unsaved.get(record.id);
    return unsaved ? { scene: unsaved.scene, version: unsaved.version } : { scene: JSON.parse(record.stateJson), version: record.version };
  }

  /** The version now: it counts every accepted change, written or not. */
  version(info: SceneInfo): number {
    return this.#unsaved.get(info.id)?.version ?? info.version;
  }

  /**
   * Applies a change (plan 5.2), which applyPatch checks (plan 6.2): a bad change is 400 and a scene over 2 MiB 413,
   * and the scene stays as it was. Returns the new version; the write follows SAVE_DELAY_MS after the last change,
   * or sooner when SAVE_CEILING_MS since the first unsaved change run out first.
   */
  change(record: SceneRecord, patch: Patch): number {
    const unsaved = this.#unsaved.get(record.id);
    const scene = unsaved?.scene ?? parseScene(JSON.parse(record.stateJson));
    let inverse: Patch;
    try {
      inverse = applyPatch(scene, patch);
    } catch (error) {
      if (error instanceof SceneError) throw new ApiError("scene.patch");
      throw error;
    }
    if (Buffer.byteLength(JSON.stringify(scene)) > SCENE_MAX_BYTES) {
      applyPatch(scene, inverse);
      throw new ApiError("scene.tooLarge");
    }
    if (unsaved) clearTimeout(unsaved.timer);
    const version = (unsaved?.version ?? record.version) + 1;
    const now = this.#now();
    const since = unsaved?.since ?? now;
    const delay = Math.max(0, Math.min(SAVE_DELAY_MS, since + SAVE_CEILING_MS - now));
    const timer = setTimeout(() => {
      try {
        this.#save(record.id);
      } catch (error) {
        this.#saveFailed(error);
      }
    }, delay);
    this.#unsaved.set(record.id, { gameId: record.gameId, scene, version, since, timer });
    return version;
  }

  /** Writes every unsaved scene (the server stops); throws the first failure after trying them all. */
  saveAll(): void {
    let failure: { error: unknown } | null = null;
    for (const sceneId of [...this.#unsaved.keys()]) {
      try {
        this.#save(sceneId);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  /** A deleted game: its unsaved scenes are dropped. */
  forgetGame(gameId: number): void {
    for (const [sceneId, unsaved] of this.#unsaved) {
      if (unsaved.gameId !== gameId) continue;
      clearTimeout(unsaved.timer);
      this.#unsaved.delete(sceneId);
    }
  }

  #save(sceneId: number): void {
    const unsaved = this.#unsaved.get(sceneId);
    if (!unsaved) return;
    clearTimeout(unsaved.timer);
    this.#db.saveSceneState(sceneId, JSON.stringify(unsaved.scene), unsaved.version, this.#now());
    this.#unsaved.delete(sceneId);
  }
}
