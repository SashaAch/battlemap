// The "my games" screen (plan 5.11, 8.5): the user's games, a new game or personal campaign, joining by an
// invite code. User text (titles) goes only through textContent.

import type { Key } from "../i18n/index.ts";
import { request } from "./api.ts";
import type { GameInfo, GameKind, GameSummary } from "./api.ts";
import { button, codeOf, errorLine, field, labelled } from "./login.ts";

export interface GamesActions {
  close(): void;
  /** A failure that ends the screen, such as an ended session. */
  failed(error: unknown): void;
  openGame(gameId: number): void;
}

const KIND_KEYS: Record<GameKind, Key> = { gm: "games.kind.gm", personal: "games.kind.personal" };

/** "master", "player", and "owner" when the user owns the game. */
function roleText(game: GameSummary): HTMLSpanElement {
  const role = labelled("span", game.role === "gm" ? "games.role.gm" : "games.role.player", "muted");
  if (!game.isOwner) return role;
  const line = document.createElement("span");
  line.append(role, ", ", labelled("span", "games.owner", "muted"));
  return line;
}

/** `joinCode`: a code from an invite link, put in the join form. */
export function showGames(screen: HTMLElement, actions: GamesActions, joinCode = ""): void {
  const panel = document.createElement("section");
  panel.className = "card wide";
  const header = document.createElement("div");
  header.className = "card-header";
  header.append(labelled("h2", "games.title"), button("common.close", actions.close));
  const errors = errorLine();

  const run = (action: Promise<void>): void => {
    errors.hide();
    action.catch((error: unknown) => {
      if (codeOf(error) === "auth.required" || codeOf(error) === "auth.mustChangePassword") actions.failed(error);
      else errors.show(codeOf(error));
    });
  };

  // ---- the list ----

  const list = document.createElement("ul");
  list.className = "game-list";
  const empty = labelled("p", "games.empty", "form-note");
  empty.hidden = true;

  const showList = (games: GameSummary[]): void => {
    empty.hidden = games.length > 0;
    list.replaceChildren(
      ...games.map((game) => {
        const item = document.createElement("li");
        const title = document.createElement("strong");
        title.textContent = game.title;
        const about = document.createElement("span");
        about.className = "muted";
        about.append(labelled("span", KIND_KEYS[game.kind]), " · ", roleText(game));
        const text = document.createElement("div");
        text.className = "game-text";
        text.append(title, about);
        item.append(text, button("games.open", () => actions.openGame(game.id), "primary"));
        return item;
      }),
    );
  };

  // ---- a new game ----

  const create = document.createElement("form");
  create.className = "inline-form";
  const title = field("games.newTitle", { autocomplete: "off", maxLength: 40 });
  const kindWrap = document.createElement("label");
  kindWrap.className = "field";
  const kind = document.createElement("select");
  for (const value of ["gm", "personal"] as const) {
    const option = labelled("option", KIND_KEYS[value]);
    option.value = value;
    kind.append(option);
  }
  kindWrap.append(labelled("span", "games.newKind"), kind);
  const createButton = labelled("button", "games.create", "primary");
  createButton.type = "submit";
  create.append(title.wrap, kindWrap, createButton);
  create.addEventListener("submit", (event) => {
    event.preventDefault();
    run(request<GameInfo>("POST", "api/games", { title: title.input.value, kind: kind.value }).then((game) => actions.openGame(game.id)));
  });

  // ---- joining by a code ----

  const join = document.createElement("form");
  join.className = "inline-form";
  const code = field("games.joinCode", { autocomplete: "off", value: joinCode, noCapitals: true });
  const joinButton = labelled("button", "games.joinSubmit", "primary");
  joinButton.type = "submit";
  join.append(code.wrap, joinButton);
  join.addEventListener("submit", (event) => {
    event.preventDefault();
    // Codes are lowercase letters and digits; the path takes nothing else.
    const value = code.input.value.trim().toLowerCase();
    if (!/^[a-z0-9]{1,64}$/.test(value)) {
      errors.show("invite.notFound");
      return;
    }
    run(request<{ gameId: number }>("POST", `api/join/${value}`).then((reply) => actions.openGame(reply.gameId)));
  });

  panel.append(
    header,
    errors.element,
    empty,
    list,
    labelled("h3", "games.new"),
    create,
    labelled("h3", "games.join"),
    join,
  );
  screen.append(panel);
  run(request<{ games: GameSummary[] }>("GET", "api/games").then((reply) => showList(reply.games)));
  (joinCode ? code : title).input.focus();
}
