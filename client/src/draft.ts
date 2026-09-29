// The draft scene kept in the browser without a server (plan 8.1). No DOM: storage is passed in.

import { newScene, parseScene, SceneError } from "./board/store.ts";
import type { Scene } from "./board/store.ts";

export const DRAFT_KEY = "battlemap.draft";
/** Where a draft that could not be opened is kept, so starting a new scene does not destroy it. */
export const UNREADABLE_DRAFT_KEY = "battlemap.draft.unreadable";

/** The part of localStorage the draft needs; any call may throw. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Why the stored draft was not opened:
 * `newer` and `broken` when its text was kept under UNREADABLE_DRAFT_KEY,
 * `unkept` when even that copy failed.
 */
export type DraftProblem = "newer" | "broken" | "unkept";

interface OpenedDraft {
  scene: Scene;
  problem: DraftProblem | null;
  /** False when saving would overwrite an unreadable draft that has no copy. */
  canSave: boolean;
}

/** Decides what to open at start-up: the stored draft, or an empty scene with the reason. */
export function openDraft(storage: DraftStorage): OpenedDraft {
  let raw: string | null;
  try {
    raw = storage.getItem(DRAFT_KEY);
  } catch {
    raw = null; // storage is unavailable: nothing to open, saving will report the failure
  }
  if (raw === null) return { scene: newScene(), problem: null, canSave: true };

  let problem: DraftProblem;
  try {
    return { scene: parseScene(JSON.parse(raw)), problem: null, canSave: true };
  } catch (error) {
    if (error instanceof SceneError && error.code === "version") problem = "newer";
    else if (error instanceof SceneError || error instanceof SyntaxError) problem = "broken";
    else throw error;
  }

  try {
    storage.setItem(UNREADABLE_DRAFT_KEY, raw);
  } catch {
    return { scene: newScene(), problem: "unkept", canSave: false };
  }
  return { scene: newScene(), problem, canSave: true };
}

/** Writes the scene as the draft; returns false if the storage refused. */
export function saveDraft(storage: DraftStorage, scene: Scene): boolean {
  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(scene));
    return true;
  } catch {
    return false;
  }
}
