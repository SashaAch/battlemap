// A game on the board (plan 5.3, 5.4, 5.11, 8.5): the board shows a scene from the server, and the game panel
// shows the scenes, the members and the invites. The editor (the master, or the owner of a personal campaign
// without one) draws with the usual tools and every finished change goes to the server; a player only looks.
// Others see the changes after they read the scene again (live changes are stage 6).
// User text (titles, scene names, member names) goes only through textContent.

import { newScene, parseScene, SceneError } from "../board/store.ts";
import type { Patch, Scene } from "../board/store.ts";
import { getLang, t } from "../i18n/index.ts";
import type { Key } from "../i18n/index.ts";
import { secretLine } from "./admin.ts";
import { request } from "./api.ts";
import type { GameInfo, MemberInfo, SceneData, SceneSummary } from "./api.ts";
import { button, codeOf, errorKey, field, labelled } from "./login.ts";

/** What the game needs from the board (main.ts). */
export interface GameBoard {
  /** Shows a game scene instead of the draft; `changed` gets every finished change, null makes the board read-only. */
  show(scene: Scene, changed: ((patch: Patch) => void) | null): void;
  /** Back to the draft kept in the browser. */
  showDraft(): void;
  /** A stroke or a drag is under way: the scene must not be replaced now. */
  busy(): boolean;
}

export interface GameHooks {
  board: GameBoard;
  showNotice(key: Key, params?: Record<string, string | number>): void;
  /** An ended session: back to sign-in. */
  failed(error: unknown): void;
  /** Opens the "my games" screen. */
  showGames(): void;
}

export interface GameView {
  open(gameId: number): void;
  /** Back to the draft; nothing when no game is open. */
  close(): void;
  /** After a reload: opens the game named in the address (#game=ID), if any. */
  reopen(): void;
}

const GAME_HASH = /^#game=([1-9][0-9]{0,14})$/;
const IDLE_CHECK_MS = 100;
/** The defaults and bounds of a registration code (admin.ts, server/auth.ts), which a game invite follows (R41). */
const INVITE_USES = 1;
const INVITE_MAX_USES = 1000;
const INVITE_DAYS = 7;
const INVITE_MAX_DAYS = 365;

export function startGame(hooks: GameHooks): GameView {
  const panel = document.createElement("aside");
  panel.className = "game-panel";
  panel.hidden = true;
  document.body.append(panel);

  /** The open game, null on the draft. */
  let openId: number | null = null;
  let info: GameInfo | null = null;
  /** The scene on the board (or being read), null when there is none to show. */
  let shownScene: number | null = null;
  /** Changes go to the server one after another, in the order they were made. */
  let patches: Promise<void> = Promise.resolve();
  let changeCount = 0;
  /** Only the latest read of the game is shown. */
  let loadCount = 0;

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

  /** A failed request about the open game. A game that is gone (deleted, or the user removed) closes. */
  function failed(error: unknown, gameId: number): void {
    if (openId !== gameId) return;
    const code = codeOf(error);
    if (code === "auth.required" || code === "auth.mustChangePassword") {
      hooks.failed(error);
    } else if (code === "game.notFound") {
      close();
      hooks.showNotice("notice.gameGone");
      hooks.showGames();
    } else {
      hooks.showNotice(errorKey(code));
    }
  }

  function send(gameId: number, sceneId: number, patch: Patch): void {
    if (patch.length === 0) return;
    changeCount++;
    patches = patches.then(() =>
      request("POST", `api/games/${gameId}/scenes/${sceneId}/patch`, { patch }).then(
        () => undefined,
        (error: unknown) => {
          if (openId !== gameId) return;
          if (codeOf(error) === "auth.required") {
            hooks.failed(error);
            return;
          }
          // The board no longer matches the server: say why and read the scene again.
          hooks.showNotice("notice.changeRejected", { reason: t(errorKey(codeOf(error))) });
          void load(gameId, sceneId);
        },
      ),
    );
  }

  /**
   * Reads the game and shows the scene `preferred` if the user may see it, else the current one (an editor
   * without a current scene gets the first). It waits for strokes and sent changes to end, and reads again
   * if a change was made while it read, so the board never drops a change of its own.
   */
  async function load(gameId: number, preferred: number | null): Promise<void> {
    const mine = ++loadCount;
    const current = (): boolean => mine === loadCount && openId === gameId;
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
      shownScene = data?.id ?? null;
      render();
      showScene(game, data);
      return;
    }
  }

  function showScene(game: GameInfo, data: SceneData | null): void {
    let scene = newScene();
    if (data) {
      try {
        scene = parseScene(data.scene);
      } catch (error) {
        if (!(error instanceof SceneError)) throw error;
        hooks.showNotice(error.code === "version" ? "notice.sceneNewer" : "notice.sceneBroken");
        hooks.board.show(scene, null);
        return;
      }
    }
    const sceneId = data?.id;
    hooks.board.show(scene, game.editor && sceneId !== undefined ? (patch) => send(game.id, sceneId, patch) : null);
  }

  /** Reads the game again for the panel only; the board and its undo history stay. */
  function refreshInfo(gameId: number): void {
    request<GameInfo>("GET", `api/games/${gameId}`).then((game) => {
      if (openId !== gameId) return;
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

  function render(): void {
    const top = document.createElement("div");
    top.className = "actions";
    top.append(
      button("account.games", hooks.showGames),
      button("game.close", close),
      button("game.reload", () => {
        if (openId !== null) void load(openId, shownScene);
      }),
    );
    panel.replaceChildren(top);
    const game = info;
    if (!game) return;
    const title = document.createElement("h2");
    title.textContent = game.title;
    panel.append(title, labelled("p", game.kind === "gm" ? "games.kind.gm" : "games.kind.personal", "muted"));
    panel.append(game.editor ? scenesSection(game) : playerSection(game), membersSection(game));
    if (game.editor) panel.append(inviteSection(game));
    const actions = document.createElement("div");
    actions.className = "actions";
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
    if (game.canDelete) {
      actions.append(
        button("game.delete", () => {
          if (!confirm(t("game.confirmDelete", { title: game.title }))) return;
          act(game.id, request("DELETE", `api/games/${game.id}`), () => {
            close();
            hooks.showGames();
          });
        }),
      );
    }
    if (actions.childElementCount > 0) panel.append(actions);
  }

  function section(titleKey: Key): HTMLElement {
    const element = document.createElement("section");
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

    const currentMark = scene.active
      ? labelled("span", "game.sceneCurrent", "badge")
      : button("game.makeCurrent", () => act(game.id, request("POST", `${path}/activate`), () => refreshInfo(game.id)));

    const visibleWrap = document.createElement("label");
    visibleWrap.className = "check";
    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = scene.visible;
    visible.addEventListener("change", () => {
      const change = request("PUT", path, { visible: visible.checked }).catch((error: unknown) => {
        visible.checked = scene.visible;
        throw error;
      });
      act(game.id, change, () => refreshInfo(game.id));
    });
    visibleWrap.append(visible, labelled("span", "game.visible"));

    const rename = button("game.rename", () => {
      const next = prompt(t("game.renamePrompt"), scene.name);
      if (next === null) return;
      act(game.id, request("PUT", path, { name: next }), () => refreshInfo(game.id));
    });
    item.append(name, currentMark, visibleWrap, rename);
    return item;
  }

  function scenesSection(game: GameInfo): HTMLElement {
    const element = section("game.scenes");
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
    const element = section("game.scene");
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
    const role = document.createElement("span");
    role.className = "muted";
    role.append(labelled("span", member.role === "gm" ? "games.role.gm" : "games.role.player"));
    if (member.id === game.ownerId) role.append(", ", labelled("span", "games.owner"));
    item.append(name, role);
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

  function membersSection(game: GameInfo): HTMLElement {
    const element = section("game.members");
    const list = document.createElement("ul");
    list.className = "member-list";
    list.append(...game.members.map((member) => memberRow(game, member)));
    element.append(list);
    return element;
  }

  /** An invite code for some joins within some days, like a registration code; shown only once, the server keeps its hash. */
  function inviteSection(game: GameInfo): HTMLElement {
    const element = section("game.invite");
    const form = document.createElement("form");
    form.className = "inline-form";
    const uses = field("game.inviteUses", { type: "number", value: String(INVITE_USES), min: 1, max: INVITE_MAX_USES });
    const days = field("game.inviteDays", { type: "number", value: String(INVITE_DAYS), min: 1, max: INVITE_MAX_DAYS });
    const submit = labelled("button", "game.createInvite", "primary");
    submit.type = "submit";
    form.append(uses.wrap, days.wrap, submit);
    const result = document.createElement("div");
    result.setAttribute("aria-live", "polite");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const reply = request<{ code: string; expiresAt: number; maxUses: number }>("POST", `api/games/${game.id}/invites`, {
        maxUses: Number(uses.input.value),
        days: Number(days.input.value),
      });
      act(game.id, reply, ({ code, expiresAt, maxUses }) => {
        const link = `${location.origin}${location.pathname}#join=${code}`;
        const until = new Date(expiresAt).toLocaleString(getLang());
        result.replaceChildren(secretLine("game.inviteCode", { uses: String(maxUses), until }, code), secretLine("game.inviteLink", {}, link));
      });
    });
    element.append(form, result);
    return element;
  }

  // ---- opening and closing ----

  function open(gameId: number): void {
    openId = gameId;
    info = null;
    shownScene = null;
    // Kept in the address, so a reload opens the game again.
    history.replaceState(null, "", `${location.pathname}${location.search}#game=${gameId}`);
    panel.hidden = false;
    render();
    void load(gameId, null);
  }

  function close(): void {
    if (openId === null) return;
    openId = null;
    info = null;
    shownScene = null;
    loadCount++;
    panel.hidden = true;
    panel.replaceChildren();
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
      if (match && openId === null) open(Number(match[1]));
    },
  };
}
