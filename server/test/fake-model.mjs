import { after } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";

/**
 * A model server of the OpenAI chat-completions kind, for a test that runs pi
 * against it. `reply(request)` says what the model does at each request: a
 * string it says, `{ name, args }` for a call of a tool, a list of those for
 * several calls in one message, `{ name, pieces, between }` for one whose
 * arguments come in pieces (`pieces` are the raw JSON text, and `between(i)` is
 * awaited after piece `i` has been sent, so a test can look at what the portal
 * has made of the call so far), or a promise of any for one that is held.
 * The request is the JSON pi sent, and is kept in `requests`. Anything else
 * asked of the server is not what pi does with a model, so it is answered 500
 * and kept in `unexpected`, where a test that cares can look: a wrong address
 * fails there, and does not get a model's words.
 */
export async function fakeModel(reply = () => "Done.") {
  const requests = [];
  const unexpected = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        unexpected.push(`${req.method} ${req.url}`);
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `a fake model has no ${req.method} ${req.url}` }));
        return;
      }
      const request = JSON.parse(body);
      requests.push(request);
      const answer = await reply(request);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (answer && !Array.isArray(answer) && answer.pieces) {
        const id = `call-${requests.length}`;
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: answer.name, arguments: "" } }] }));
        for (const [i, piece] of answer.pieces.entries()) {
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
          await answer.between?.(i);
          if (res.destroyed) return;
        }
        res.end(chunk({}, "tool_calls") + "data: [DONE]\n\n");
        return;
      }
      res.end(typeof answer === "string" ? say(answer) : calls(`call-${requests.length}`, [answer].flat()));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    url, requests, unexpected,
    /** What pi's models.json holds for it: the provider `fake`, with one model, `m`. */
    models: () => ({
      providers: {
        fake: {
          baseUrl: url, api: "openai-completions", apiKey: "none",
          models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 100 }],
        },
      },
    }),
  };
}

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const say = (text) => chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n";
const calls = (id, list) =>
  chunk({ role: "assistant", tool_calls: list.map(({ name, args }, index) => ({ index, id: list.length === 1 ? id : `${id}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";

/** How many results of tool calls a request already holds: where in a scripted conversation the model is. */
export const resultsIn = (request) => request.messages.filter((m) => m.role === "tool").length;
