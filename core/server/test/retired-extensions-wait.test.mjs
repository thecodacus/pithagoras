import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A page that asks for the extensions while the start is still installing the theme package that replaces Dusk is
 * answered once that is done, with the package and its themes in the answer: told sooner, it would find the theme it
 * had chosen gone and give it up. pi is a stand-in whose install waits for a file to appear.
 */
const home = inProcessHome("retired-wait-");
const bin = path.join(home, "bin");
mkdirSync(bin);
const state = path.join(home, "installed.txt");
const release = path.join(home, "release");
const started = path.join(home, "started");
writeFileSync(state, "");
const agentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(agentDir, { recursive: true });
const settingsFile = path.join(agentDir, "settings.json");

const shipped = path.join(home, "shipped");
mkdirSync(path.join(shipped, "themes"), { recursive: true });
writeFileSync(
  path.join(shipped, "themes", "package.json"),
  JSON.stringify({ name: "pithagoras-themes", version: "1.0.0", pi: {}, pithagoras: { themes: [{ id: "dusk", name: "Dusk", dark: { accent: "#ff79c6" } }] } }),
);
writeFileSync(path.join(shipped, "defaults.json"), "[]");
const dusk = path.join(home, "image", "extensions", "theme-dusk");
writeFileSync(settingsFile, JSON.stringify({ packages: [dusk] }));

writeFileSync(
  path.join(bin, "pi"),
  `#!/bin/bash
case "$1" in
  list)
    echo "User packages:"
    while read -r dir; do [ -n "$dir" ] && printf '  %s\\n    %s\\n' "$dir" "$dir"; done < ${JSON.stringify(state)}
    ;;
  install)
    touch ${JSON.stringify(started)}
    while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done
    echo "$2" >> ${JSON.stringify(state)}
    node -e 'const fs=require("fs");const [file,dir]=process.argv.slice(1);const s=JSON.parse(fs.readFileSync(file,"utf8"));s.packages.push(dir);fs.writeFileSync(file,JSON.stringify(s))' ${JSON.stringify(settingsFile)} "$2"
    ;;
esac
`,
);
chmodSync(path.join(bin, "pi"), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { default: express } = await import("express");
const { extensionsRouter } = await import("../dist/api/extensions.js");
const { installDefaultExtensions } = await import("../dist/default-extensions.js");
const app = express();
app.use("/api", extensionsRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
test.after(() => server.close());

test("the list of extensions is not told while the package that replaces Dusk is being installed", async () => {
  const start = installDefaultExtensions(shipped);
  while (!existsSync(started)) await new Promise((r) => setTimeout(r, 20));
  let answered = false;
  const asked = fetch(`http://127.0.0.1:${server.address().port}/api/extension-ui`).then(async (res) => {
    answered = true;
    return res.json();
  });
  await new Promise((r) => setTimeout(r, 400));
  const early = answered;
  // Released either way, or the stand-in would wait for ever.
  writeFileSync(release, "");
  assert.equal(early, false, "waits for the install");
  const { extensions } = await asked;
  await start;
  assert.deepEqual(extensions.map((e) => [e.name, e.themes.map((t) => t.id)]), [["pithagoras-themes", ["dusk"]]]);
});
