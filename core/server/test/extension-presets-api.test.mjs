import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PASSWORD, cookieOf, login, portalOf } from "./auth-harness.mjs";
import { testHome } from "./server-harness.mjs";

/**
 * What the setup assistant's extension step asks the portal: the sets it offers (Minimal, Developer, Creative,
 * Everything), by the packages each holds, and what installing one of them brings. The step installs what is missing
 * through the same calls Settings → Extensions does (the plan, then POST /api/packages), so it is open to whoever may
 * install an extension there, which is anyone signed in, and to nobody before. pi is a stand-in with nothing installed.
 */
const home = testHome("extension-presets-");
const bin = path.join(home, "bin");
mkdirSync(bin);
writeFileSync(path.join(bin, "pi"), `#!/bin/sh\ncase "$1" in list) echo "User packages:" ;; esac\n`);
chmodSync(path.join(bin, "pi"), 0o755);

test("the sets and their plans are for the person signed in, and for nobody before", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, home);
  try {
    for (const route of ["/api/extensions/presets", "/api/extensions/shipped", "/api/extensions/plan?spec=x", "/api/packages"]) {
      assert.equal((await fetch(`${p.base}${route}`)).status, 401, `${route} without a login`);
    }
    assert.equal((await fetch(`${p.base}/api/packages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: "/x" }) })).status, 401, "installing, without a login");

    const cookie = cookieOf(await login(PASSWORD, p.base));
    const get = async (route) => (await fetch(`${p.base}${route}`, { headers: { Cookie: cookie } })).json();
    const { presets } = await get("/api/extensions/presets");
    assert.deepEqual(presets.map((preset) => preset.id), ["minimal", "developer", "creative", "everything"]);
    assert.deepEqual(presets[0].extensions, ["pithagoras-terminal", "pithagoras-files", "pithagoras-themes"]);

    // Every name in a set is an extension the portal ships, so the step can install it from the list Settings shows.
    const { extensions: shipped } = await get("/api/extensions/shipped");
    const byName = new Map(shipped.map((ext) => [ext.name, ext]));
    for (const preset of presets) for (const name of preset.extensions) assert.ok(byName.has(name), `${preset.id}: ${name}`);
    assert.deepEqual(presets[3].extensions.slice().sort(), [...byName.keys()].sort(), "Everything is all of them");

    // What needs Docker for extensions is planned with it first: the step installs each set member the way Settings does.
    for (const name of ["pithagoras-voice", "pithagoras-browser", "pithagoras-understory"]) {
      const { needs } = await get(`/api/extensions/plan?${new URLSearchParams({ spec: byName.get(name).spec })}`);
      assert.deepEqual(needs.map((need) => [need.name, need.action, need.from]), [["pithagoras-docker", "install", "shipped"]], name);
      assert.equal(needs[0].spec, byName.get("pithagoras-docker").spec);
    }
    const git = await get(`/api/extensions/plan?${new URLSearchParams({ spec: byName.get("pithagoras-git").spec })}`);
    assert.deepEqual(git.needs, []);
  } finally {
    await p.stop();
  }
});

test("a portal started with a value PORTAL_DEFAULT_EXTENSIONS does not take says so in its log, and starts all the same", async () => {
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD, PORTAL_DEFAULT_EXTENSIONS: "developr", PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  try {
    for (let i = 0; !/PORTAL_DEFAULT_EXTENSIONS="developr" is refused/.test(p.log()); i++) {
      assert.ok(i < 200, `the portal never said it: ${p.log()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(p.log(), /preset \(minimal, developer, creative, everything\)/);
    assert.equal((await fetch(`${p.base}/api/auth/status`)).status, 200);
  } finally {
    await p.stop();
  }
});

test("an install asked for while the portal installs what it starts with waits for it, so two pi installs never write its settings at once", async () => {
  const slow = testHome("extension-starting-");
  const slowBin = path.join(slow, "bin");
  mkdirSync(slowBin);
  const events = path.join(slow, "events.txt");
  // Each install takes a while and holds a lock: one that begins while another goes on is written down as an overlap.
  writeFileSync(
    path.join(slowBin, "pi"),
    `#!/bin/sh
case "$1" in
  list) echo "User packages:" ;;
  install)
    if mkdir ${JSON.stringify(path.join(slow, "lock"))} 2>/dev/null; then
      sleep 0.6
      echo "install $2" >> ${JSON.stringify(events)}
      rmdir ${JSON.stringify(path.join(slow, "lock"))}
    else
      echo "overlap $2" >> ${JSON.stringify(events)}
    fi
    ;;
esac
`,
  );
  chmodSync(path.join(slowBin, "pi"), 0o755);
  const p = await portalOf({ PORTAL_PASSWORD: PASSWORD, PORTAL_DEFAULT_EXTENSIONS: "on", PATH: `${slowBin}${path.delimiter}${process.env.PATH}` }, slow);
  try {
    const cookie = cookieOf(await login(PASSWORD, p.base));
    const res = await fetch(`${p.base}/api/packages`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ spec: "/somewhere/else" }) });
    assert.equal(res.status, 200);
    const lines = readFileSync(events, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(lines.filter((line) => line.startsWith("overlap")), []);
    assert.deepEqual(lines.map((line) => path.basename(line)), ["terminal", "files", "themes", "else"]);
  } finally {
    await p.stop();
  }
});
