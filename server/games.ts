// Games, personal campaigns, members, game invites, scenes, their event streams and pings (plan 5.4, 5.11, 6.2,
// 6.3, 6.4, R6, R10, R24). Knows nothing about HTTP: the routes in app.ts pass values in and turn ApiError into a
// response; stream.ts writes the events this module decides to send.
//
// Rights, checked on every call from the database, so a change (a removed member, a new master) acts at once:
// - someone who is not a member gets 404 for the game and everything in it, as if it did not exist (plan 6.4);
// - the editor of a game changes its scenes, invites, members and master: the master, or the owner of a
//   personal campaign while it has no master (R24); any other member gets 403;
// - a player sees only the current scene, and only while it is visible; other scenes are 404 to them;
// - on the scene they see, a player only moves existing tokens of the side "players": a change of anything else
//   is 403 and changes nothing (plan 5.4, R6);
// - the master and the players who see the current scene put a ping on it (R6);
// - the game is deleted by its current master, a personal campaign only by its owner (R41);
// - a member leaves on their own, but not the master (they hand the game over first) nor the owner of a
//   personal campaign (they delete it); the owner of a personal campaign takes mastery back (R41).
// The same rights decide which events a member's stream gets; the streams of someone who loses the game close.

import { isPointInRange } from "../client/src/board/geometry.ts";
import { newScene, SceneError, validatePatch } from "../client/src/board/store.ts";
import type { Patch, Scene } from "../client/src/board/store.ts";
import { checkName, checkWhole, DAY_MS, INVITE_MAX_DAYS, INVITE_MAX_USES, LIMIT_WINDOW_MS, newInviteCode, sha256 } from "./auth.ts";
import type { Database, Game, GameKind, Member, MemberRole, MyGame, SceneInfo, SceneRecord, User } from "./db.ts";
import { ApiError } from "./errors.ts";
import { addressKey, AttemptLimiter } from "./limits.ts";
import { SceneMemory } from "./scenes.ts";
import type { Stream, Streams, StreamView } from "./stream.ts";

/** Failed joins (unknown, used up or expired code) per address in LIMIT_WINDOW_MS, like failed sign-ins (R39). */
export const MAX_JOIN_FAILURES_PER_ADDRESS = 10;
/** Plan 5.10: at most this many pings per user in PING_WINDOW_MS; more are 429 and reach nobody. */
export const MAX_PINGS = 5;
const PING_WINDOW_MS = 1000;

// ---- what the API shows ----

function myGameView(game: MyGame, user: User) {
  return { id: game.id, title: game.title, kind: game.kind, role: game.role, isOwner: game.ownerId === user.id, hasMaster: game.gmId !== null };
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

/**
 * A change a player may make (plan 5.4, R6): it moves an existing token of the side "players", every field but
 * `x` and `y` staying as it is. Deleting, adding, renaming or changing the side of a token is not one.
 */
function isPlayerMove(scene: Scene, [collection, key, value]: Patch[number]): boolean {
  if (collection !== "tokens" || !Object.hasOwn(scene.tokens, key) || value === null || typeof value !== "object") return false;
  const token = scene.tokens[key] as Record<string, unknown>;
  const moved = value as Record<string, unknown>;
  if (token.side !== "players") return false;
  const fields = new Set([...Object.keys(token), ...Object.keys(moved)]);
  fields.delete("x");
  fields.delete("y");
  return [...fields].every(
    (field) => Object.hasOwn(token, field) && Object.hasOwn(moved, field) && JSON.stringify(token[field]) === JSON.stringify(moved[field]),
  );
}

export class Games {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #streams: Streams;
  readonly #memory: SceneMemory;
  readonly #joinFailures = new AttemptLimiter(MAX_JOIN_FAILURES_PER_ADDRESS, LIMIT_WINDOW_MS);
  readonly #pings = new AttemptLimiter(MAX_PINGS, PING_WINDOW_MS);

  /** `saveFailed` gets a failed delayed write of a scene (the scene stays in memory until it is written). */
  constructor(db: Database, now: () => number, streams: Streams, saveFailed: (error: unknown) => void) {
    this.#db = db;
    this.#now = now;
    this.#streams = streams;
    this.#memory = new SceneMemory(db, now, saveFailed);
  }

  /** Writes the scenes changed in the last second; the server calls it when it stops. */
  saveAll(): void {
    this.#memory.saveAll();
  }

  // ---- rights ----

  #accessFor(game: Game, userId: number): Access | null {
    const role = this.#db.findMemberRole(game.id, userId);
    if (!role) return null;
    const editor = game.gmId === null ? game.ownerId === userId : game.gmId === userId;
    const keeper = game.kind === "personal" ? game.ownerId === userId : game.gmId === userId;
    return { game, role, editor, deleter: keeper, mayLeave: !keeper && game.gmId !== userId };
  }

  /** The game as seen by a member; 404 for anyone else, the game's existence is not given away. */
  #access(user: User, gameId: number): Access {
    const game = this.#db.findGame(gameId);
    const access = game && this.#accessFor(game, user.id);
    if (!access) throw new ApiError("game.notFound");
    return access;
  }

  #editor(user: User, gameId: number): Access {
    const access = this.#access(user, gameId);
    if (!access.editor) throw new ApiError("auth.forbidden");
    return access;
  }

  /** A scene of the game the member may see: an editor sees all of them, a player only the current visible one. */
  #scene(access: Access, sceneId: number): SceneRecord {
    const scene = this.#db.findScene(access.game.id, sceneId);
    if (!scene || !this.#sees(access, scene)) throw new ApiError("scene.notFound");
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

  #sees(access: Access, scene: SceneInfo): boolean {
    return access.editor || this.#playerSees(access.game, scene);
  }

  /** The scenes the member may see. */
  #visibleScenes(access: Access): SceneInfo[] {
    return this.#db.listScenes(access.game.id).filter((scene) => this.#sees(access, scene));
  }

  #sceneView(scene: SceneInfo, game: Game) {
    return { id: scene.id, name: scene.name, visible: scene.visible, active: game.activeSceneId === scene.id, version: this.#memory.version(scene) };
  }

  /** The scene with its state (plan 6.1), as the API and the snapshots show it. */
  #sceneData(game: Game, record: SceneRecord) {
    return { ...this.#sceneView(record, game), scene: this.#memory.read(record).scene };
  }

  // ---- streams (plan 6.3) ----

  /**
   * Opens the event stream of a member (404 for anyone else): `open` starts it (429 over the limit), then the
   * first event is the snapshot of what the member sees, and everyone in the game gets who is online.
   */
  openStream(user: User, gameId: number, open: () => Stream): void {
    const access = this.#access(user, gameId);
    const stream = open();
    this.#show(stream, access, true);
    this.#streams.announce(access.game.id);
  }

  /**
   * What the viewer sees: an editor the current scene (and any other scene they open), a player the current scene
   * only while it is visible, else none.
   */
  #viewOf(access: Access): StreamView {
    const current = access.game.activeSceneId;
    if (access.editor || current === null) return { editor: access.editor, sceneId: current };
    const scene = this.#db.findScene(access.game.id, current);
    return { editor: false, sceneId: scene && this.#playerSees(access.game, scene) ? current : null };
  }

  /**
   * Brings a stream up to date with its viewer's rights: `scene.switch` after a change of the game, and a new
   * `scene.snapshot` first, when the role changed, or when a player's scene changed (shown, hidden or switched).
   */
  #show(stream: Stream, access: Access, first: boolean): void {
    const view = this.#viewOf(access);
    const before = stream.view;
    if (!first) stream.send("scene.switch", { activeSceneId: access.editor ? access.game.activeSceneId : view.sceneId });
    if (first || !before || before.editor !== view.editor || (!view.editor && before.sceneId !== view.sceneId)) {
      const record = view.sceneId === null ? undefined : this.#db.findScene(access.game.id, view.sceneId);
      stream.send("scene.snapshot", { editor: view.editor, scene: record ? this.#sceneData(access.game, record) : null });
    }
    stream.view = view;
  }

  /**
   * The game changed (its current scene, a scene, the members or the master): every stream of it is brought up
   * to date, and the streams of someone no longer a member (removed, gone) close.
   */
  #changed(gameId: number): void {
    const game = this.#db.findGame(gameId);
    if (!game) return;
    for (const stream of this.#streams.ofGame(gameId)) {
      const access = this.#accessFor(game, stream.userId);
      if (access) this.#show(stream, access, false);
      else stream.close();
    }
  }

  /** Sends an event about a scene to the streams of the members who see it. */
  #sendAbout(game: Game, scene: SceneInfo, event: string, data: unknown): void {
    for (const stream of this.#streams.ofGame(game.id)) {
      const access = this.#accessFor(game, stream.userId);
      if (access && this.#sees(access, scene)) stream.send(event, data);
    }
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
      scenes: scenes.map((scene) => this.#sceneView(scene, game)),
    };
  }

  deleteGame(user: User, gameId: number): void {
    const { game, deleter } = this.#access(user, gameId);
    if (!deleter) throw new ApiError("auth.forbidden");
    this.#db.transaction(() => this.#db.deleteGame(game.id));
    this.#memory.forgetGame(game.id);
    this.#streams.closeGame(game.id);
  }

  /** The member leaves the game; the master and the owner of a personal campaign cannot (R41). */
  leave(user: User, gameId: number): void {
    const { game, mayLeave } = this.#access(user, gameId);
    if (!mayLeave) throw new ApiError("auth.forbidden");
    this.#db.deleteMember(game.id, user.id);
    this.#changed(game.id);
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
    this.#changed(game.id);
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
   * Joins the game of an invite as a player. A member of that game who opens the link again (on another device,
   * say) gets 200 with any code of the game that is still stored, even a used-up or expired one: nothing is used
   * up, it is no failure, and it gives nothing away, since the member knows the game. For anyone else an unknown
   * code is 404, and so is a used-up one, as a registration code answers the same for both (R38); an expired one
   * is 410. Every failure counts against the address; over the limit even a good code gets 429.
   */
  join(user: User, code: string, address: string): { gameId: number } {
    const now = this.#now();
    const key = addressKey(address);
    if (!this.#joinFailures.take(key, now)) throw new ApiError("invite.tooManyAttempts");
    const codeHash = sha256(code);
    const invite = this.#db.findGameInvite(codeHash);
    if (invite && this.#db.findMemberRole(invite.gameId, user.id)) {
      this.#joinFailures.giveBack(key, now);
      return { gameId: invite.gameId };
    }
    if (!invite || invite.uses >= invite.maxUses) throw new ApiError("invite.notFound");
    if (invite.expiresAt <= now) throw new ApiError("invite.expired");
    const joined = this.#db.transaction(() => {
      // Joined in between by a parallel request of the same user.
      if (this.#db.findMemberRole(invite.gameId, user.id)) return false;
      // Parallel joins may have used the last one up in between.
      if (!this.#db.useInvite(codeHash, "game", now)) throw new ApiError("invite.notFound");
      return this.#db.insertMember(invite.gameId, user.id, "player", now);
    });
    this.#joinFailures.giveBack(key, now);
    if (joined) this.#changed(invite.gameId);
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
    this.#changed(game.id);
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
    this.#changed(game.id);
  }

  // ---- scenes ----

  listScenes(user: User, gameId: number) {
    const access = this.#access(user, gameId);
    return this.#visibleScenes(access).map((scene) => this.#sceneView(scene, access.game));
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
    this.#changed(game.id);
    return this.getScene(user, gameId, scene.id);
  }

  /** The scene with its state (plan 6.1). */
  getScene(user: User, gameId: number, sceneId: number) {
    const access = this.#access(user, gameId);
    return this.#sceneData(access.game, this.#scene(access, sceneId));
  }

  /** Renames the scene and shows it to players or hides it; fields left out stay as they are. */
  updateScene(user: User, gameId: number, sceneId: number, change: { name?: string; visible?: boolean }) {
    const { access, scene } = this.#editedScene(user, gameId, sceneId);
    const name = change.name === undefined ? undefined : checkName(change.name, "scene.name");
    this.#db.transaction(() => {
      if (name !== undefined) this.#db.renameScene(scene.id, name);
      if (change.visible !== undefined) this.#db.setSceneVisible(scene.id, change.visible);
    });
    this.#changed(access.game.id);
    return this.#sceneView(this.#scene(access, sceneId), access.game);
  }

  /** Makes the scene the current one of the game: everyone opens it on entering. */
  activateScene(user: User, gameId: number, sceneId: number): void {
    const { access, scene } = this.#editedScene(user, gameId, sceneId);
    this.#db.setActiveScene(access.game.id, scene.id);
    this.#changed(access.game.id);
  }

  /**
   * Applies a change (plan 5.2, 6.2) and sends it, with the new version, to every stream that sees the scene,
   * the author's too: the server alone puts the changes in order (plan 5.3). An editor changes anything; a player
   * only moves tokens of the side "players" (R6), anything else is 403. A bad change is 400, a scene over 2 MiB
   * 413; the scene stays as it was. The scene is written to the database a second after its last change, at most
   * 10 seconds after its first unsaved one (scenes.ts).
   */
  patchScene(user: User, gameId: number, sceneId: number, input: unknown): { version: number; editor: boolean } {
    const access = this.#access(user, gameId);
    const record = this.#scene(access, sceneId);
    let patch: Patch;
    try {
      patch = validatePatch(input);
    } catch (error) {
      if (error instanceof SceneError) throw new ApiError("scene.patch");
      throw error;
    }
    // An empty change would only raise the version and wake everyone (and `[].every` below is true).
    if (patch.length === 0) throw new ApiError("scene.patch");
    if (!access.editor) {
      // Stored scenes were checked when written, so the tokens in them are well-formed.
      const scene = this.#memory.read(record).scene as Scene;
      if (!patch.every((op) => isPlayerMove(scene, op))) throw new ApiError("auth.forbidden");
    }
    const version = this.#memory.change(record, patch);
    this.#sendAbout(access.game, record, "scene.patch", { sceneId: record.id, version, patch });
    return { version, editor: access.editor };
  }

  /**
   * A ping on the current scene (R6): from the master, or from a player while the scene is visible; sent to
   * everyone who sees the scene with the author's name, never stored. `x`, `y` are a point of the board in the
   * range of plan 6.2. More than MAX_PINGS a second from one user are 429 and reach nobody.
   */
  ping(user: User, gameId: number, x: unknown, y: unknown): void {
    const access = this.#access(user, gameId);
    const { game } = access;
    const scene = game.activeSceneId === null ? undefined : this.#db.findScene(game.id, game.activeSceneId);
    if (!scene || !this.#sees(access, scene)) throw new ApiError("scene.notFound");
    if (typeof x !== "number" || typeof y !== "number" || !isPointInRange(x, y)) throw new ApiError("request.format");
    if (!this.#pings.take(String(user.id), this.#now())) throw new ApiError("ping.tooMany");
    this.#sendAbout(game, scene, "ping", { sceneId: scene.id, x, y, userId: user.id, name: user.displayName });
  }
}
