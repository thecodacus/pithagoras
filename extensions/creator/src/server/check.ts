import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { NAME } from "./made";

/** Why a package with a pi half is refused: that half would run where the made extension's own process does not reach. */
const PI_HALF =
  "A pi half (pi.extensions) runs in every chat's pi, inside the portal and outside its own process: give tools through portal.chats.extend in the server half";

const isFile = (file: string) => lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;
const within = (root: string, file: string) => file.startsWith(root + path.sep);

/**
 * What a copy of a draft must be before it is installed, read from the copy and never from the draft, which the agent
 * can change meanwhile: its name, that pi gets nothing of it that runs code, and that the halves it declares are
 * where the portal looks for them. The rest is the portal's to say when it installs it: a name an extension that
 * comes with the portal has, or that is taken by another package; why a half could not start; a `requires` that is
 * not met. Throws an Error that says what to change.
 */
export function check(dir: string): { name: string; version?: string } {
  let meta: any;
  try {
    meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    throw new Error("It has no package.json that can be read: it needs one at the top of its folder");
  }
  const name = meta?.name;
  if (typeof name === "string" && name.startsWith("@")) throw new Error("Give it a name without a scope: it is one folder");
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(`Its name, ${JSON.stringify(name)}, is not one npm takes: letters, digits, "-", "_", "." and "~", not starting with "."`);
  }
  const pi = meta.pi;
  if (typeof pi !== "object" || pi === null || Array.isArray(pi)) {
    throw new Error('Its package.json needs "pi": {}: without it pi takes the whole folder for a pi extension, cannot load it, and the chats do not start');
  }
  // Skills, prompts and themes carry no code. A package's folder `extensions/` is loaded as its pi half where the
  // entry pi's settings keep for it names none (one written by `pi config`, or by hand).
  if ("extensions" in pi || lstatSync(path.join(dir, "extensions"), { throwIfNoEntry: false })?.isDirectory()) throw new Error(PI_HALF);
  const declared = meta.pithagoras ?? {};
  // Whether it is ESM is not asked: a half in a process of its own is a new process at each start, which reads
  // CommonJS anew too, and a module with no default export fails its start with a reason.
  if (declared.server !== undefined && (typeof declared.server !== "string" || !within(dir, path.resolve(dir, declared.server)) || !isFile(path.resolve(dir, declared.server)))) {
    throw new Error(`pithagoras.server is ${JSON.stringify(declared.server)}, which is no file in its folder`);
  }
  if (declared.client !== undefined) {
    const client = typeof declared.client === "string" ? path.resolve(dir, declared.client) : "";
    // The portal serves the client's whole folder to whoever is signed in: one at the package's root is not loaded.
    if (!within(dir, client) || path.dirname(client) === dir) {
      throw new Error("Put the browser half in a folder of its own (web/client.js): the portal serves that whole folder");
    }
    if (!isFile(client)) throw new Error(`pithagoras.client is ${JSON.stringify(declared.client)}, which is no file in its folder`);
  }
  return { name, ...(typeof meta.version === "string" ? { version: meta.version } : {}) };
}
