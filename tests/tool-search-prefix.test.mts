import { test } from "node:test";
import assert from "node:assert/strict";
import { callThrough, nativeLoading, pi, wireSession, GROUP, type Captured } from "./pi-wire.mts";

/**
 * The cache rule of the tool search (issue #361, 2.4): what is in the tools array and the system prompt does not
 * change while a chat runs, so a search and a call through it cost no prompt cache and no KV cache, on every provider.
 *
 * pi's real adapters build each request (see pi-wire.mts), and the head of every one of them, from the first
 * request to the one after the call, has to be the same text. The same chat done with pi's own loading of a found tool
 * is the control: where the provider cannot take a tool added in the middle of a conversation the head changes, which is
 * why the tool search calls through and does not load. A test that never saw a head change could not tell.
 */

/** The provider rows of 2.5 of the issue, by a model of each, and whether pi's own loading keeps the head there. */
const ROWS: { row: string; provider: string; id?: string; native: { tools: "holds" | "changes"; system: "holds" | "changes" } }[] = [
  { row: "Anthropic Messages, a model with mid-conversation tool changes", provider: "anthropic", id: "claude-fable-5", native: { tools: "holds", system: "holds" } },
  { row: "Anthropic Messages, any other Claude model", provider: "anthropic", id: "claude-opus-4-5", native: { tools: "changes", system: "changes" } },
  { row: "OpenAI Responses, gpt-5.4 and later", provider: "openai", id: "gpt-5.4", native: { tools: "holds", system: "holds" } },
  { row: "OpenAI Responses, an older model", provider: "openai", id: "gpt-4.1", native: { tools: "changes", system: "changes" } },
  { row: "OpenAI Chat Completions, a custom endpoint", provider: "local", id: "local-model", native: { tools: "changes", system: "changes" } },
  { row: "OpenAI Chat Completions, Kimi K3", provider: "moonshotai", id: "kimi-k3", native: { tools: "holds", system: "holds" } },
  { row: "Amazon Bedrock", provider: "amazon-bedrock", id: "amazon.nova-lite-v1:0", native: { tools: "changes", system: "changes" } },
  { row: "Google AI Studio", provider: "google", id: "gemini-2.5-flash", native: { tools: "changes", system: "changes" } },
  { row: "Google Vertex", provider: "google-vertex", id: "gemini-2.5-flash", native: { tools: "changes", system: "changes" } },
  { row: "Mistral", provider: "mistral", id: "codestral-latest", native: { tools: "changes", system: "changes" } },
];

const call = (name: string, args: unknown = {}) => ({ name, args });
const model = async (row: (typeof ROWS)[number]) => (await pi.ModelRuntime.create()).getModel(row.provider, row.id);

/** What one chat asked of the model, from its first request to its last: the head of each, as text. */
async function heads(row: (typeof ROWS)[number], extension: (pi: any) => void, script: (n: number) => any): Promise<Captured[]> {
  const { session, requests } = await wireSession(await model(row), [extension], script);
  try {
    await session.prompt("Open the thing.");
  } finally {
    session.dispose();
  }
  return requests;
}

for (const row of ROWS) {
  test(`${row.row}: the tools array and the system prompt are the same after a search, a call and a direct call by name`, async () => {
    const extension = await callThrough();
    // A search, a call through it, the found tool by its own name (it is left out of the list but still runs), and the answer.
    const script = [call("tool_search", { action: "search", query: "open" }), call("tool_search", { action: "call", name: GROUP[0], args: { x: "a" } }), call(GROUP[1], { x: "b" }), "Done."];
    const requests = await heads(row, extension, (n) => script[n]);
    assert.equal(requests.length, 4, "a request before the search, and one after each answer");
    for (const [i, request] of requests.entries()) {
      assert.equal(request.tools, requests[0].tools, `the tools array of request ${i} is request 0's`);
      assert.equal(request.system, requests[0].system, `the system prompt of request ${i} is request 0's`);
    }
    // And the head is the one of a chat that has a tool search: the group is out of it, the other tools are in.
    for (const name of GROUP) {
      assert.doesNotMatch(requests[0].tools, new RegExp(name), `${name} is not declared`);
      assert.doesNotMatch(requests[0].system, new RegExp(name), `${name} is not in the system prompt's tools or rules`);
    }
    assert.match(requests[0].tools, /plain_tool/);
    assert.match(requests[0].tools, /tool_search/);
    // That the system prompt read here is the prompt: pi lists the tools that are declared in it.
    assert.match(requests[0].system, /plain_tool snippet/);
    // What the model did is in the history of the last request, by name, though the group was never declared.
    assert.match(JSON.stringify(requests[3].body), new RegExp(GROUP[1]));
  });

  test(`${row.row}: with pi's own loading of a found tool the head ${row.native.tools === "holds" ? "holds" : "changes"} (the control)`, async () => {
    const script = [call("tool_search", { action: "load" }), call(GROUP[0], { x: "a" }), "Done."];
    const requests = await heads(row, await nativeLoading(), (n) => script[n]);
    assert.equal(requests.length, 3);
    // The group is declared by the third request at the latest, so a head that holds does it with a mid-conversation update.
    const first = requests[0];
    const last = requests[requests.length - 1];
    assert.equal(last.tools === first.tools, row.native.tools === "holds", `the tools array ${row.native.tools}`);
    assert.equal(last.system === first.system, row.native.system === "holds", `the system prompt ${row.native.system}`);
  });
}

test("the test sees a head that changes: a group that is hidden only after the search is declared before it", async () => {
  const { Type } = await import("typebox");
  const row = ROWS[1];
  let found = false;
  const late = (p: any) => {
    for (const name of GROUP) p.registerTool({ name, label: name, description: name, parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: "ran" }], details: {} }; } });
    p.registerTool({
      name: "tool_search",
      label: "tool_search",
      description: "Find the tools that are not in your list.",
      parameters: Type.Object({}),
      exposure: "model-only",
      // What a hidden set read from live state does: it is a different head after the first search.
      prepareLoadout: (loadout: any) => ({ hiddenDeclarations: found ? loadout.declared.map((t: any) => t.name).filter((n: string) => (GROUP as readonly string[]).includes(n)) : [] }),
      async execute() {
        found = true;
        return { content: [{ type: "text" as const, text: "found" }], details: {} };
      },
    });
  };
  const script = [call("tool_search"), call("tool_search"), "Done."];
  // pi reads the loadout again for every request, so a set that follows live state shows in the request after it changes.
  const requests = await heads(row, late, (n) => script[n]);
  assert.match(requests[0].tools, /alpha_open/, "declared at first");
  assert.notEqual(requests[requests.length - 1].tools, requests[0].tools);
});
