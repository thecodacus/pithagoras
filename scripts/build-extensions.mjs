/**
 * Builds the extensions in this repository that have a build of their own:
 * `npm run build` in each folder of extensions/ whose package.json names one.
 * Each builds into its own folder, and what it makes is not kept in git: the
 * portal's own `npm run build`, the image, and the browser tests run this.
 *
 * An extension is built the way any extension is, by its own script: this only
 * goes through them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "extensions");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const step = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

for (const folder of readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
  const dir = path.join(ROOT, folder);
  const manifest = path.join(dir, "package.json");
  if (!existsSync(manifest)) continue;
  const meta = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof meta.scripts?.build !== "string") continue;
  step(`building ${meta.name ?? folder}`);
  execFileSync(npm, ["run", "build", "--silent", "--prefix", dir], { stdio: "inherit" });
}
step("DONE");
