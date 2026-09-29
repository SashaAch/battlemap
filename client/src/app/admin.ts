// The administration screen (plan 8.4 item 5): users, temporary passwords, disabling, registration codes,
// open registration, the active codes with their revoking (R50). User text goes only through textContent.

import { getLang, t } from "../i18n/index.ts";
import type { Key } from "../i18n/index.ts";
import { request } from "./api.ts";
import type { AdminInvite, Me, UserInfo } from "./api.ts";
import { button, codeOf, errorLine, field, labelled } from "./login.ts";

export interface AdminActions {
  close(): void;
  /** A failure that ends the screen, such as an ended session. */
  failed(error: unknown): void;
}

function stateKey(user: UserInfo): Key {
  if (user.disabled) return "admin.state.disabled";
  if (user.mustChangePassword) return "admin.state.mustChange";
  return "admin.state.active";
}

/** A result line: the text for `key` with `params`, then the secret in a <code> that is easy to copy. */
export function secretLine(key: Key, params: Record<string, string>, secret: string): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = "form-note";
  const code = document.createElement("code");
  code.className = "secret";
  code.textContent = secret;
  line.append(t(key, params), " ", code);
  return line;
}

export function showAdmin(screen: HTMLElement, me: Me, actions: AdminActions): void {
  const panel = document.createElement("section");
  panel.className = "card wide";
  const header = document.createElement("div");
  header.className = "card-header";
  header.append(labelled("h2", "admin.title"), button("common.close", actions.close));
  const errors = errorLine();
  const result = document.createElement("div");
  result.setAttribute("aria-live", "polite");

  /** Runs an action; a session problem closes the screen, other errors show at the top. */
  const run = (action: Promise<void>): void => {
    errors.hide();
    action.catch((error: unknown) => {
      const code = codeOf(error);
      if (code === "auth.required" || code === "auth.forbidden" || code === "auth.mustChangePassword") actions.failed(error);
      else errors.show(code);
    });
  };

  // ---- users ----

  const table = document.createElement("table");
  table.className = "admin-table";
  const head = document.createElement("tr");
  for (const key of ["account.login", "account.displayName", "admin.role", "admin.state", "admin.actions"] as const) {
    head.append(labelled("th", key));
  }
  const body = document.createElement("tbody");
  table.createTHead().append(head);
  table.append(body);

  const showUsers = (users: UserInfo[]): void => {
    body.replaceChildren(
      ...users.map((user) => {
        const row = document.createElement("tr");
        const cells = [user.login, user.displayName].map((text) => {
          const cell = document.createElement("td");
          cell.textContent = text;
          return cell;
        });
        const role = labelled("td", user.role === "admin" ? "admin.role.admin" : "admin.role.user");
        const state = labelled("td", stateKey(user));
        const buttons = document.createElement("td");
        buttons.className = "row-actions";
        if (user.id !== me.id) {
          buttons.append(
            button("admin.resetPassword", () => {
              if (!confirm(t("admin.confirmReset", { login: user.login }))) return;
              run(
                request<{ user: UserInfo; password: string }>("POST", "api/admin/users", { action: "resetPassword", id: user.id }).then(
                  (reply) => {
                    result.replaceChildren(secretLine("admin.temporaryPassword", { login: reply.user.login }, reply.password));
                    return loadUsers();
                  },
                ),
              );
            }),
            // Disabling a user and taking the role away delete their codes (R50), so the codes are read again too.
            button(user.disabled ? "admin.enable" : "admin.disable", () => {
              if (!user.disabled && !confirm(t("admin.confirmDisable", { login: user.login }))) return;
              run(
                request("POST", "api/admin/users", { action: "setDisabled", id: user.id, disabled: !user.disabled }).then(loadAll),
              );
            }),
            button(user.role === "admin" ? "admin.makeUser" : "admin.makeAdmin", () => {
              const next = user.role === "admin" ? "user" : "admin";
              if (!confirm(t(next === "admin" ? "admin.confirmMakeAdmin" : "admin.confirmMakeUser", { login: user.login }))) return;
              run(request("POST", "api/admin/users", { action: "setRole", id: user.id, role: next }).then(loadAll));
            }),
          );
        }
        row.append(...cells, role, state, buttons);
        return row;
      }),
    );
  };

  const loadUsers = (): Promise<void> => request<{ users: UserInfo[] }>("GET", "api/admin/users").then((reply) => showUsers(reply.users));

  // ---- active codes (R50): registration codes and game invites of all games, without the codes themselves ----

  const invitesTable = document.createElement("table");
  invitesTable.className = "admin-table";
  const invitesHead = document.createElement("tr");
  for (const key of ["admin.invites.kind", "admin.invites.creator", "admin.invites.game", "admin.invites.usesLeft", "admin.invites.until", "admin.actions"] as const) {
    invitesHead.append(labelled("th", key));
  }
  const invitesBody = document.createElement("tbody");
  invitesTable.createTHead().append(invitesHead);
  invitesTable.append(invitesBody);
  const invitesWrap = document.createElement("div");
  invitesWrap.className = "table-wrap";
  invitesWrap.append(invitesTable);
  const noInvites = labelled("p", "admin.invites.none", "muted");

  const revoke = (invite: AdminInvite): void => {
    const question =
      invite.kind === "game"
        ? t("admin.confirmRevokeGame", { game: invite.gameTitle ?? "", creator: invite.creatorName })
        : t("admin.confirmRevokeRegister", { creator: invite.creatorName });
    if (!confirm(question)) return;
    // Read again also when the code was already gone: the list was out of date.
    run(request<void>("DELETE", `api/admin/invites/${invite.id}`).finally(loadInvites));
  };

  const showInvites = (invites: AdminInvite[]): void => {
    invitesWrap.hidden = invites.length === 0;
    noInvites.hidden = invites.length > 0;
    invitesBody.replaceChildren(
      ...invites.map((invite) => {
        const row = document.createElement("tr");
        const kind = labelled("td", invite.kind === "game" ? "admin.invites.kind.game" : "admin.invites.kind.register");
        const cells = [invite.creatorName, invite.gameTitle ?? "", String(invite.usesLeft), new Date(invite.expiresAt).toLocaleString(getLang())].map(
          (text) => {
            const cell = document.createElement("td");
            cell.textContent = text;
            return cell;
          },
        );
        const buttons = document.createElement("td");
        buttons.className = "row-actions";
        buttons.append(button("admin.revoke", () => revoke(invite)));
        row.append(kind, ...cells, buttons);
        return row;
      }),
    );
  };

  const loadInvites = (): Promise<void> => request<{ invites: AdminInvite[] }>("GET", "api/admin/invites").then((reply) => showInvites(reply.invites));
  const loadAll = (): Promise<void> => Promise.all([loadUsers(), loadInvites()]).then(() => undefined);

  // ---- new user ----

  const create = document.createElement("form");
  create.className = "inline-form";
  const login = field("account.login", { autocomplete: "off", noCapitals: true }, "account.loginHint");
  const displayName = field("account.displayName", { autocomplete: "off", maxLength: 40 });
  const roleWrap = document.createElement("label");
  roleWrap.className = "field";
  const role = document.createElement("select");
  for (const value of ["user", "admin"] as const) {
    const option = labelled("option", value === "admin" ? "admin.role.admin" : "admin.role.user");
    option.value = value;
    role.append(option);
  }
  roleWrap.append(labelled("span", "admin.role"), role);
  const createButton = labelled("button", "admin.create", "primary");
  createButton.type = "submit";
  create.append(login.wrap, displayName.wrap, roleWrap, createButton);
  create.addEventListener("submit", (event) => {
    event.preventDefault();
    run(
      request<{ user: UserInfo; password: string }>("POST", "api/admin/users", {
        action: "create",
        login: login.input.value,
        displayName: displayName.input.value,
        role: role.value,
      }).then((reply) => {
        create.reset();
        result.replaceChildren(secretLine("admin.temporaryPassword", { login: reply.user.login }, reply.password));
        return loadUsers();
      }),
    );
  });

  // ---- registration ----

  const openWrap = document.createElement("label");
  openWrap.className = "check";
  const openBox = document.createElement("input");
  openBox.type = "checkbox";
  openWrap.append(openBox, labelled("span", "admin.openRegistration"));
  openBox.addEventListener("change", () => {
    const wanted = openBox.checked;
    run(
      request<{ openRegistration: boolean }>("PUT", "api/admin/settings", { openRegistration: wanted })
        .then((reply) => {
          openBox.checked = reply.openRegistration;
        })
        .catch((error: unknown) => {
          openBox.checked = !wanted;
          throw error;
        }),
    );
  });

  // A code for several registrations within some days (R38); it is shown only once, the server keeps its hash.
  const invite = document.createElement("form");
  invite.className = "inline-form";
  const uses = field("admin.inviteUses", { type: "number", value: "1", min: 1, max: 1000 });
  const days = field("admin.inviteDays", { type: "number", value: "7", min: 1, max: 365 });
  const inviteButton = labelled("button", "admin.createInvite", "primary");
  inviteButton.type = "submit";
  invite.append(uses.wrap, days.wrap, inviteButton);
  invite.addEventListener("submit", (event) => {
    event.preventDefault();
    run(
      request<{ code: string; expiresAt: number; maxUses: number }>("POST", "api/admin/invites", {
        maxUses: Number(uses.input.value),
        days: Number(days.input.value),
      }).then((reply) => {
        const link = `${location.origin}${location.pathname}#register=${reply.code}`;
        const until = new Date(reply.expiresAt).toLocaleString(getLang());
        result.replaceChildren(
          secretLine("admin.inviteCode", { uses: String(reply.maxUses), until }, reply.code),
          secretLine("admin.inviteLink", {}, link),
        );
        return loadInvites();
      }),
    );
  });

  const usersTitle = labelled("h3", "admin.users");
  const createTitle = labelled("h3", "admin.newUser");
  const registrationTitle = labelled("h3", "admin.registration");
  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";
  tableWrap.append(table);
  const invitesTitle = labelled("h3", "admin.invites");
  panel.append(header, errors.element, result, usersTitle, tableWrap, createTitle, create, registrationTitle, openWrap, invite, invitesTitle, noInvites, invitesWrap);
  screen.append(panel);

  run(loadUsers());
  run(loadInvites());
  run(
    request<{ openRegistration: boolean }>("GET", "api/admin/settings").then((reply) => {
      openBox.checked = reply.openRegistration;
    }),
  );
}
