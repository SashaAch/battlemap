// The menu of the top bar (R45): language, theme and its colours, and the account. It opens under its button and
// closes on a second press, a press outside it, Escape, or an account action.

import { icon } from "../ui/icons.ts";

export function startMenu(button: HTMLButtonElement, menu: HTMLElement, account: HTMLElement): void {
  button.append(icon("menu", 18));

  const setOpen = (open: boolean): void => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };

  button.addEventListener("click", () => setOpen(menu.hidden === true));
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && event.target instanceof Node && !menu.contains(event.target) && !button.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hidden) return;
    setOpen(false);
    button.focus();
  });
  // An account action opens a screen or signs out: the menu has done its part.
  account.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) setOpen(false);
  });
}