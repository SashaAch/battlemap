// The addresses of this computer: links printed at start-up (R39) and the Host names requests may carry,
// which stops DNS rebinding (a foreign name that resolves to this computer).

import { networkInterfaces } from "node:os";

/** How often the interface list may be read again when an unknown Host comes (addresses change with the network). */
const REFRESH_MS = 10_000;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** An address as it is written in a Host header or a link: IPv6 in brackets, without a zone. */
function hostForm(address: string, family: string): string {
  return family === "IPv6" ? `[${address.replace(/%.*$/, "").toLowerCase()}]` : address;
}

function isLinkLocal(address: string): boolean {
  return /^fe[89ab]/i.test(address);
}

/** All addresses of this computer's interfaces, in Host form. */
function allAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((entry) => hostForm(entry.address, entry.family));
}

/** Links to the site for people on this computer and in the local network: localhost, every IPv4 and non-link-local IPv6. */
export function siteLinks(port: number): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((entry) => !entry.internal && !(entry.family === "IPv6" && isLinkLocal(entry.address)))
    .map((entry) => hostForm(entry.address, entry.family));
  return ["localhost", ...new Set(addresses)].map((host) => `http://${host}:${port}/`);
}

/** The host name of a Host header, lowercase, without the port; null when there is none. */
export function hostName(header: string | undefined): string | null {
  if (!header) return null;
  const text = header.trim().toLowerCase();
  const name = text.startsWith("[") ? text.slice(0, text.indexOf("]") + 1) : text.replace(/:\d*$/, "");
  return name.replace(/\.$/, "") || null;
}

/** Host names requests may use: localhost, this computer's addresses and `allowedHosts` from settings.json. */
export class HostCheck {
  readonly #fixed: Set<string>;
  #addresses = new Set<string>();
  #readAt = -Infinity;

  constructor(allowedHosts: readonly string[]) {
    this.#fixed = new Set([...LOCAL_HOSTS, ...allowedHosts]);
  }

  allows(name: string | null): boolean {
    if (name === null) return false;
    if (this.#fixed.has(name) || this.#addresses.has(name)) return true;
    const now = Date.now();
    if (now - this.#readAt < REFRESH_MS) return false;
    this.#readAt = now;
    this.#addresses = new Set(allAddresses());
    return this.#addresses.has(name);
  }
}
