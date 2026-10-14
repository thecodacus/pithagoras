import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// The MCP panel asks whether the adapter is installed each time it opens and after every change. It is answered from
// pi's settings, which is a read of a file, and not by starting pi to list its packages.
const home = inProcessHome("pithagoras-mcp-adapter-");
const agent = process.env.PI_CODING_AGENT_DIR;
// A pi that says nothing and notes that it was asked.
const bin = path.join(home, "bin");
const asked = path.join(home, "pi-was-asked");
mkdirSync(bin);
writeFileSync(path.join(bin, "pi"), `#!/bin/sh\necho "$@" >> '${asked}'\n`);
chmodSync(path.join(bin, "pi"), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { default: express } = await import("express");
const { mcpRouter } = await import("../dist/api/mcp.js");
const app = express();
app.use("/api", mcpRouter());
const listener = app.listen(0, "127.0.0.1");
await new Promise((resolve) => listener.once("listening", resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(() => listener.close());

const settings = (packages) => writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages }));
const panel = async () => (await fetch(`${base}/mcp`)).json();

test("the adapter is installed when pi's settings list it, whichever way, and pi is not started to find out", async () => {
  for (const source of ["npm:pi-mcp-adapter@2.18.0", "npm:pi-mcp-adapter", "git:github.com/someone/pi-mcp-adapter"]) {
    settings([source, "npm:something-else"]);
    assert.equal((await panel()).adapterInstalled, true, source);
  }
  // Switched off is still installed: the panel says to install it, and it is there.
  settings([{ source: "npm:pi-mcp-adapter@2.18.0", extensions: [] }]);
  assert.equal((await panel()).adapterInstalled, true);
  assert.equal(existsSync(asked), false, "pi was not started");
});

test("without the adapter in the settings the panel says to install it", async () => {
  settings(["npm:something-else"]);
  assert.equal((await panel()).adapterInstalled, false);
  settings([]);
  assert.equal((await panel()).adapterInstalled, false);
  assert.equal(existsSync(asked), false, "pi was not started");
});
