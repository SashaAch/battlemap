// The account part of the page (plan 5.3, 8.4): the mode at start-up, the sign-in, registration and password
// screens, and the account controls in the toolbar. User text (names, logins) goes only through textContent.

import { isKey, t } from "../i18n/index.ts";
import type { Key } from "../i18n/index.ts";
import { ApiFailure, detectMode, request } from "./api.ts";
import type { AccountSettings, Me, Registered } from "./api.ts";

export interface AccountHooks {
  /** Applies the language and theme kept in the account. */
  applySettings(settings: AccountSettings): void;
  showNotice(key: Key): void;
  /** Fills `screen` with the administration screen (admin.ts). */
  showAdmin(screen: HTMLElement, me: Me, actions: ScreenActions): void;
  /** Fills `screen` with "my games" (games.ts); `joinCode` comes from an invite link. */
  showGames(screen: HTMLElement, actions: ScreenActions, joinCode: string): void;
  /** A user is signed in and may use the site (no password to replace). */
  signedIn(): void;
  /** The address changed in the open tab: opens the game it names (#game=ID) unless it is open; true when it did. */
  gameLink(): boolean;
  /** Opens a game the user just became a player of by registering with an administrator's invite (R43). */
  openGame(gameId: number): void;
  /** Nobody is signed in any more. */
  signedOut(): void;
}

export interface ScreenActions {
  close(): void;
  /** A failure that ends the screen, such as an ended session. */
  failed(error: unknown): void;
}

export interface Account {
  /** Keeps a language or theme change in the account; does nothing without a signed-in user. */
  saveSettings(change: AccountSettings): void;
  /** A failed request outside a form: an ended session goes back to sign-in, anything else is a notice. */
  failed(error: unknown): void;
  showGames(): void;
}

// ---- small DOM helpers, shared with admin.ts ----

/** An element whose text is the dictionary string `key`, kept up to date when the language changes. */
export function labelled<K extends keyof HTMLElementTagNameMap>(tag: K, key: Key, className = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  setKey(element, key);
  if (className) element.className = className;
  return element;
}

export function setKey(element: HTMLElement, key: Key): void {
  element.dataset.i18n = key;
  element.textContent = t(key);
}

export function button(key: Key, onPress: () => void, className = ""): HTMLButtonElement {
  const element = labelled("button", key, className);
  element.type = "button";
  element.addEventListener("click", onPress);
  return element;
}

/** Input attributes the forms use; every input is required. */
interface InputOptions {
  type?: "text" | "password" | "number";
  name?: string;
  autocomplete?: AutoFill;
  value?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Logins are lowercase: phones should not capitalise the first letter. */
  noCapitals?: boolean;
}

/** A labelled input; `hint` is a line under it. */
export function field(labelKey: Key, options: InputOptions, hint?: Key): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const element = document.createElement("input");
  element.required = true;
  element.type = options.type ?? "text";
  if (options.name) element.name = options.name;
  if (options.autocomplete) element.autocomplete = options.autocomplete;
  if (options.value) element.value = options.value;
  if (options.maxLength) element.maxLength = options.maxLength;
  if (options.min !== undefined) element.min = String(options.min);
  if (options.max !== undefined) element.max = String(options.max);
  if (options.noCapitals) element.autocapitalize = "none";
  wrap.append(labelled("span", labelKey), element);
  if (hint) wrap.append(labelled("small", hint, "hint"));
  return { wrap, input: element };
}

/** The dictionary key for an error code; unknown codes get a general text. */
export function errorKey(code: string): Key {
  const key = `error.${code}`;
  return isKey(key) ? key : "error.unknown";
}

/** A line for form errors, hidden until `show` is called. */
export function errorLine(): { element: HTMLParagraphElement; show(code: string): void; hide(): void } {
  const element = document.createElement("p");
  element.className = "form-error";
  element.setAttribute("role", "alert");
  element.hidden = true;
  return {
    element,
    show(code) {
      setKey(element, errorKey(code));
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
    },
  };
}

export function codeOf(error: unknown): string {
  return error instanceof ApiFailure ? error.code : "unknown";
}

// ---- the account ----

/**
 * A link with a secret in the address: the first administrator (`#setup=`), a registration code (`#register=`)
 * or a game invite (`#join=`). `#game=` is not one: it stays in the address (game.ts).
 */
interface SecretLink {
  kind: "setup" | "register" | "join";
  value: string;
}

const SECRET_LINK = /^#(setup|register|join)=([A-Za-z0-9_-]+)$/;

/** Reads and removes a secret link from the address, so a one-time secret does not stay in the history. */
function takeSecretLink(): SecretLink | null {
  const match = SECRET_LINK.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return { kind: match[1] as SecretLink["kind"], value: match[2] };
}

export function startAccount(hooks: AccountHooks): Account {
  const toolbar = document.querySelector<HTMLElement>(".toolbar");
  if (!toolbar) throw new Error("the toolbar is missing");

  const screen = document.createElement("main");
  screen.className = "screen";
  screen.hidden = true;
  document.body.append(screen);

  const bar = document.createElement("div");
  bar.className = "group account";
  bar.hidden = true;
  const name = document.createElement("span");
  name.className = "account-name";
  const passwordButton = button("account.password", () => showPassword(false));
  const adminButton = button("account.admin", () => {
    if (me) hooks.showAdmin(open(), me, { close: closeScreen, failed });
  });
  const gamesButton = button("account.games", () => showGames(""));
  const logoutButton = button("account.logout", () => {
    request("POST", "api/auth/logout").then(restart, failed);
  });
  bar.append(name, gamesButton, passwordButton, adminButton, logoutButton);
  toolbar.append(bar);

  let me: Me | null = null;
  let openRegistration = false;
  /** Whether the server has said who is signed in; a link that comes before waits in `pending`. */
  let started = false;
  let pending = takeSecretLink();
  /** A game invite code from a link, put in "my games" once the user is signed in. */
  let joinCode: string | null = null;

  function open(): HTMLElement {
    screen.replaceChildren();
    screen.hidden = false;
    return screen;
  }

  function closeScreen(): void {
    screen.replaceChildren();
    screen.hidden = true;
  }

  function showGames(code: string): void {
    if (me && !me.mustChangePassword) hooks.showGames(open(), { close: closeScreen, failed }, code);
  }

  function signedIn(user: Me): void {
    me = user;
    name.textContent = user.displayName;
    name.title = user.login;
    adminButton.hidden = user.role !== "admin" || user.mustChangePassword;
    gamesButton.hidden = user.mustChangePassword;
    passwordButton.hidden = user.mustChangePassword;
    bar.hidden = false;
    hooks.applySettings(user.settings);
    if (user.mustChangePassword) {
      showPassword(true);
      return;
    }
    if (joinCode) {
      showGames(joinCode);
      joinCode = null;
    } else {
      closeScreen();
    }
    hooks.signedIn();
  }

  function signedOut(registration: boolean): void {
    me = null;
    openRegistration = registration;
    bar.hidden = true;
    hooks.signedOut();
    showSignIn();
  }

  /** Asks the server again who is signed in; used after sign-out and when a session ends. */
  function restart(): void {
    void detectMode().then((mode) => {
      if (mode.kind === "signedIn") signedIn(mode.me);
      else if (mode.kind === "signedOut") signedOut(mode.openRegistration);
      else {
        me = null;
        bar.hidden = true;
        hooks.signedOut();
        closeScreen();
      }
    });
  }

  /** A failed request outside a form: an ended session goes back to sign-in, anything else is a notice. */
  function failed(error: unknown): void {
    if (codeOf(error) === "auth.required" || codeOf(error) === "auth.mustChangePassword") restart();
    else hooks.showNotice(codeOf(error) === "network" ? "notice.serverUnreachable" : "notice.requestFailed");
  }

  /** Wires a form: while the request runs its buttons are off; an error shows under the fields. */
  function submitting(form: HTMLFormElement, errors: ReturnType<typeof errorLine>, send: () => Promise<void> | null): void {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      errors.hide();
      const sending = send();
      if (!sending) return;
      const buttons = [...form.querySelectorAll("button")];
      for (const element of buttons) element.disabled = true;
      sending
        .catch((error: unknown) => {
          if (codeOf(error) === "auth.required" && me) restart();
          else errors.show(codeOf(error));
        })
        .finally(() => {
          for (const element of buttons) element.disabled = false;
        });
    });
  }

  function card(titleKey: Key): { form: HTMLFormElement; errors: ReturnType<typeof errorLine> } {
    const form = document.createElement("form");
    form.className = "card";
    const errors = errorLine();
    form.append(labelled("h2", titleKey));
    open().append(form);
    return { form, errors };
  }

  function showSignIn(): void {
    const { form, errors } = card("signIn.title");
    const login = field("account.login", { name: "login", autocomplete: "username", noCapitals: true });
    const password = field("account.password.current", { name: "password", type: "password", autocomplete: "current-password" });
    const actions = document.createElement("div");
    actions.className = "actions";
    const submit = labelled("button", "signIn.submit", "primary");
    submit.type = "submit";
    // From an invite link, the registration form keeps its code.
    actions.append(submit, button("signIn.toRegister", () => showRegister(null, joinCode ?? "", joinCode !== null)));
    form.append(login.wrap, password.wrap, errors.element, actions);
    submitting(form, errors, () =>
      request<Me>("POST", "api/auth/login", { login: login.input.value, password: password.input.value }).then(signedIn),
    );
    login.input.focus();
  }

  /**
   * Registration by code, open registration, or the first administrator with the setup token. `invited`: opened by
   * a game invite link; with an administrator's invite the new user is a player of the game at once (R43).
   */
  function showRegister(setup: string | null, code = "", invited = false): void {
    const { form, errors } = card(setup ? "register.setupTitle" : "register.title");
    if (setup) form.append(labelled("p", "register.setupNote", "form-note"));
    if (invited) form.append(labelled("p", openRegistration ? "register.inviteNoteOpen" : "register.inviteNote", "form-note"));
    const login = field("account.login", { name: "login", autocomplete: "username", noCapitals: true }, "account.loginHint");
    const displayName = field("account.displayName", { name: "displayName", maxLength: 40 });
    const password = field("account.password.new", { name: "password", type: "password", autocomplete: "new-password" }, "account.passwordHint");
    const repeat = field("account.password.repeat", { type: "password", autocomplete: "new-password" });
    form.append(login.wrap, displayName.wrap, password.wrap, repeat.wrap);
    const needsCode = !setup && !openRegistration;
    const invite = field("register.code", { name: "code", value: code, autocomplete: "off", noCapitals: true });
    if (needsCode) form.append(invite.wrap);

    const actions = document.createElement("div");
    actions.className = "actions";
    const submit = labelled("button", "register.submit", "primary");
    submit.type = "submit";
    actions.append(submit);
    if (!setup) actions.append(button("register.toSignIn", showSignIn));
    form.append(errors.element, actions);

    submitting(form, errors, () => {
      if (password.input.value !== repeat.input.value) {
        errors.show("passwordMismatch");
        return null;
      }
      const body: Record<string, string> = {
        login: login.input.value,
        displayName: displayName.input.value,
        password: password.input.value,
      };
      if (setup) body.setup = setup;
      else if (needsCode) body.code = invite.input.value.trim();
      return request<Registered>("POST", "api/auth/register", body).then((user) => {
        // An administrator's invite made the user a player: straight into its game, no join button.
        if (user.gameId !== null) joinCode = null;
        signedIn(user);
        if (user.gameId !== null) hooks.openGame(user.gameId);
      });
    });
    login.input.focus();
  }

  /** `forced`: the password was reset by an administrator, nothing else is open until it is changed. */
  function showPassword(forced: boolean): void {
    const { form, errors } = card("password.title");
    if (forced) form.append(labelled("p", "password.forcedNote", "form-note"));
    const current = field("account.password.current", { type: "password", autocomplete: "current-password" });
    const next = field("account.password.new", { type: "password", autocomplete: "new-password" }, "account.passwordHint");
    const repeat = field("account.password.repeat", { type: "password", autocomplete: "new-password" });
    const actions = document.createElement("div");
    actions.className = "actions";
    const submit = labelled("button", "password.submit", "primary");
    submit.type = "submit";
    actions.append(submit);
    if (!forced) actions.append(button("common.cancel", closeScreen));
    form.append(current.wrap, next.wrap, repeat.wrap, errors.element, actions);
    submitting(form, errors, () => {
      if (next.input.value !== repeat.input.value) {
        errors.show("passwordMismatch");
        return null;
      }
      return request<Me>("POST", "api/me/password", { currentPassword: current.input.value, newPassword: next.input.value }).then(
        (user) => {
          signedIn(user);
          hooks.showNotice("notice.passwordChanged");
        },
      );
    });
    current.input.focus();
  }

  /**
   * Acts on a secret link once the server has said who is signed in. Signed out: the setup or registration form,
   * or for a game invite the registration form with the code (sign-in is a button away); nothing, the sign-in form.
   * Signed in: a game invite goes to "my games", after a forced password change if there is one.
   */
  function follow(link: SecretLink | null): void {
    if (me) {
      if (link?.kind !== "join") return;
      joinCode = link.value;
      if (!me.mustChangePassword) {
        showGames(joinCode);
        joinCode = null;
      }
      return;
    }
    if (link?.kind === "setup") showRegister(link.value);
    else if (link?.kind === "register") showRegister(null, link.value);
    else if (link?.kind === "join") {
      joinCode = link.value;
      showRegister(null, link.value, true);
    } else showSignIn();
  }

  void detectMode().then((mode) => {
    // The draft without a server has no accounts; its links are dropped.
    if (mode.kind === "draft") return;
    started = true;
    const link = pending;
    pending = null;
    if (mode.kind === "signedIn") {
      if (link?.kind === "join") joinCode = link.value;
      signedIn(mode.me);
    } else {
      openRegistration = mode.openRegistration;
      follow(link);
    }
  });

  // Links opened in this tab while it is open (plan 8.26): the page is not loaded again.
  window.addEventListener("hashchange", () => {
    const link = takeSecretLink();
    if (!started) {
      if (link) pending = link;
    } else if (link) {
      follow(link);
    } else if (me && !me.mustChangePassword && hooks.gameLink()) {
      closeScreen();
    }
  });

  return {
    failed,
    showGames: () => showGames(""),
    saveSettings(change) {
      if (!me || me.mustChangePassword) return;
      request("PUT", "api/me/settings", change).catch((error: unknown) => {
        if (codeOf(error) === "auth.required") restart();
        else hooks.showNotice("notice.settingsNotSaved");
      });
    },
  };
}
