// The invite a master has just made (plan 8.26, R43): the QR code of the link, the link, the choice of address when
// the computer has several (Wi-Fi next to a VPN or WSL) and a copy button. The QR code keeps the same colours in
// every theme. Text from outside (adapter names) goes only through textContent.

import { getLang, t } from "../i18n/index.ts";
import { secretLine } from "./admin.ts";
import type { GameInvite, InviteLink } from "./api.ts";
import { button, labelled, setKey } from "./login.ts";
import { encodeQr, QrTooLongError } from "./qr.ts";
import type { QrCode } from "./qr.ts";

/** Light modules around the symbol (ISO/IEC 18004, 6.3.8). */
const QUIET_ZONE = 4;
/** About how wide the QR code is on the page, in CSS pixels. */
const QR_CSS_PX = 208;

/** Draws the symbol with its quiet zone, whole device pixels per module so the edges stay sharp. */
function drawQr(canvas: HTMLCanvasElement, code: QrCode): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d context is unavailable");
  const style = getComputedStyle(document.documentElement);
  const side = code.size + 2 * QUIET_ZONE;
  const ratio = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.floor((QR_CSS_PX * ratio) / side));
  canvas.width = canvas.height = side * scale;
  // The height follows the width (style.css), so a narrow panel shrinks the code without stretching it.
  canvas.style.width = `${(side * scale) / ratio}px`;
  context.fillStyle = style.getPropertyValue("--qr-light").trim();
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = style.getPropertyValue("--qr-dark").trim();
  code.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) context.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale);
    }),
  );
}

/** The address of the page itself, as in stage 5: used when the server knows no address in the network. */
const pageLink = (code: string): InviteLink => ({ url: `${location.origin}${location.pathname}#join=${code}`, adapter: null });

function addressText(link: InviteLink): string {
  const address = new URL(link.url).host;
  return link.adapter === null ? address : t("game.inviteAddressOption", { address, adapter: link.adapter });
}

export function inviteView(invite: GameInvite): HTMLElement {
  const view = document.createElement("div");
  view.className = "invite";
  const until = new Date(invite.expiresAt).toLocaleString(getLang());
  view.append(secretLine("game.inviteCode", { uses: String(invite.maxUses), until }, invite.code));
  const local = invite.links.length === 0;
  const links = local ? [pageLink(invite.code)] : invite.links;
  view.append(labelled("p", local ? "game.inviteLocalOnly" : "game.inviteHint", "form-note"));

  const canvas = document.createElement("canvas");
  canvas.className = "qr";
  canvas.setAttribute("role", "img");
  canvas.dataset.i18nTitle = "game.inviteQr";
  canvas.title = t("game.inviteQr");
  const tooLong = labelled("p", "game.inviteTooLong", "form-note");

  const linkWrap = document.createElement("label");
  linkWrap.className = "field";
  const linkInput = document.createElement("input");
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkWrap.append(labelled("span", "game.inviteLink"), linkInput);
  const status = document.createElement("p");
  status.className = "form-note";
  status.setAttribute("role", "status");

  const show = (link: InviteLink): void => {
    linkInput.value = link.url;
    status.hidden = true;
    try {
      drawQr(canvas, encodeQr(link.url));
      canvas.hidden = false;
      tooLong.hidden = true;
    } catch (error) {
      if (!(error instanceof QrTooLongError)) throw error;
      canvas.hidden = true;
      tooLong.hidden = false;
    }
  };

  const copy = button("game.copy", () => {
    // The clipboard is there only on HTTPS and localhost; elsewhere the link is selected for Ctrl+C.
    const copying = navigator.clipboard ? navigator.clipboard.writeText(linkInput.value).then(() => true, () => false) : Promise.resolve(false);
    void copying.then((copied) => {
      if (!copied) {
        linkInput.focus();
        linkInput.select();
      }
      setKey(status, copied ? "game.copied" : "game.copyManually");
      status.hidden = false;
    });
  });

  if (links.length > 1) {
    const addressWrap = document.createElement("label");
    addressWrap.className = "field";
    const select = document.createElement("select");
    links.forEach((link, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = addressText(link);
      select.append(option);
    });
    select.addEventListener("change", () => show(links[Number(select.value)]));
    addressWrap.append(labelled("span", "game.inviteAddress"), select);
    view.append(addressWrap);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(copy);
  view.append(canvas, tooLong, linkWrap, actions, status);
  show(links[0]);
  return view;
}
