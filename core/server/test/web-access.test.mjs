import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

/**
 * pi-web-access's tools are made eager, once, as the portal starts with the package installed or as it is installed:
 * its own `web_enable` would otherwise hide them past the portal's marks. What the file says besides is kept, and so is
 * what somebody sets after.
 */
const home = inProcessHome("pithagoras-web-access-");
const agent = process.env.PI_CODING_AGENT_DIR;
mkdirSync(agent, { recursive: true });
const config = path.join(agent, "web-search.json");
const listed = (packages) => writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages }));
/** What `pi list` says of an installed pi-web-access of this version: its spec and its folder, with the package's own package.json. */
const installed = (version) => {
  const dir = path.join(home, "pkgs", version, "pi-web-access");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-web-access", version }));
  return [{ spec: "npm:pi-web-access", path: dir, scope: "User" }];
};

const db = await import("../dist/db.js");
const { eagerWebAccess, webSearchConfigPath } = await import("../dist/web-access.js");
const { followPackages } = await import("../dist/api/extensions.js");

const logs = [];
const log = console.log;
console.log = (...args) => (/pi-web-access/.test(String(args[0])) ? logs.push(String(args[0])) : log(...args));
const warn = console.warn;
console.warn = (...args) => (/pi-web-access/.test(String(args[0])) ? logs.push(String(args[0])) : warn(...args));

beforeEach(() => {
  db.putSetting("web_access_eager", "");
  rmSync(config, { force: true });
  logs.length = 0;
});

test("where pi looks for it: the agent folder pi is given", () => {
  assert.equal(webSearchConfigPath(), config);
});

test("nothing while the package is not installed, and it is done once it is", () => {
  listed(["npm:pi-other@1.0.0"]);
  eagerWebAccess(installed("0.35.0"));
  assert.equal(existsSync(config), false);
  listed(["npm:pi-web-access@0.35.0"]);
  eagerWebAccess(installed("0.35.0"));
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { toolActivation: "eager" });
  assert.equal(statSync(config).mode & 0o777, 0o600, "it holds the services' keys: the person's alone");
  assert.match(logs[0], /toolActivation is "eager" in .*web-search\.json \(it was not set\)/);
});

test("what the file says besides is kept, as private as it was, and what somebody sets after stands", () => {
  listed([{ source: "npm:pi-web-access@0.35.0", extensions: [] }]);
  writeFileSync(config, JSON.stringify({ toolActivation: "auto", perplexityApiKey: "key" }));
  chmodSync(config, 0o640);
  eagerWebAccess(installed("0.48.0"));
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { toolActivation: "eager", perplexityApiKey: "key" });
  assert.equal(statSync(config).mode & 0o777, 0o640);
  assert.match(logs[0], /\(it was "auto"\)/);
  writeFileSync(config, JSON.stringify({ toolActivation: "dynamic" }));
  eagerWebAccess(installed("0.48.0"));
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { toolActivation: "dynamic" }, "once");
});

test("a file that cannot be read is left alone and tried again; one that is eager already is not written", () => {
  listed(["npm:pi-web-access@0.35.0"]);
  writeFileSync(config, "{ not json");
  eagerWebAccess(installed("0.35.0"));
  assert.equal(readFileSync(config, "utf8"), "{ not json");
  assert.match(logs[0], /cannot be read/);
  writeFileSync(config, '{"toolActivation":"eager"}');
  eagerWebAccess(installed("0.35.0"));
  assert.equal(readFileSync(config, "utf8"), '{"toolActivation":"eager"}');
  assert.equal(db.getSetting("web_access_eager"), "1");
});

test("only a version that knows \"eager\": none before 0.33.0 or where pi cannot say which, and that is tried again after an update", () => {
  listed(["npm:pi-web-access"]);
  writeFileSync(config, JSON.stringify({ toolActivation: "dynamic" }));
  eagerWebAccess(installed("0.32.0"));
  eagerWebAccess(undefined);
  eagerWebAccess([{ spec: "npm:pi-web-access", scope: "User" }]);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { toolActivation: "dynamic" });
  assert.ok(!db.getSetting("web_access_eager"), "not done: tried again");
  eagerWebAccess(installed("0.33.0"));
  assert.equal(JSON.parse(readFileSync(config, "utf8")).toolActivation, "eager");
});

test("pi's own deferred route is left as it is: pi-web-access refuses to load it with \"eager\"", () => {
  listed(["npm:pi-web-access"]);
  for (const deferred of [{ toolExposure: "deferred" }, { toolExposure: "deferred", toolActivation: "none" }, { toolActivation: "none" }]) {
    db.putSetting("web_access_eager", "");
    logs.length = 0;
    writeFileSync(config, JSON.stringify(deferred));
    eagerWebAccess(installed("0.48.0"));
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), deferred);
    assert.match(logs[0], /left as .* says .*deferred route/);
    assert.equal(db.getSetting("web_access_eager"), "1", "once: what is set there stands");
  }
});

test("the portal does it as it brings the server halves in line with what is installed: as it starts, and after an install", async () => {
  listed(["npm:pi-web-access@0.35.0"]);
  // A pi whose `pi list` names the package and its folder.
  const [{ path: folder }] = installed("0.35.0");
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pi"), `#!/bin/sh\necho "User packages:"\necho "  npm:pi-web-access@0.35.0"\necho "    ${folder}"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  // There is no pi to list the packages here: that the halves cannot be brought in line is said, and is not this test's.
  const error = console.error;
  console.error = () => {};
  try {
    await followPackages();
  } finally {
    console.error = error;
  }
  assert.equal(JSON.parse(readFileSync(config, "utf8")).toolActivation, "eager");
});
