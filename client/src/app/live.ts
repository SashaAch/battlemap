// A game scene kept up to date by the event stream (plan 5.3, 6.3). The server alone puts the changes in order
// and sends each one, with the scene version it made, to everyone, the author too. The board shows the server's
// scene with this board's own changes on top until they come back: an incoming change of someone else is put
// under them. No DOM here.

import { applyPatch, validatePatch } from "../board/store.ts";
import type { Patch, Scene } from "../board/store.ts";

/** A change of this board that has not come back from the server yet, and the patch that takes it off the scene. */
interface Pending {
  patch: Patch;
  inverse: Patch;
}

/**
 * What became of a change from the stream: `applied` changed the scene, `own` was a change of this board coming
 * back, `old` was already in the scene, `gap` means changes were missed and the scene must be read again.
 */
export type Received = "applied" | "own" | "old" | "gap";

export class LiveScene {
  readonly sceneId: number;
  /** The scene on the board: the server's version with the pending changes on top. */
  readonly scene: Scene;
  #version: number;
  readonly #pending: Pending[] = [];

  constructor(sceneId: number, scene: Scene, version: number) {
    this.sceneId = sceneId;
    this.scene = scene;
    this.#version = version;
  }

  /** The server's version the scene is at. */
  get version(): number {
    return this.#version;
  }

  /** A change the board already made to the scene; `inverse` takes it back off. */
  local(patch: Patch, inverse: Patch): void {
    this.#pending.push({ patch, inverse });
  }

  /**
   * A change from the stream with the version the server gave it. The first pending change equal to it is this
   * board's change coming back. Changes are absolute values, so taking someone else's equal change for it gives
   * the same scene. Throws SceneError for a change that is not valid, before touching the scene.
   */
  receive(version: number, patch: Patch): Received {
    if (version <= this.#version) return "old";
    if (version !== this.#version + 1) return "gap";
    validatePatch(patch);
    this.#version = version;
    const first = this.#pending[0];
    if (first && JSON.stringify(first.patch) === JSON.stringify(patch)) {
      this.#pending.shift();
      return "own";
    }
    // The pending changes come off, the server's change goes on, and they go back on top of it.
    for (let i = this.#pending.length - 1; i >= 0; i--) applyPatch(this.scene, this.#pending[i].inverse);
    applyPatch(this.scene, patch);
    for (const entry of this.#pending) entry.inverse = applyPatch(this.scene, entry.patch);
    return "applied";
  }
}
