// A game on the board (plan 5.3, 5.4, 5.11, 8.5, 8.6): the board shows a scene from the server, kept up to date by
// the event stream; the top bar shows the game, its scene and who is online, a drawer the scenes and the members, and
// a window the invite (R45).
// Every finished change of the board goes to the server, which puts all changes in order and sends each one back
// to everyone; the board shows its own changes at once and puts the others' under them (live.ts).
// The editor (the master, or the owner of a personal campaign without one) draws with the usual tools; a player
// moves the tokens of the side "players", measures and pings. User text (titles, scene names, member names) goes
// only through textContent.

import type { Point } from "../board/geometry.ts";
import { newScene, parseScene, SceneError } from "../board/store.ts";
import type { Patch, Scene } from "../board/store.ts";
import { t } from "../i18n/index.ts";
import type { Key } from "../i18n/index.ts";
import { icon } from "../ui/icons.ts";
import { request } from "./api.ts";
import type { GameInfo, GameInvite, MemberInfo, SceneData, SceneSummary } from "./api.ts";
import { inviteView } from "./invite.ts";
import type { InviteView } from "./invite.ts";
import { LiveScene } from "./live.ts";
import type { Received } from "./live.ts";
import { button, codeOf, errorKey, field, iconButton, labelled, setKey, setLabel } from "./login.ts";
import { echoChange, measuring, RoundTrips } from "./measure.ts";
import type { RoundTripSummary } from "./measure.ts";
import { openStream } from "./stream.ts";
import type { GameStream, StreamEventName } from "./stream.ts";

/** What the user may do on a game scene. */
export interface BoardAccess {
  /** Gets every finished change with the patch that takes it back; null makes the board read-only. */
  changed: ((patch: Patch, inverse: Patch) => void) | null;
  /** A player: moves only tokens of the side "players", measures and pings (plan 5.4, R6). */
  player: boolean;
  /** Puts a ping at a point of the board. */
  ping(point: Point): void;
}

/** What the game needs from the board (main.ts). */
export interface GameBoard {
  /** Shows a game scene instead of the draft. */
  show(scene: Scene, access: BoardAccess): void;
  /** Back to the draft kept in the browser. */
  showDraft(): void;
  /** A stroke or a drag is under way: the scene must not be replaced or changed now. */
  busy(): boolean;
  /** The scene on the board was changed by a change from the server: draw it again. */
  refresh(): void;
  /** Shows a ping of `name` for a few seconds. */
  ping(point: Point, name: string): void;
}

export interface GameHooks {
  board: GameBoard;
  showNotice(key: Key, params?: Record<string, string | number>): void;
  /** Hides the notice if it is the one of `key`. */
  clearNotice(key: Key): void;
  /** An ended session: back to sign-in. */
  failed(error: unknown): void;
  /** Opens the "my games" screen. */
  showGames(): void;
  /** Whether the signed-in user is an administrator: their invite also registers newcomers (R43). */
  isAdmin(): boolean;
  /** With `?measure` in the address: the times there and back so far on the master's board, null to hide them (measure.ts). */
  measured(summary: RoundTripSummary | null): void;
}

export interface GameView {
  open(gameId: number): void;
  /** Back to the draft; nothing when no game is open. */
  close(): void;
  /** After a reload or a link in the open tab: opens the game named in the address (#game=ID) unless it is open; true when it did. */
  reopen(): boolean;
}

/** Events of the stream (server/games.ts). */
interface SnapshotEvent {
  editor: boolean;
  scene: SceneData | null;
}

interface PatchEvent {
  sceneId: number;
  version: number;
  patch: Patch;
}

interface PingEvent {
  sceneId: number;
  x: number;
  y: number;
  userId: number;
  name: string;
}

const GAME_HASH = /^#game=([1-9][0-9]{0,14})$/;
const IDLE_CHECK_MS = 100;
/** After the server refused the stream for a passing reason (too many tabs, a restart), it is opened again this much later. */
const STREAM_RETRY_MS = 5000;
/** The defaults and bounds of a registration code (admin.ts, server/auth.ts), which a game invite follows (R41). */
const INVITE_USES = 1;
const INVITE_MAX_USES = 1000;
const INVITE_DAYS = 7;
const INVITE_MAX_DAYS = 365;

function pageElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`element #${id} is missing`);
  return element;
}

export function startGame(hooks: GameHooks): GameView {
  // The top bar (index.html): the game and its scene at the left, who is online and the invite at the right (R45).
  const titleText = pageElement("game-title", HTMLElement);
  const scenePicker = pageElement("scene-picker", HTMLElement);
  const onlineList = pageElement("online", HTMLElement);
  const inviteOpen = pageElement("invite-open", HTMLButtonElement);
  const back = pageElement("back", HTMLButtonElement);
  back.append(icon("back", 20));
  back.addEventListener("click", hooks.showGames);
  inviteOpen.prepend(icon("qr", 16));
  inviteOpen.addEventListener("click", () => openInvite());

  // Scenes and members in a drawer at the right, closed at the start; two tabs at the edge open it.
  const panel = document.createElement("aside");
  panel.className = "drawer";
  panel.id = "drawer";
  panel.hidden = true;
  const tabs = document.createElement("nav");
  tabs.className = "drawer-tabs game-only";
  const scenesTab = document.createElement("button");
  const membersTab = button("game.members", () => openDrawer("members"));
  scenesTab.type = "button";
  scenesTab.addEventListener("click", () => openDrawer("scenes"));
  for (const tab of [scenesTab, membersTab]) tab.setAttribute("aria-controls", panel.id);
  tabs.append(scenesTab, membersTab);
  const invite = document.createElement("dialog");
  invite.className = "invite-dialog";
  document.body.append(tabs, panel, invite);

  const connection = labelled("p", "game.streamLost", "plate connection");
  connection.setAttribute("role", "status");
  connection.hidden = true;
  pageElement("messages", HTMLElement).prepend(connection);

  /** The open game, null on the draft. */
  let openId: number | null = null;
  let info: GameInfo | null = null;
  /** The scene on the board (or being read), null when there is none to show. */
  let shownScene: number | null = null;
  /** The scene on the board with the changes not yet back from the server; null for none or a read-only one. */
  let live: LiveScene | null = null;
  /** Whether the board shows the scene as an editor. */
  let shownEditor = false;
  let stream: GameStream | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Events of the stream wait here while a stroke or a drag is under way or the scene is being read. */
  const queue: { name: StreamEventName; data: unknown }[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let loading = 0;
  let online = new Set<number>();
  /** The "online" mark of each member in the drawer, with the name for the top bar. */
  const onlineMarks = new Map<number, { name: string; mark: HTMLElement }>();
  /** Changes go to the server one after another, in the order they were made. */
  let patches: Promise<void> = Promise.resolve();
  /** Goes up when a change is refused: the changes waiting after it are dropped, the scene is read again. */
  let sendRound = 0;
  let changeCount = 0;
  /** Only the latest read of the game is shown. */
  let loadCount = 0;
  /** `?measure` in the address: a player answers each change from someone else with a ping, the master counts the time. */
  const measure = measuring(location.search);
  let roundTrips = new RoundTrips();
  /** The last invite made in the open game: it stays on the panel while friends scan it, though the panel is drawn again as they join. */
  let shownInvite: InviteView | null = null;

  const whenIdle = (): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (hooks.board.busy()) setTimeout(check, IDLE_CHECK_MS);
        else resolve();
      };
      check();
    });

  /** Waits until every change made so far has had its answer. */
  async function drained(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = patches;
      await seen;
    } while (seen !== patches);
  }

  /** The open game is gone (deleted, or the user removed): back to "my games". */
  function gone(): void {
    close();
    hooks.showNotice("notice.gameGone");
    hooks.showGames();
  }

  /** A failed request about the open game. A game that is gone closes. */
  function failed(error: unknown, gameId: number): void {
    if (openId !== gameId) return;
    const code = codeOf(error);
    if (code === "auth.required" || code === "auth.mustChangePassword") hooks.failed(error);
    else if (code === "game.notFound") gone();
    else hooks.showNotice(errorKey(code));
  }

  // ---- changes of the board ----

  function send(gameId: number, target: LiveScene, patch: Patch, inverse: Patch): void {
    if (patch.length === 0 || live !== target) return;
    target.local(patch, inverse);
    changeCount++;
    const round = sendRound;
    patches = patches.then(async () => {
      if (round !== sendRound || openId !== gameId) return;
      // Only a change of the current scene reaches the players, so only it gets an answer.
      if (measure && shownEditor && info !== null && target.sceneId === info.activeSceneId) roundTrips.sent(performance.now());
      try {
        await request("POST", `api/games/${gameId}/scenes/${target.sceneId}/patch`, { patch });
      } catch (error) {
        refused(gameId, target.sceneId, error);
      }
    });
  }

  /** A change the server did not take (403, 404, a network failure): the board no longer matches the server. */
  function refused(gameId: number, sceneId: number, error: unknown): void {
    sendRound++;
    if (openId !== gameId) return;
    const code = codeOf(error);
    if (code === "auth.required" || code === "auth.mustChangePassword") {
      hooks.failed(error);
    } else if (code === "game.notFound") {
      gone();
    } else {
      hooks.showNotice("notice.changeRejected", { reason: t(errorKey(code)) });
      void load(gameId, sceneId);
    }
  }

  function sendPing(gameId: number, point: Point): void {
    if (openId !== gameId) return;
    // The ping is put on the current scene: the others see only that one.
    if (live === null || info === null || live.sceneId !== info.activeSceneId) {
      hooks.showNotice("notice.pingNotCurrent");
      return;
    }
    request("POST", `api/games/${gameId}/ping`, { x: point.x, y: point.y }).catch((error: unknown) => {
      if (codeOf(error) === "ping.tooMany") hooks.showNotice(errorKey("ping.tooMany"));
      else failed(error, gameId);
    });
  }

  /** Puts a scene from the server on the board, as an editor or a player; null shows an empty read-only board. */
  function showScene(gameId: number, data: SceneData | null, editor: boolean): void {
    shownScene = data?.id ?? null;
    shownEditor = editor;
    live = null;
    let scene = newScene();
    if (data) {
      try {
        scene = parseScene(data.scene);
      } catch (error) {
        if (!(error instanceof SceneError)) throw error;
        hooks.showNotice(error.code === "version" ? "notice.sceneNewer" : "notice.sceneBroken");
        hooks.board.show(scene, { changed: null, player: !editor, ping: (point) => sendPing(gameId, point) });
        return;
      }
    }
    const target = data ? new LiveScene(data.id, scene, data.version) : null;
    live = target;
    hooks.board.show(scene, {
      changed: target ? (patch, inverse) => send(gameId, target, patch, inverse) : null,
      player: !editor,
      ping: (point) => sendPing(gameId, point),
    });
    render();
  }

  // ---- the stream ----

  function connect(gameId: number): void {
    stream?.close();
    stream = openStream(gameId, {
      event: (name, data) => {
        if (openId !== gameId) return;
        queue.push({ name, data });
        drain();
      },
      connected: () => {
        if (openId === gameId) connection.hidden = true;
      },
      lost: () => {
        if (openId === gameId) disconnected();
      },
      failed: () => streamFailed(gameId),
    });
  }

  /** Without the stream nobody is known to be online; the server sends the list again on reconnecting. */
  function disconnected(): void {
    connection.hidden = false;
    online = new Set();
    markOnline();
  }

  /** The server refused the stream: an ended session or a game that is gone ends it, anything else is tried again. */
  function streamFailed(gameId: number): void {
    if (openId !== gameId) return;
    stream = null;
    disconnected();
    const retry = (): void => {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (openId === gameId && stream === null) connect(gameId);
      }, STREAM_RETRY_MS);
    };
    request<GameInfo>("GET", `api/games/${gameId}`).then(retry, (error: unknown) => {
      const code = codeOf(error);
      if (code === "auth.required" || code === "auth.mustChangePassword" || code === "game.notFound") failed(error, gameId);
      else retry();
    });
  }

  /** Handles the waiting events in order, unless a stroke, a drag or a read of the scene is under way. */
  function drain(): void {
    while (queue.length > 0 && loading === 0) {
      if (hooks.board.busy()) {
        if (drainTimer === undefined) {
          drainTimer = setTimeout(() => {
            drainTimer = undefined;
            drain();
          }, IDLE_CHECK_MS);
        }
        return;
      }
      const next = queue.shift();
      if (next && openId !== null) handle(openId, next.name, next.data);
    }
  }

  function handle(gameId: number, name: StreamEventName, data: unknown): void {
    switch (name) {
      case "scene.snapshot": {
        const { editor, scene } = data as SnapshotEvent;
        // The board already shows this state: it keeps its undo history and the changes on their way.
        if (live && scene && live.sceneId === scene.id && live.version === scene.version && shownEditor === editor) return;
        // An editor keeps the scene they opened, read again; a player sees what the server shows.
        if (editor && shownEditor && shownScene !== null && scene?.id !== shownScene) void load(gameId, shownScene);
        else showScene(gameId, scene, editor);
        return;
      }
      case "scene.patch": {
        const { sceneId, version, patch } = data as PatchEvent;
        if (!live || live.sceneId !== sceneId) return;
        let result: Received;
        try {
          result = live.receive(version, patch);
        } catch (error) {
          if (!(error instanceof SceneError)) throw error;
          result = "gap";
        }
        if (result === "gap") {
          void load(gameId, sceneId);
        } else if (result === "applied") {
          hooks.board.refresh();
          // The board draws on the next frame; the answer goes right after it.
          if (!shownEditor) echoChange(measure, (callback) => requestAnimationFrame(callback), (point) => sendPing(gameId, point));
        }
        return;
      }
      case "scene.switch":
        refreshInfo(gameId);
        return;
      case "presence":
        online = new Set((data as { online: number[] }).online);
        markOnline();
        return;
      case "ping": {
        const ping = data as PingEvent;
        if (measure && shownEditor && info !== null && ping.userId !== (info.gmId ?? info.ownerId)) {
          const at = performance.now();
          if (roundTrips.answered(at) !== null) hooks.measured(roundTrips.summary());
        }
        if (live && ping.sceneId === live.sceneId) hooks.board.ping({ x: ping.x, y: ping.y }, ping.name);
        return;
      }
    }
  }

  // ---- reading the game ----

  /**
   * Reads the game and shows the scene `preferred` if the user may see it, else the current one (an editor
   * without a current scene gets the first). It waits for strokes and sent changes to end, and reads again
   * if a change was made while it read, so the board never drops a change of its own. Stream events wait meanwhile.
   */
  async function load(gameId: number, preferred: number | null): Promise<void> {
    const mine = ++loadCount;
    const current = (): boolean => mine === loadCount && openId === gameId;
    loading++;
    try {
      for (;;) {
        await whenIdle();
        await drained();
        if (!current()) return;
        const before = changeCount;
        let game: GameInfo;
        let data: SceneData | null = null;
        try {
          game = await request<GameInfo>("GET", `api/games/${gameId}`);
          const ids = game.scenes.map((scene) => scene.id);
          const wanted = preferred !== null && ids.includes(preferred) ? preferred : (game.activeSceneId ?? (game.editor ? (ids[0] ?? null) : null));
          if (wanted !== null) data = await request<SceneData>("GET", `api/games/${gameId}/scenes/${wanted}`);
        } catch (error) {
          if (current()) failed(error, gameId);
          return;
        }
        if (!current()) return;
        if (before !== changeCount || hooks.board.busy()) continue;
        info = game;
        opened();
        showScene(gameId, data, game.editor);
        return;
      }
    } finally {
      loading--;
      drain();
    }
  }

  /** The game was read: a notice that it is gone, left from an earlier attempt, no longer holds. */
  function opened(): void {
    hooks.clearNotice("notice.gameGone");
  }

  /** Reads the game again for the panel only; the board and its undo history stay. */
  function refreshInfo(gameId: number): void {
    request<GameInfo>("GET", `api/games/${gameId}`).then((game) => {
      if (openId !== gameId) return;
      opened();
      if (JSON.stringify(game) === JSON.stringify(info)) return;
      info = game;
      render();
    }, (error: unknown) => failed(error, gameId));
  }

  /** Runs a request of the panel, then `next` with its answer. */
  function act<T>(gameId: number, action: Promise<T>, next: (result: T) => void): void {
    action.then((result) => {
      if (openId === gameId) next(result);
    }, (error: unknown) => failed(error, gameId));
  }

  // ---- the panel ----

  /** Opens the drawer at the scenes or the members. */
  function openDrawer(part: "scenes" | "members"): void {
    panel.hidden = false;
    document.body.classList.add("drawer-open");
    for (const [tab, name] of [[scenesTab, "scenes"], [membersTab, "members"]] as const) tab.setAttribute("aria-expanded", String(name === part));
    panel.querySelector(`[data-part="${part}"]`)?.scrollIntoView({ block: "start" });
  }

  function closeDrawer(): void {
    panel.hidden = true;
    document.body.classList.remove("drawer-open");
    for (const tab of [scenesTab, membersTab]) tab.setAttribute("aria-expanded", "false");
  }

  /** The game and the scene on the board in the top bar; an editor picks the scene there too. */
  function renderTopBar(game: GameInfo | null): void {
    titleText.textContent = game?.title ?? "";
    inviteOpen.hidden = !game?.editor;
    scenePicker.replaceChildren();
    if (!game) return;
    const shown = game.scenes.find((scene) => scene.id === shownScene);
    if (shown) scenePicker.append(icon(shown.visible ? "eye" : "eyeoff", 16));
    if (!game.editor) {
      const name = document.createElement("span");
      name.className = "scene-name";
      if (shown) name.textContent = shown.name;
      else setKey(name, "game.noScene");
      scenePicker.append(name);
      return;
    }
    if (game.scenes.length === 0) return;
    const select = document.createElement("select");
    setLabel(select, "game.scene");
    for (const scene of game.scenes) {
      const option = document.createElement("option");
      option.value = String(scene.id);
      option.textContent = scene.name;
      select.append(option);
    }
    select.value = String(shownScene);
    select.addEventListener("change", () => void load(game.id, Number(select.value)));
    scenePicker.append(select);
  }

  function render(): void {
    const game = info;
    renderTopBar(game);
    setKey(scenesTab, game?.editor === false ? "game.scene" : "game.scenes");
    const header = document.createElement("div");
    header.className = "drawer-header";
    const title = document.createElement("h2");
    title.textContent = game?.title ?? "";
    header.append(title, iconButton("close", "common.close", closeDrawer));
    panel.replaceChildren(header);
    onlineMarks.clear();
    if (!game) return;
    panel.append(labelled("p", game.kind === "gm" ? "games.kind.gm" : "games.kind.personal", "muted"));
    panel.append(game.editor ? scenesSection(game) : playerSection(game), membersSection(game));
    if (!game.editor) {
      shownInvite = null;
      invite.close();
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      button("game.reload", () => void load(game.id, shownScene)),
      button("game.close", close),
    );
    // The owner of a personal campaign takes mastery back from the master they named (R41).
    if (game.kind === "personal" && game.isOwner && game.gmId !== null) {
      actions.append(
        button("game.takeMastery", () => {
          if (!confirm(t("game.confirmTakeMastery"))) return;
          act(game.id, request("DELETE", `api/games/${game.id}/master`), () => void load(game.id, shownScene));
        }),
      );
    }
    if (game.canLeave) {
      actions.append(
        button("game.leave", () => {
          if (!confirm(t("game.confirmLeave", { title: game.title }))) return;
          act(game.id, request("POST", `api/games/${game.id}/leave`), () => {
            close();
            hooks.showGames();
          });
        }),
      );
    }
    panel.append(actions);
    // Away from everything else, at the very bottom (audit finding 5).
    if (game.canDelete) {
      const danger = document.createElement("div");
      danger.className = "danger-zone";
      danger.append(
        button(
          "game.delete",
          () => {
            if (!confirm(t("game.confirmDelete", { title: game.title }))) return;
            act(game.id, request("DELETE", `api/games/${game.id}`), () => {
              close();
              hooks.showGames();
            });
          },
          "danger",
        ),
      );
      panel.append(danger);
    }
    markOnline();
  }

  function section(titleKey: Key, part: "scenes" | "members"): HTMLElement {
    const element = document.createElement("section");
    element.dataset.part = part;
    element.append(labelled("h3", titleKey));
    return element;
  }

  function sceneRow(game: GameInfo, scene: SceneSummary): HTMLLIElement {
    const path = `api/games/${game.id}/scenes/${scene.id}`;
    const item = document.createElement("li");
    const name = document.createElement("button");
    name.type = "button";
    name.className = "scene-name";
    name.textContent = scene.name;
    name.setAttribute("aria-pressed", String(scene.id === shownScene));
    name.addEventListener("click", () => void load(game.id, scene.id));

    // "current" is a plain mark, not a button (audit finding 6); the other scenes offer to become current.
    const currentMark = scene.active
      ? labelled("span", "game.sceneCurrent", "badge")
      : button("game.makeCurrent", () => act(game.id, request("POST", `${path}/activate`), () => refreshInfo(game.id)), "small");

    const visible = iconButton(scene.visible ? "eye" : "eyeoff", "game.visible", () => {
      act(game.id, request("PUT", path, { visible: !scene.visible }), () => refreshInfo(game.id));
    });
    visible.setAttribute("aria-pressed", String(scene.visible));

    const rename = iconButton("pencil", "game.rename", () => {
      const next = prompt(t("game.renamePrompt"), scene.name);
      if (next === null) return;
      act(game.id, request("PUT", path, { name: next }), () => refreshInfo(game.id));
    });
    item.append(name, currentMark, visible, rename);
    return item;
  }

  function scenesSection(game: GameInfo): HTMLElement {
    const element = section("game.scenes", "scenes");
    if (game.scenes.length === 0) element.append(labelled("p", "game.noScenes", "muted"));
    const list = document.createElement("ul");
    list.className = "scene-list";
    list.append(...game.scenes.map((scene) => sceneRow(game, scene)));

    const create = document.createElement("form");
    create.className = "inline-form";
    const name = field("game.sceneName", { autocomplete: "off", maxLength: 40 });
    const submit = labelled("button", "game.createScene", "primary");
    submit.type = "submit";
    create.append(name.wrap, submit);
    create.addEventListener("submit", (event) => {
      event.preventDefault();
      act(game.id, request<SceneData>("POST", `api/games/${game.id}/scenes`, { name: name.input.value }), (created) => {
        void load(game.id, created.id);
      });
    });
    element.append(list, create);
    return element;
  }

  function playerSection(game: GameInfo): HTMLElement {
    const element = section("game.scene", "scenes");
    const scene = game.scenes[0];
    if (scene) {
      const name = document.createElement("p");
      name.textContent = scene.name;
      element.append(name);
    } else {
      element.append(labelled("p", "game.noScene", "muted"));
    }
    element.append(labelled("p", "game.playerHint", "muted"));
    return element;
  }

  function memberRow(game: GameInfo, member: MemberInfo): HTMLLIElement {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = member.displayName;
    const mark = labelled("span", "game.online", "online");
    onlineMarks.set(member.id, { name: member.displayName, mark });
    const role = document.createElement("span");
    role.className = "muted";
    role.append(labelled("span", member.role === "gm" ? "games.role.gm" : "games.role.player"));
    if (member.id === game.ownerId) role.append(", ", labelled("span", "games.owner"));
    item.append(name, mark, role);
    if (!game.editor || member.role === "gm") return item;

    const params = { name: member.displayName };
    item.append(
      button("game.makeMaster", () => {
        if (!confirm(t("game.confirmMakeMaster", params))) return;
        // The editor may lose the right to change scenes: the board is read again.
        act(game.id, request("POST", `api/games/${game.id}/master`, { userId: member.id }), () => void load(game.id, shownScene));
      }),
    );
    if (member.id !== game.ownerId) {
      item.append(
        button("game.remove", () => {
          if (!confirm(t("game.confirmRemove", params))) return;
          act(game.id, request("DELETE", `api/games/${game.id}/members/${member.id}`), () => refreshInfo(game.id));
        }),
      );
    }
    return item;
  }

  /** Shows "online" at the members with an open stream, and their names in the top bar. */
  function markOnline(): void {
    const names: string[] = [];
    for (const [id, { name, mark }] of onlineMarks) {
      mark.hidden = !online.has(id);
      if (online.has(id)) names.push(name);
    }
    onlineList.hidden = names.length === 0;
    onlineList.textContent = names.join(", ");
    onlineList.title = onlineList.textContent;
  }

  function membersSection(game: GameInfo): HTMLElement {
    const element = section("game.members", "members");
    const list = document.createElement("ul");
    list.className = "member-list";
    list.append(...game.members.map((member) => memberRow(game, member)));
    element.append(list);
    return element;
  }

  /**
   * The invite window, opened by "Invite" in the top bar (plan 8.26, R45). An invite code for some joins within some
   * days, like a registration code; shown only once, the server keeps its hash. With it the QR code and the links on
   * the addresses of the computer (invite.ts). The last invite stays in the window while friends scan it. Laid out
   * after InviteCard of variant V: the QR code beside three steps, the limits, a note for an administrator, and
   * «New code» and «Done» at the bottom.
   */
  function openInvite(): void {
    const game = info;
    if (!game?.editor) return;
    const header = document.createElement("div");
    header.className = "drawer-header";
    header.append(labelled("h2", "game.inviteTitle"), iconButton("close", "common.close", () => invite.close()));
    const about = document.createElement("p");
    about.className = "muted";
    about.append(game.title, " · ", labelled("span", game.kind === "gm" ? "games.kind.gm" : "games.kind.personal"));

    // The QR code beside the three steps (InviteCard of variant V); before the first invite, the steps alone.
    const qrRow = document.createElement("div");
    qrRow.className = "invite-qr-row";
    const qrSlot = document.createElement("div");
    qrSlot.className = "invite-qr";
    const steps = document.createElement("ol");
    steps.className = "invite-steps";
    steps.append(labelled("li", "game.inviteStep1"), labelled("li", "game.inviteStep2"), labelled("li", "game.inviteStep3"));
    qrRow.append(qrSlot, steps);
    const details = document.createElement("div");
    details.setAttribute("aria-live", "polite");

    const form = document.createElement("form");
    form.className = "invite-form";
    const uses = field("game.inviteUses", { type: "number", value: String(INVITE_USES), min: 1, max: INVITE_MAX_USES });
    const days = field("game.inviteDays", { type: "number", value: String(INVITE_DAYS), min: 1, max: INVITE_MAX_DAYS });
    const limits = document.createElement("div");
    limits.className = "invite-limits";
    limits.append(uses.wrap, days.wrap);
    form.append(limits);
    // Only an administrator's invite also registers a newcomer (R43): the others would be told something untrue.
    if (hooks.isAdmin()) form.append(labelled("p", "game.inviteAdminNote", "invite-note"));
    const submit = document.createElement("button");
    submit.type = "submit";
    const done = labelled("button", "game.inviteDone", "primary");
    done.type = "button";
    done.addEventListener("click", () => invite.close());
    const buttons = document.createElement("div");
    buttons.className = "invite-buttons";
    buttons.append(submit, done);
    form.append(buttons);

    /** Shows the invite made last, or the steps alone; the submit button makes the first invite or a new one. */
    const showInvite = (): void => {
      qrSlot.replaceChildren(...(shownInvite ? [shownInvite.qr] : []));
      qrSlot.hidden = shownInvite === null;
      details.replaceChildren(...(shownInvite ? [shownInvite.details] : []));
      setKey(submit, shownInvite ? "game.inviteNew" : "game.createInvite");
      submit.className = shownInvite ? "" : "primary";
      done.hidden = shownInvite === null;
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const reply = request<GameInvite>("POST", `api/games/${game.id}/invites`, {
        maxUses: Number(uses.input.value),
        days: Number(days.input.value),
      });
      act(game.id, reply, (created) => {
        shownInvite = inviteView(created);
        showInvite();
      });
    });
    showInvite();
    invite.replaceChildren(header, about, qrRow, details, form);
    invite.showModal();
  }

  // ---- opening and closing ----

  function open(gameId: number): void {
    close();
    openId = gameId;
    // Kept in the address, so a reload opens the game again.
    history.replaceState(null, "", `${location.pathname}${location.search}#game=${gameId}`);
    document.body.classList.add("in-game");
    render();
    refreshInfo(gameId);
    // The first event of the stream is the snapshot of the scene to show.
    connect(gameId);
  }

  function close(): void {
    if (openId === null) return;
    openId = null;
    info = null;
    shownScene = null;
    live = null;
    stream?.close();
    stream = null;
    clearTimeout(retryTimer);
    clearTimeout(drainTimer);
    drainTimer = undefined;
    queue.length = 0;
    online = new Set();
    roundTrips = new RoundTrips();
    shownInvite = null;
    hooks.measured(null);
    connection.hidden = true;
    loadCount++;
    closeDrawer();
    invite.close();
    panel.replaceChildren();
    renderTopBar(null);
    onlineMarks.clear();
    markOnline();
    document.body.classList.remove("in-game");
    if (GAME_HASH.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    void whenIdle().then(() => {
      if (openId === null) hooks.board.showDraft();
    });
  }

  return {
    open,
    close,
    reopen() {
      const match = GAME_HASH.exec(location.hash);
      if (!match || Number(match[1]) === openId) return false;
      open(Number(match[1]));
      return true;
    },
  };
}
