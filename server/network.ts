// The addresses of this computer: links printed at start-up (R38), the links of a game invite (R43, plan 8.26)
// and the Host names requests may carry, which stops DNS rebinding (a foreign name that resolves to this computer).

import { isIPv4, isIPv6 } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { networkInterfaces } from "node:os";

/** How often the interface list may be read again when an unknown Host comes (addresses change with the network). */
const REFRESH_MS = 10_000;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The interfaces as `os.networkInterfaces()` gives them: adapter name → its addresses. */
export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

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

/** A host of a link and the network adapter it belongs to, when the server knows it. */
interface SiteAddress {
  host: string;
  adapter: string | null;
}

/** Every IPv4 and non-link-local IPv6 address of the interfaces other computers can reach, once each, with its adapter. */
function networkAddresses(interfaces: Interfaces): SiteAddress[] {
  const seen = new Map<string, SiteAddress>();
  for (const [adapter, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.internal || (entry.family === "IPv6" && isLinkLocal(entry.address))) continue;
      const host = hostForm(entry.address, entry.family);
      if (!seen.has(host)) seen.set(host, { host, adapter });
    }
  }
  return [...seen.values()];
}

/**
 * Where the site is open: localhost and every network address when the server listens on all addresses (no
 * host, 0.0.0.0 or ::), else the one address it listens on.
 */
function siteAddresses(listenHost: string | undefined, interfaces: Interfaces): SiteAddress[] {
  const network = networkAddresses(interfaces);
  if (listenHost === undefined || listenHost === "0.0.0.0" || listenHost === "::") return [{ host: "localhost", adapter: null }, ...network];
  const host = hostForm(listenHost, isIPv6(listenHost) ? "IPv6" : "IPv4");
  return [{ host, adapter: network.find((address) => address.host === host)?.adapter ?? null }];
}

/** The links the server prints at start-up (R38). */
export function siteLinks(port: number, listenHost?: string, interfaces: Interfaces = networkInterfaces()): string[] {
  return siteAddresses(listenHost, interfaces).map(({ host }) => `http://${host}:${port}/`);
}

/** A host only this computer reaches: a phone cannot open a link to it. */
function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\./.test(host);
}

/**
 * The order of network addresses in an invite (plan 8.26): home networks first (192.168.*, then 10.*, then
 * 172.16..31.*), other IPv4 after them, IPv6 last.
 */
function addressRank(host: string): number {
  if (!isIPv4(host)) return 4;
  const [a, b] = host.split(".").map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return 3;
}

/** A link of an invite with the adapter of its address, when the server knows it (Wi-Fi, a VPN, WSL). */
export interface InviteLink {
  url: string;
  adapter: string | null;
}

export interface InviteLinkOptions {
  /** What the server listens on (as in startServer) and its port. */
  listenHost: string | undefined;
  port: number;
  /** The Host header of the page's request, as sent; and whether the page came over HTTPS. */
  pageHost: string | undefined;
  secure: boolean;
  /** What follows `#` in every link, such as `join=<code>`. */
  fragment: string;
  interfaces?: Interfaces;
}

/**
 * The host and port of the page's Host header, or null when the header is not a plain name or address with an
 * optional port 1..65535.
 */
function pageAddress(header: string | undefined): { host: string; port: string } | null {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+?)\.?(?::(\d{1,5}))?$/.exec(header?.trim().toLowerCase() ?? "");
  if (!match) return null;
  const port = match[2] === undefined ? "" : String(Number(match[2]));
  if (port !== "" && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { host: match[1], port };
}

/**
 * Links of a game invite (R43, plan 8.26): one on each address the server prints at start-up but localhost and
 * 127.0.0.1, and the page's own address unless it is 127.0.0.1, localhost or [::1]. The first is the one to show
 * at first: the page's address, else the network addresses in the order of addressRank. Addresses are read now,
 * not at start-up, so a network joined since is there.
 */
export function inviteLinks(options: InviteLinkOptions): InviteLink[] {
  const interfaces = options.interfaces ?? networkInterfaces();
  const addresses = siteAddresses(options.listenHost, interfaces).filter(({ host }) => !isLoopback(host));
  const network = addresses
    .map((address, index) => ({ ...address, index }))
    .sort((a, b) => addressRank(a.host) - addressRank(b.host) || a.index - b.index)
    .map(({ host, adapter }): InviteLink => ({ url: `http://${host}:${options.port}/#${options.fragment}`, adapter }));

  const page = pageAddress(options.pageHost);
  if (!page || isLoopback(page.host)) return network;
  const pageUrl = `${options.secure ? "https" : "http"}://${page.host}${page.port ? `:${page.port}` : ""}/#${options.fragment}`;
  const known = networkAddresses(interfaces).find(({ host }) => host === page.host);
  return [{ url: pageUrl, adapter: known?.adapter ?? null }, ...network.filter(({ url }) => url !== pageUrl)];
}

/**
 * The host name of a Host header, lowercase, without the port; null when there is none. After the brackets of an
 * IPv6 address only a port may follow, so `[::1]x` is no name.
 */
export function hostName(header: string | undefined): string | null {
  if (!header) return null;
  const text = header.trim().toLowerCase();
  if (text.startsWith("[")) return /^(\[[^\]]*\])(?::\d*)?$/.exec(text)?.[1] ?? null;
  return text.replace(/:\d*$/, "").replace(/\.$/, "") || null;
}

/**
 * Host names requests may use: localhost, this computer's addresses and `allowedHosts` from settings.json.
 * The entries are read like a Host header (case, a final dot, IPv6 brackets; a port is ignored).
 */
export class HostCheck {
  readonly #fixed: Set<string>;
  #addresses = new Set<string>();
  #readAt = -Infinity;

  constructor(allowedHosts: readonly string[]) {
    // A bare IPv6 address has no port; brackets keep hostName from reading its last group as one.
    const named = allowedHosts.map((host) => hostName(isIPv6(host.trim()) ? `[${host.trim()}]` : host)).filter((name) => name !== null);
    this.#fixed = new Set([...LOCAL_HOSTS, ...named]);
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
