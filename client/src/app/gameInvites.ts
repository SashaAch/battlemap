// The active invites of a game in its drawer, for the editor (R52): uses left, until when, who made each; the code
// itself is never shown (the server keeps only its hash). «Revoke» asks first, then the list is read again.
// User text (the creator's name) goes only through textContent.

import { getLang, t } from "../i18n/index.ts";
import { request } from "./api.ts";
import type { ActiveGameInvite } from "./api.ts";
import { button, labelled } from "./login.ts";

export interface GameInvitesSection {
  element: HTMLElement;
  /** Reads the list again, after a new invite for one. */
  reload(): void;
}

/**
 * The section of the drawer with the invites of game `gameId`. `run` runs a request of the panel and calls `next`
 * with its answer while the game is still open, and reports a failure as the rest of the panel does.
 */
export function gameInvitesSection(gameId: number, run: <T>(action: Promise<T>, next: (result: T) => void) => void): GameInvitesSection {
  const element = document.createElement("section");
  element.dataset.part = "invites";
  const list = document.createElement("ul");
  list.className = "invite-list";
  const none = labelled("p", "game.invitesNone", "muted");
  none.hidden = true;
  element.append(labelled("h3", "game.invites"), none, list);
  /** Only the answer to the latest read is shown. */
  let reads = 0;

  const row = (invite: ActiveGameInvite): HTMLLIElement => {
    const item = document.createElement("li");
    const text = document.createElement("span");
    const until = new Date(invite.expiresAt).toLocaleString(getLang());
    text.textContent = t("game.inviteRow", { uses: invite.usesLeft, until, name: invite.creatorName });
    item.append(
      text,
      button(
        "game.revokeInvite",
        () => {
          if (!confirm(t("game.confirmRevokeInvite", { name: invite.creatorName }))) return;
          // Read again also when it was already gone: the list was out of date.
          run(request<void>("DELETE", `api/games/${gameId}/invites/${invite.id}`).finally(reload), () => undefined);
        },
        "small",
      ),
    );
    return item;
  };

  function reload(): void {
    const mine = ++reads;
    run(request<{ invites: ActiveGameInvite[] }>("GET", `api/games/${gameId}/invites`), ({ invites }) => {
      if (mine !== reads) return;
      none.hidden = invites.length > 0;
      list.replaceChildren(...invites.map(row));
    });
  }

  reload();
  return { element, reload };
}
