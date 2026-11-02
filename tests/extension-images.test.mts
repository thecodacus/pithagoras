import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Docker warns when a container runs another pinned image than the one its extension wants, but only where the extension
// says which it wants (`containers.wantImage`). So every extension that makes containers has to say it: an update that
// changes its pinned image then shows the warning, with no more work.

const extensions = path.join(import.meta.dirname, "..", "extensions");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = path.join(dir, entry);
    return statSync(file).isDirectory() ? sources(file) : /\.(ts|tsx)$/.test(entry) ? [file] : [];
  });
}

test("every built-in extension that makes containers through Docker says which image its containers should run, and requires a Docker that asks", () => {
  const making: string[] = [];
  for (const name of readdirSync(extensions)) {
    // Docker's own containers are its compose runner (removed after each run) and its forwarders (`forwarderWish`).
    if (name === "docker" || !statSync(path.join(extensions, name)).isDirectory()) continue;
    const src = path.join(extensions, name, "src");
    let files: string[];
    try {
      files = sources(src);
    } catch {
      continue;
    }
    const text = files.map((file) => readFileSync(file, "utf8"));
    if (!text.some((t) => /\bcontainers\.create\(/.test(t))) continue;
    making.push(name);
    assert.ok(text.some((t) => /\bcontainers\.wantImage\(/.test(t)), `${name} makes containers and does not call containers.wantImage`);
    const range = JSON.parse(readFileSync(path.join(extensions, name, "package.json"), "utf8")).pithagoras?.requires?.["pithagoras-docker"] as string | undefined;
    const [major, minor] = (range ?? "").replace(/^[\^~>=\s]+/, "").split(".").map(Number);
    assert.ok(major > 1 || (major === 1 && minor >= 4), `${name} calls containers.wantImage and requires pithagoras-docker ${range}, which has none (1.4.0)`);
  }
  assert.deepEqual(making.sort(), ["browser", "understory", "voice"]);
});

test("the guide tells extension authors to state their pinned image with containers.wantImage", () => {
  const guide = readFileSync(path.join(import.meta.dirname, "..", "docs", "guide", "extension-ui.md"), "utf8");
  assert.match(guide, /state it with\s+`containers\.wantImage`/);
});
