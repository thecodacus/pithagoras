import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A folder shipped with the portal — `channels`, `skills`, `extensions/subagent` — wherever this install keeps it.
 *
 * Found from the compiled files and from source alike: at the repository's root, beside core/ (the server is
 * core/server), in the server's own folder, or from where the portal was started. `marker` is a file the folder has to hold, for a name
 * that another folder of the same name could have.
 */
export function bundledPath(name: string, marker?: string): string | undefined {
  const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const candidate of [
    path.resolve(server, "..", "..", name),
    path.resolve(server, name),
    path.resolve(process.cwd(), name),
    path.resolve(process.cwd(), "..", name),
    path.resolve(process.cwd(), "..", "..", name),
  ]) {
    if (existsSync(marker ? path.join(candidate, marker) : candidate)) return candidate;
  }
  return undefined;
}
