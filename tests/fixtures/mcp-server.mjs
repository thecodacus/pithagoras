// A small MCP server over stdio, for the tests of what pi's MCP support does with one: newline-delimited JSON-RPC, the
// calls a client makes (initialize, tools/list, tools/call, ping) and nothing else.
//
//   node mcp-server.mjs <name> [--tools a,b] [--delay ms] [--slow-read ms] [--gate file] [--resources] [--instructions text] [--log file]
//
// `--delay` holds the answer to `initialize` back, as a server that starts slowly does, and `--slow-read` the answer to a
// resource's read, as a long call does; `--gate` holds it back until the
// file exists, which a test makes once it has what it needed before the server connects. `--log` appends a line for each
// start and each call, so a test can tell how many times the server ran and what it was asked.
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const [name = "fixture", ...rest] = process.argv.slice(2);
const flag = (key, fallback) => {
  const at = rest.indexOf(key);
  return at < 0 ? fallback : rest[at + 1] ?? true;
};
const tools = String(flag("--tools", "ping")).split(",").filter(Boolean);
const delay = Number(flag("--delay", 0));
const slowRead = Number(flag("--slow-read", 0));
const gate = flag("--gate", undefined);
const log = flag("--log", undefined);
const note = (line) => log && appendFileSync(log, `${Date.now()} ${process.pid} ${line}\n`);
note(`start ${name}`);
process.on("exit", () => note(`exit ${name}`));

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const answer = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {}, ...(rest.includes("--resources") ? { resources: {} } : {}) },
    serverInfo: { name, version: "1.0.0" },
    instructions: flag("--instructions", `The ${name} fixture server.`),
  }),
  "tools/list": () => ({
    tools: tools.map((tool) => ({
      name: tool,
      description: `The ${tool} tool of ${name}.`,
      inputSchema: { type: "object", properties: { text: { type: "string", description: "what to say" } } },
    })),
  }),
  "tools/call": (params) => ({ content: [{ type: "text", text: `${name}/${params.name} says ${JSON.stringify(params.arguments ?? {})}` }] }),
  "resources/list": () => ({ resources: [{ uri: `file:///${name}/one.txt`, name: "one" }] }),
  "resources/templates/list": () => ({ resourceTemplates: [] }),
  "resources/read": (params) => ({ contents: [{ uri: params.uri, text: `contents of ${params.uri}` }] }),
  ping: () => ({}),
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // a notification: initialized, cancelled
  note(`${message.method} ${message.method === "tools/call" ? message.params?.name : ""}`.trim());
  if (message.method === "initialize" && delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (message.method === "resources/read" && slowRead) await new Promise((resolve) => setTimeout(resolve, slowRead));
  if (message.method === "initialize" && gate) while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 10));
  const reply = answer[message.method];
  if (!reply) return send({ id: message.id, error: { code: -32601, message: `no ${message.method}` } });
  send({ id: message.id, result: reply(message.params) });
});
process.stdin.on("end", () => process.exit(0));
