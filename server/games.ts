// Games, personal campaigns, members, game invites and scenes (plan 5.4, 5.11, 6.2, 6.4, R10, R24).
// Knows nothing about HTTP: the routes in app.ts pass values in and turn ApiError into a response.
//
// Rights, checked on every call from the database, so a change (a removed member, a new master) acts at once:
// - someone who is not a member gets 404 for the game and everything in it, as if it did not exist (plan 6.4);
// - the editor of a game changes its scenes, invites, members and master: the master, or the owner of a
//   personal campaign while it has no master (R24); any other member gets 403;
// - a player sees only the current scene, and only while it is visible; other scenes are 404 to them;
// - the game is deleted by its current master, a personal campaign only by its owner (R41);
// - a member leaves on their own, but not the master (they hand the game over first) nor the owner of a
//   personal campaign (they delete it); the owner of a personal campaign takes mastery back (R41).

import { applyPatch, newScene, parseScene, SceneError, validatePatch } from "../client/src/board/store.ts";
import { checkName, checkWhole, DAY_MS, INVITE_MAX_DAYS, INVITE_MAX_USES, LIMIT_WINDOW_MS, newInviteCode, sha256 } from "./auth.ts";
import type { Database, Game, GameKind, Member, MemberRole, MyGame, SceneInfo, SceneRecord, User } from "./db.ts";
import { ApiError } from "./errors.ts";
import { MIB } from "./http.ts";
import { addressKey, AttemptLimiter } from "./limits.ts";

/** Plan 6.2: a scene is at most 2 MiB as JSON. */
const SCENE_MAX_BYTES = 2 * MIB;
/** Failed joins (unknown, used up or expired code) per address in LIMIT_WINDOW_MS, like failed sign-ins (R39). */
export const MAX_JOIN_FAILURES_PER_ADDRESS = 10;

// ---- what the API shows ----

function myGameView(game: MyGame, user: User) {
  return { id: game.id, title: game.title, kind: game.kind, role: game.role, isOwner: game.ownerId === user.id, hasMaster: game.gmId !== null };
}

function sceneView(scene: SceneInfo, game: Game) {
  return { id: scene.id, name: scene.name, visible: scene.visible, active: game.activeSceneId === scene.id, version: scene.version };
}

function memberView(member: Member) {
  return { id: member.userId, displayName: member.displayName, role: member.role };
}

/** A member's access to a game. */
interface Access {
  game: Game;
  role: MemberRole;
  /** Changes scenes, invites, members and the master. */
  editor: boolean;
  /** Deletes the game: the master of a game, the owner of a personal campaign (R41). */
  deleter: boolean;
  /** May leave the game: anyone but the master and the owner of a personal campaign (R41). */
  mayLeave: boolean;
}

export class Games {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #joinFailures = new AttemptLimiter(MAX_JOIN_FAILURES_PER_ADDRESS, LIMIT_WINDOW_MS);

  constructor(db: Database, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  // ---- rights ----

  /** The game as seen by a member; 404 for anyone else, the game's existence is not given away. */
  #access(user: User, gameId: number): Access {
    const game = this.#db.findGame(gameId);
    const role = game && this.#db.findMemberRole(gameId, user.id);
    if (!game || !role) throw new ApiError("game.notFound");
    const editor = game.gmId === null ? game.ownerId === user.id : game.gmId === user.id;
    const keeper = game.kind === "personal" ? game.ownerId === user.id : game.gmId === user.id;
    return { game, role, editor, deleter: keeper, mayLeave: !keeper && game.gmId !== user.id };
  }

  #editor(user: User, gameId: number): Access {
    const access = this.#access(user, gameId);
    if (!access.editor) throw new ApiError("auth.forbidden");
    return access;
  }

  /** A scene of the game the member may see: an editor sees all of them, a player only the current visible one. */
  #scene(access: Access, sceneId: number): SceneRecord {
    const scene = this.#db.findScene(access.game.id, sceneId);
    if (!scene || !(access.editor || this.#playerSees(access.game, scene))) throw new ApiError("scene.notFound");
    return scene;
  }

  /**
   * A scene the editor changes. The scene is looked up first, so a player gets 404 for a scene they may not see
   * and 403 only for the one they see.
   */
  #editedScene(user: User, gameId: number, sceneId: number): { access: Access; scene: SceneRecord } {
    const access = this.#access(user, gameId);
    const scene = this.#scene(access, sceneId);
    if (!access.editor) throw new ApiError("auth.forbidden");
    return { access, scene };
  }

  #playerSees(game: Game, scene: SceneInfo): boolean {
    return scene.visible && game.activeSceneId === scene.id;
  }

  /** The scenes the member may see. */
  #visibleScenes(access: Access): SceneInfo[] {
    const scenes = this.#db.listScenes(access.game.id);
    return access.editor ? scenes : scenes.filter((scene) => this.#playerSees(access.game, scene));
  }

  // ---- games ----

  listGames(user: User) {
    return this.#db.listUserGames(user.id).map((game) => myGameView(game, user));
  }

  /** A game with the creator as its master, or a personal campaign without one (R24). */
  createGame(user: User, titleInput: string, kind: GameKind) {
    const title = checkName(titleInput, "game.title");
    const game = this.#db.transaction(() => {
      const created = this.#db.insertGame(title, kind, user.id, kind === "gm" ? user.id : null, this.#now());
      this.#db.insertMember(created.id, user.id, kind === "gm" ? "gm" : "player", this.#now());
      return created;
    });
    return this.getGame(user, game.id);
  }

  /** The game as the member sees it: members, the scenes they may see, and what they may do. */
  getGame(user: User, gameId: number) {
    const access = this.#access(user, gameId);
    const { game } = access;
    const scenes = this.#visibleScenes(access);
    return {
      id: game.id,
      title: game.title,
      kind: game.kind,
      ownerId: game.ownerId,
      gmId: game.gmId,
      role: access.role,
      isOwner: game.ownerId === user.id,
      editor: access.editor,
      canDelete: access.deleter,
      canLeave: access.mayLeave,
      // A player is not told which scene is current while it is hidden.
      activeSceneId: scenes.some((scene) => scene.id === game.activeSceneId) ? game.activeSceneId : null,
      members: this.#db.listMembers(game.id).map(memberView),
      scenes: scenes.map((scene) => sceneView(scene, game)),
    };
  }

  deleteGame(user: User, gameId: number): void {
    const { game, deleter } = this.#access(user, gameId);
    if (!deleter) throw new ApiError("auth.forbidden");
    this.#db.transaction(() => this.#db.deleteGame(game.id));
  }

  /** The member leaves the game; the master and the owner of a personal campaign cannot (R41). */
  leave(user: User, gameId: number): void {
    const { game, mayLeave } = this.#access(user, gameId);
    if (!mayLeave) throw new ApiError("auth.forbidden");
    this.#db.deleteMember(game.id, user.id);
  }

  /**
   * The owner of a personal campaign takes mastery back (R41): the campaign has no master again, the owner edits
   * its scenes and the former master stays as a player. A game with a master has no such owner right: 403.
   */
  takeMastery(user: User, gameId: number): void {
    const { game } = this.#access(user, gameId);
    if (game.kind !== "personal" || game.ownerId !== user.id) throw new ApiError("auth.forbidden");
    if (game.gmId === null) return;
    const formerMaster = game.gmId;
    this.#db.transaction(() => {
      this.#db.setMemberRole(game.id, formerMaster, "player");
      this.#db.setGameMaster(game.id, null);
    });
  }

  // ---- invites and members ----

  /**
   * An invite code for `maxUses` joins within `days` days, with the bounds of a registration code (R38, R41).
   * Only its hash is stored; the code is shown once.
   */
  createInvite(user: User, gameId: number, maxUses: number, days: number): { code: string; expiresAt: number; maxUses: number } {
    const { game } = this.#editor(user, gameId);
    checkWhole(maxUses, INVITE_MAX_USES);
    checkWhole(days, INVITE_MAX_DAYS);
    const code = newInviteCode();
    const expiresAt = this.#now() + days * DAY_MS;
    this.#db.insertInvite(sha256(code), "game", game.id, user.id, expiresAt, maxUses);
    return { code, expiresAt, maxUses };
  }

  /**
   * Joins the game of an invite as a player; a member joining again stays as they are and uses nothing up.
   * An unknown code is 404, and so is a used-up one, as a registration code answers the same for both (R38);
   * an expired one is 410. Every failure counts against the address; over the limit even a good code gets 429.
   */
  join(user: User, code: string, address: string): { gameId: number } {
    const now = this.#now();
    const key = addressKey(address);
    if (!this.#joinFailures.take(key, now)) throw new ApiError("invite.tooManyAttempts");
    const codeHash = sha256(code);
    const invite = this.#db.findGameInvite(codeHash);
    if (!invite || invite.uses >= invite.maxUses) throw new ApiError("invite.notFound");
    if (invite.expiresAt <= now) throw new ApiError("invite.expired");
    this.#db.transaction(() => {
      if (this.#db.findMemberRole(invite.gameId, user.id)) return;
      // Parallel joins may have used the last one up in between.
      if (!this.#db.useInvite(codeHash, "game", now)) throw new ApiError("invite.notFound");
      this.#db.insertMember(invite.gameId, user.id, "player", now);
    });
    this.#joinFailures.giveBack(key, now);
    return { gameId: invite.gameId };
  }

  /**
   * Removes a member other than the master and the owner of a personal campaign. The game's invites are dropped
   * too, so the removed user cannot come back with a code they still have; the editor makes a new one for the others.
   */
  removeMember(user: User, gameId: number, memberId: number): void {
    const { game } = this.#editor(user, gameId);
    if (!this.#db.findMemberRole(game.id, memberId)) throw new ApiError("member.notFound");
    const campaignOwner = game.kind === "personal" && memberId === game.ownerId;
    if (campaignOwner || memberId === game.gmId) throw new ApiError("member.protected");
    this.#db.transaction(() => {
      this.#db.deleteMember(game.id, memberId);
      this.#db.deleteGameInvites(game.id);
    });
  }

  /** The master hands the game to another member; in a personal campaign without a master the owner names one (5.11). */
  setMaster(user: User, gameId: number, memberId: number): void {
    const { game } = this.#editor(user, gameId);
    if (!this.#db.findMemberRole(game.id, memberId)) throw new ApiError("member.notFound");
    if (memberId === game.gmId) return;
    this.#db.transaction(() => {
      if (game.gmId !== null) this.#db.setMemberRole(game.id, game.gmId, "player");
      this.#db.setMemberRole(game.id, memberId, "gm");
      this.#db.setGameMaster(game.id, memberId);
    });
  }

  // ---- scenes ----

  listScenes(user: User, gameId: number) {
    const access = this.#access(user, gameId);
    return this.#visibleScenes(access).map((scene) => sceneView(scene, access.game));
  }

  /** A new empty scene, hidden from players; the first scene of a game becomes its current one. */
  createScene(user: User, gameId: number, nameInput: string) {
    const { game } = this.#editor(user, gameId);
    const name = checkName(nameInput, "scene.name");
    const scene = this.#db.transaction(() => {
      const created = this.#db.insertScene(game.id, name, JSON.stringify(newScene()), this.#now());
      if (game.activeSceneId === null) this.#db.setActiveScene(game.id, created.id);
      return created;
    });
    return this.getScene(user, gameId, scene.id);
  }

  /** The scene with its state (plan 6.1). */
  getScene(user: User, gameId: number, sceneId: number) {
    const access = this.#access(user, gameId);
    const scene = this.#scene(access, sceneId);
    return { ...sceneView(scene, access.game), scene: JSON.parse(scene.stateJson) as unknown };
  }

  /** Renames the scene and shows it to players or hides it; fields left out stay as they are. */
  updateScene(user: User, gameId: number, sceneId: number, change: { name?: string; visible?: boolean }) {
    const { access, scene } = this.#editedScene(user, gameId, sceneId);
    const name = change.name === undefined ? undefined : checkName(change.name, "scene.name");
    this.#db.transaction(() => {
      if (name !== undefined) this.#db.renameScene(scene.id, name);
      if (change.visible !== undefined) this.#db.setSceneVisible(scene.id, change.visible);
    });
    return sceneView(this.#scene(access, sceneId), access.game);
  }

  /** Makes the scene the current one of the game: everyone opens it on entering. */
  activateScene(user: User, gameId: number, sceneId: number): void {
    const { access, scene } = this.#editedScene(user, gameId, sceneId);
    this.#db.setActiveScene(access.game.id, scene.id);
  }

  /**
   * Applies a change (plan 5.2, 6.2) checked by validatePatch of the board and saves the scene; a bad change
   * is 400 and a scene over 2 MiB 413, and the scene stays as it was. Returns the new version.
   */
  patchScene(user: User, gameId: number, sceneId: number, patch: unknown): { version: number } {
    return this.#db.transaction(() => {
      const { scene: record } = this.#editedScene(user, gameId, sceneId);
      const scene = parseScene(JSON.parse(record.stateJson));
      try {
        applyPatch(scene, validatePatch(patch));
      } catch (error) {
        if (error instanceof SceneError) throw new ApiError("scene.patch");
        throw error;
      }
      const json = JSON.stringify(scene);
      if (Buffer.byteLength(json) > SCENE_MAX_BYTES) throw new ApiError("scene.tooLarge");
      return { version: this.#db.saveSceneState(record.id, json, this.#now()) };
    });
  }
}
