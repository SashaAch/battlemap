// Server settings in data/settings.json, created on the first start (plan 8.4).
// Keys this version does not know are kept when the file is written back.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PORT = 8080;

export interface Settings {
  port: number;
  /** Anyone may register without a code from an administrator (R18). */
  openRegistration: boolean;
}

export class SettingsFile {
  readonly #file: string;
  #raw: Record<string, unknown>;
  #settings: Settings;
  #queue: Promise<void> = Promise.resolve();

  private constructor(file: string, raw: Record<string, unknown>) {
    this.#file = file;
    this.#raw = raw;
    this.#settings = check(raw, file);
  }

  /** Reads `settings.json` in `dataDir`, creating it with defaults when missing. A broken file is an error, not overwritten. */
  static async open(dataDir: string): Promise<{ settings: SettingsFile; created: boolean }> {
    const file = path.join(dataDir, "settings.json");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const settings = new SettingsFile(file, { port: DEFAULT_PORT, openRegistration: false });
      await settings.#write();
      return { settings, created: true };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`${file} is not valid JSON`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`);
    return { settings: new SettingsFile(file, raw as Record<string, unknown>), created: false };
  }

  get current(): Settings {
    return { ...this.#settings };
  }

  /** Changes are written one after another, so two at once cannot race on the temporary file. */
  setOpenRegistration(open: boolean): Promise<void> {
    const change = this.#queue.then(() => this.#change(open));
    this.#queue = change.catch(() => undefined);
    return change;
  }

  async #change(open: boolean): Promise<void> {
    const raw = { ...this.#raw, openRegistration: open };
    const settings = check(raw, this.#file);
    const before = this.#raw;
    this.#raw = raw;
    try {
      await this.#write();
    } catch (error) {
      this.#raw = before;
      throw error;
    }
    this.#settings = settings;
  }

  /** Writes a temporary file and renames it, so a crash never leaves half a file. */
  async #write(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#raw, null, 2)}\n`, "utf8");
    await rename(temporary, this.#file);
  }
}

function check(raw: Record<string, unknown>, file: string): Settings {
  const port = raw.port ?? DEFAULT_PORT;
  const openRegistration = raw.openRegistration ?? false;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${file}: "port" must be a whole number from 1 to 65535`);
  }
  if (typeof openRegistration !== "boolean") throw new Error(`${file}: "openRegistration" must be true or false`);
  return { port, openRegistration };
}
