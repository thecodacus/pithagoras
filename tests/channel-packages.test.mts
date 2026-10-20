import { test } from "node:test";
import assert from "node:assert/strict";

// The builtin channel packages against a stand-in for their platform, which is
// all they talk to: Telegram over fetch.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A Telegram that answers what the package asks, and hands it what the test puts in the inbox. */
function telegram() {
  const calls: { method: string; body: any }[] = [];
  const inbox: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "getUpdates") {
      while (!inbox.length) {
        if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        await sleep(5);
      }
      return json({ ok: true, result: inbox.splice(0) });
    }
    return json({ ok: true, result: method === "getMe" ? { username: "bot" } : {} });
  }) as any;
  return { calls, inbox, restore: () => (globalThis.fetch = real) };
}

test("a Telegram button is answered only by somebody the portal says may, and stays open for them", async () => {
  const api = telegram();
  const controller = new AbortController();
  const { start } = await import("../channels/telegram/index.js");
  const channel = await start({ config: { botToken: "t" }, log() {}, signal: controller.signal, ask: async () => "" });
  try {
    const answer = channel.prompt("chat:1", {
      id: "abcdefghijklmnopqrstuvwxyz",
      method: "confirm",
      question: "Delete branch release?",
      // As the portal answers it: the person it was put to, or the primary user.
      canAnswer: (senderId: string) => senderId === "111",
    });
    let settled: any;
    void answer.then((value: any) => (settled = value));
    await sleep(20);

    // The button's data is the last sixteen characters of the portal's id, and the index.
    const data = `${"abcdefghijklmnopqrstuvwxyz".slice(-16)}:0`;
    const tap = (from: number) => ({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id: `q${from}`, data, from: { id: from }, message: { chat: { id: 1 }, message_id: 5 } } });

    api.inbox.push(tap(999));
    await sleep(60);
    assert.equal(settled, undefined, "a member of the group who is not that person did not answer it");
    assert.equal(api.calls.some((c) => c.method === "editMessageText"), false, "the buttons are still there");
    const refused = api.calls.find((c) => c.method === "answerCallbackQuery" && c.body.callback_query_id === "q999");
    assert.match(refused!.body.text, /not for you/);

    api.inbox.push(tap(111));
    await sleep(60);
    assert.deepEqual(settled, { value: true });
    assert.ok(api.calls.some((c) => c.method === "editMessageText"), "the question now reads as decided");
  } finally {
    controller.abort();
    await channel.stop();
    api.restore();
  }
});

/** A WebSocket the test drives by hand: what the platform would push, fired at the package. */
class FakeSocket {
  static all: FakeSocket[] = [];
  listeners: Record<string, ((event: any) => unknown)[]> = {};
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: (event: any) => unknown) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  async fire(type: string, event: any) {
    await Promise.all((this.listeners[type] ?? []).map((fn) => fn(event)));
  }
}

/** What a channel package gets from the portal, with `ask` answered by the test. */
function context(config: Record<string, unknown>, ask: (text: string, meta: any) => Promise<string>) {
  const controller = new AbortController();
  const asked: { text: string; meta: any }[] = [];
  return {
    controller,
    asked,
    ctx: { config, log() {}, signal: controller.signal, ask: async (text: string, meta: any) => (asked.push({ text, meta }), ask(text, meta)) },
  };
}

function platform(answer: (url: string, body: any) => unknown) {
  const posts: { url: string; body: any }[] = [];
  const real = { fetch: globalThis.fetch, WebSocket: (globalThis as any).WebSocket };
  FakeSocket.all = [];
  (globalThis as any).WebSocket = FakeSocket;
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    posts.push({ url: String(url), body });
    return json(answer(String(url), body));
  }) as any;
  return { posts, socket: () => FakeSocket.all.at(-1)!, restore: () => Object.assign(globalThis, { fetch: real.fetch, WebSocket: real.WebSocket }) };
}

const slackEvent = (event: Record<string, unknown>) => ({
  data: JSON.stringify({ envelope_id: `e-${Math.random()}`, type: "events_api", payload: { event: { type: "message", channel: "C1", user: "U1", ts: "1.1", text: "hello", ...event } } }),
});

async function slack(ask: (text: string, meta: any) => Promise<string>) {
  const api = platform((url) => (url.endsWith("auth.test") ? { ok: true, user: "bot", team: "T", user_id: "UBOT" } : url.endsWith("apps.connections.open") ? { ok: true, url: "wss://fake" } : { ok: true }));
  const { start } = await import("../channels/slack/index.js");
  const { ctx, controller, asked } = context({ appToken: "a", botToken: "b" }, ask);
  const channel = await start(ctx);
  const posted = () => api.posts.filter((p) => p.url.endsWith("chat.postMessage")).map((p) => p.body.text);
  return { api, asked, posted, socket: api.socket(), done: async () => (controller.abort(), await channel.stop(), api.restore()) };
}

test("what the portal answers on Slack is posted, with Progress off or on: the return value is the rest", async () => {
  const s = await slack(async () => "Stopped.");
  try {
    await s.socket.fire("message", slackEvent({ text: "stop" }));
    assert.deepEqual(s.posted(), ["Stopped."], "the portal's own word is returned, never relayed");
  } finally {
    await s.done();
  }
});

test("a mention Slack delivers twice runs the agent once, and what is not said to it does not run it at all", async () => {
  const s = await slack(async () => "");
  try {
    await s.socket.fire("message", slackEvent({ ts: "5.5", text: "<@UBOT> summarise the incident" }));
    await s.socket.fire("message", slackEvent({ ts: "5.5", type: "app_mention", text: "<@UBOT> summarise the incident" }));
    assert.equal(s.asked.length, 1, "message and app_mention for the same message are one turn");
    assert.equal(s.asked[0].text, "summarise the incident");

    await s.socket.fire("message", slackEvent({ ts: "6.6", subtype: "channel_join", text: "<@U2> has joined the channel" }));
    await s.socket.fire("message", slackEvent({ ts: "7.7", subtype: "message_changed", text: "edited" }));
    assert.equal(s.asked.length, 1, "somebody joining, or a message edited, is not something said to the agent");

    await s.socket.fire("message", slackEvent({ ts: "8.8", subtype: "file_share", text: "here is the log" }));
    await s.socket.fire("message", slackEvent({ ts: "9.9", subtype: "thread_broadcast", text: "also for the channel" }));
    assert.equal(s.asked.length, 3);

    // Another channel's message at the same moment is its own.
    await s.socket.fire("message", slackEvent({ ts: "5.5", channel: "C2", text: "same instant elsewhere" }));
    assert.equal(s.asked.length, 4);
  } finally {
    await s.done();
  }
});

test("what the portal answers on Discord is posted too", async () => {
  const api = platform((url) => (url.endsWith("/users/@me") ? { id: "BOT", username: "bot" } : url.endsWith("/gateway/bot") ? { url: "wss://gw" } : {}));
  const { start } = await import("../channels/discord/index.js");
  const { ctx, controller } = context({ botToken: "t" }, async () => "I only talk to people I have been introduced to.");
  const channel = await start(ctx);
  try {
    const socket = api.socket();
    await socket.fire("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 1e9 } }) });
    await socket.fire("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 1, d: { content: "hello", channel_id: "c1", author: { id: "u1", username: "kim" }, mentions: [] } }) });
    const said = api.posts.filter((p) => p.url.endsWith("/channels/c1/messages")).map((p) => p.body.content);
    assert.deepEqual(said, ["I only talk to people I have been introduced to."]);
  } finally {
    controller.abort();
    await channel.stop();
    api.restore();
  }
});

test("stopping the webhook does not wait for the turn of a request that is still open, and tells it", async () => {
  const { createServer } = await import("node:net");
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as any;
      probe.close(() => resolve(port));
    });
  });
  const { start } = await import("../channels/webhook/index.js");
  // An agent turn that takes as long as it likes.
  const { ctx, controller, asked } = context({ secret: "s3cret", port }, () => new Promise(() => {}));
  const channel = await start(ctx);
  const request = fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "x-portal-secret": "s3cret" }, body: JSON.stringify({ message: "run the report", from: { id: "ci" } }) });
  while (!asked.length) await sleep(5);

  controller.abort();
  // Unref'd: once the channel has stopped, the 3 s left to it would hold the file open after its tests.
  const stopped = await Promise.race([channel.stop().then(() => "stopped"), new Promise((resolve) => setTimeout(resolve, 3000, "still waiting").unref())]);
  assert.equal(stopped, "stopped", "the channel stops without waiting for the agent");
  const answer = await request;
  assert.equal(answer.status, 503, "the caller is told the channel is stopping");
  assert.match((await answer.json()).error, /stopping/);
});

/**
 * A signal-cli daemon, as its HTTP endpoints answer: JSON-RPC calls answered
 * by the test, and an event stream the test writes into.
 */
function signalDaemon(answer: (method: string, params: any) => unknown = () => ({})) {
  const rpc: { method: string; params: any }[] = [];
  const streams: { url: URL; headers: any; push: (event: unknown) => void; beat: () => void }[] = [];
  const real = globalThis.fetch;
  let seq = 0;
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/v1/rpc") {
      const body = JSON.parse(init.body);
      rpc.push({ method: body.method, params: body.params });
      try {
        // As fetch does: a call that is aborted ends, whatever it was waiting for.
        const aborted = new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
        aborted.catch(() => {});
        const result = await Promise.race([answer(body.method, body.params), aborted]);
        return json({ jsonrpc: "2.0", id: body.id, result });
      } catch (e: any) {
        if (e.name === "AbortError") throw e;
        return json({ jsonrpc: "2.0", id: body.id, error: { code: e.code ?? -1, message: e.message } });
      }
    }
    if (u.pathname === "/api/v1/events") {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (stream = c) });
      init.signal?.addEventListener("abort", () => {
        try {
          stream.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        } catch {}
      });
      // As signal-cli writes them: an id, the event's name, the message as its data, and a keep-alive between.
      const push = (event: unknown) => stream.enqueue(new TextEncoder().encode(`:\nid:${++seq}\nevent:receive\ndata:${JSON.stringify(event)}\n\n`));
      // signal-cli's keep-alive, which it writes every fifteen seconds.
      const beat = () => stream.enqueue(new TextEncoder().encode(":\n"));
      streams.push({ url: u, headers: init.headers, push, beat });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("", { status: 404 });
  }) as any;
  return {
    rpc,
    sent: () => rpc.filter((c) => c.method === "send").map((c) => c.params),
    streams,
    connected: async () => {
      while (!streams.length) await sleep(5);
      return streams.at(-1)!;
    },
    restore: () => (globalThis.fetch = real),
  };
}

const until = async (done: () => unknown, what: string) => {
  for (let i = 0; i < 400 && !done(); i++) await sleep(5);
  assert.ok(done(), what);
};

const ME = "+15550000001";
const KIM = "+15550000002";

/** The Signal package started against a daemon that holds `accounts`, with what the test sets of its fields. */
async function signal(config: Record<string, unknown>, ask: (text: string, meta: any) => Promise<string>, answer?: (method: string, params: any) => unknown, kept: { value?: unknown } = {}) {
  const daemon = signalDaemon((method, params) => {
    const given = answer?.(method, params);
    if (given !== undefined) return given;
    if (method === "listAccounts") return [{ number: ME, aci: "aci-me" }];
    if (method === "send") return { timestamp: 1 };
    return {};
  });
  const { start } = await import("../channels/signal/index.js");
  const { ctx, controller, asked } = context({ url: "http://signal-cli:8080", account: ME, ...config }, ask);
  const logged: string[] = [];
  const pairings: unknown[] = [];
  // What the portal keeps for the channel between starts, here in memory.
  const state = { get: () => kept.value, set: (value: unknown) => void (kept.value = value) };
  const channel = await start({ ...ctx, log: (line: string) => logged.push(line), showPairing: (p: unknown) => pairings.push(p), state });
  return {
    daemon,
    kept,
    asked,
    logged,
    pairings,
    channel,
    done: async () => {
      controller.abort();
      await channel.stop();
      daemon.restore();
    },
  };
}

const dm = (from: string, message: string, extra: Record<string, unknown> = {}) => ({
  account: ME,
  envelope: { source: from, sourceNumber: from, sourceUuid: `uuid-${from}`, sourceName: "Kim", sourceDevice: 1, timestamp: Date.now(), dataMessage: { timestamp: Date.now(), message, ...extra } },
});

test("a Signal message from somebody allowed is its own conversation, by their account id, and a long answer comes back in pieces Signal takes", async () => {
  const s = await signal({ allowedSenders: `${KIM.slice(0, 5)} ${KIM.slice(5)}` }, async () => `${"wörd ".repeat(900)}\n${"x".repeat(2500)}`);
  try {
    const stream = await s.daemon.connected();
    assert.equal(stream.url.searchParams.get("account"), ME, "the stream is this account's");
    stream.push(dm(KIM, "hello"));
    await until(() => s.daemon.sent().length >= 5, "the reply went out");

    assert.equal(s.asked.length, 1);
    assert.equal(s.asked[0].text, "hello");
    assert.equal(s.asked[0].meta.session, `chat:uuid-${KIM}`);
    assert.deepEqual(s.asked[0].meta.from, { id: `uuid-${KIM}`, name: "Kim" }, "the account id, not the profile name, is who it is");
    const sent = s.daemon.sent();
    for (const p of sent) {
      assert.equal(p.account, ME);
      assert.deepEqual(p.recipient, [`uuid-${KIM}`]);
      // Signal's limit is in bytes: a piece of 2000 umlauted characters would be well over it.
      assert.ok(Buffer.byteLength(p.message) <= 2000, `a piece of ${Buffer.byteLength(p.message)} bytes`);
    }
    assert.equal(sent.map((p) => p.message).join("").replace(/\s/g, ""), `${"wörd".repeat(900)}${"x".repeat(2500)}`, "nothing lost between the pieces");
    assert.ok(sent[0].message.endsWith("wörd"), "broken between words where it can be");
  } finally {
    await s.done();
  }
});

test("on Signal a stranger is not answered at all and is named once, nor is what you write to somebody else from your phone; Note to Self is the agent", async () => {
  const s = await signal({}, async () => "noted");
  try {
    const stream = await s.daemon.connected();
    stream.push(dm("+15550000099", "hi, who is this?"));
    stream.push(dm("+15550000099", "hello?"));
    stream.push({ account: ME, envelope: { sourceNumber: KIM, sourceUuid: "u2", dataMessage: { message: "dinner?", groupInfo: { groupId: "Z3JvdXA=", groupName: "Family", type: "DELIVER" } } } });
    // You, on your phone, writing to Kim: a copy reaches every device of yours.
    stream.push({ account: ME, envelope: { sourceNumber: ME, sourceUuid: "aci-me", syncMessage: { sentMessage: { destinationNumber: KIM, destinationUuid: "u2", message: "see you at 8" } } } });
    // You, writing to yourself.
    stream.push({ account: ME, envelope: { sourceNumber: ME, sourceUuid: "aci-me", syncMessage: { sentMessage: { destinationNumber: ME, destinationUuid: "aci-me", message: "remind me to call the bank" } } } });
    await until(() => s.daemon.sent().length, "Note to Self was answered");

    assert.deepEqual(s.asked.map((a) => a.text), ["remind me to call the bank"]);
    assert.equal(s.asked[0].meta.session, `chat:${ME}`);
    assert.equal(s.asked[0].meta.from.id, ME);
    assert.deepEqual(s.daemon.sent(), [{ account: ME, noteToSelf: true, message: "noted" }], "the answer is a note to yourself, and nobody else heard a thing");
    const named = s.logged.filter((l) => l.includes("+15550000099"));
    assert.equal(named.length, 1, "the stranger is in the log once, for whoever wants to allow them");
    assert.match(named[0], /account id uuid-\+15550000099/, "with the id that the allow list and People know them by");
    assert.ok(s.logged.some((l) => l.includes("Z3JvdXA=") && l.includes("Family")), "so is the group, by its id");
  } finally {
    await s.done();
  }
});

test("an allowed Signal group is one conversation, whoever writes in it, and the answer goes to the group", async () => {
  const s = await signal({ allowedGroups: "Z3JvdXA=" }, async () => "on it");
  try {
    const stream = await s.daemon.connected();
    const inGroup = (from: string, uuid: string, message: string) => ({ account: ME, envelope: { sourceNumber: from, sourceUuid: uuid, sourceName: from, dataMessage: { message, groupInfo: { groupId: "Z3JvdXA=", groupName: "Ops", type: "DELIVER" } } } });
    stream.push(inGroup(KIM, "u2", "deploy the fix"));
    // A member who hides their number is known by their account id.
    stream.push(inGroup(undefined as any, "u3", "￼ can you check the logs?"));
    await until(() => s.daemon.sent().length >= 2, "both were answered");

    assert.deepEqual(s.asked.map((a) => a.meta.session), ["group:Z3JvdXA=", "group:Z3JvdXA="]);
    assert.deepEqual(s.asked.map((a) => a.meta.from.id), ["u2", "u3"]);
    assert.equal(s.asked[0].meta.title, "Ops");
    for (const p of s.daemon.sent()) assert.equal(p.groupId, "Z3JvdXA=");
  } finally {
    await s.done();
  }
});

test("a mention in a Signal message reads as the name it stands for", async () => {
  const s = await signal({ allowedSenders: KIM }, async () => "");
  try {
    const stream = await s.daemon.connected();
    stream.push(dm(KIM, "ask ￼ about it", { mentions: [{ name: "Sam", number: "+15550000003", start: 4, length: 1 }] }));
    await until(() => s.asked.length, "it was asked");
    assert.equal(s.asked[0].text, "ask @Sam about it");
  } finally {
    await s.done();
  }
});

test("pictures go both ways on Signal, and what is not one is said to be left out", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
  let showChart!: (picture: any) => Promise<void>;
  const s = await signal({ allowedSenders: KIM }, async (_text, meta) => {
    showChart = () => meta.onPicture({ data: png, mimeType: "image/png", name: "sales chart.png", title: "Sales" });
    await showChart(null);
    return "Here it is.";
  }, (method, params) => (method === "getAttachment" ? (params.id === "a1" ? { data: png } : undefined) : undefined));
  try {
    const stream = await s.daemon.connected();
    stream.push(dm(KIM, "what is in this?", {
      attachments: [
        { id: "a1", contentType: "image/png", size: 11, filename: "photo.png" },
        { id: "a2", contentType: "audio/aac", size: 900, isVoiceNote: true },
        { id: "a3", contentType: "image/jpeg", size: 6 * 1024 * 1024, filename: "huge.jpg" },
        // What a long text comes with: its words are the message already.
        { id: "lt1", contentType: "text/x-signal-plain", size: 3000 },
      ],
    }));
    await until(() => s.daemon.sent().length >= 3, "everything went out");

    assert.deepEqual(s.daemon.rpc.filter((c) => c.method === "getAttachment").map((c) => c.params.id), ["a1"], "only the picture it can take is fetched");
    assert.deepEqual(s.asked[0].meta.images, [{ data: png, mimeType: "image/png" }]);
    const [left, picture, words] = s.daemon.sent();
    assert.match(left.message, /left out a voice note, huge\.jpg\.$/);
    assert.deepEqual(picture.attachments, [`data:image/png;filename=sales_chart.png;base64,${png}`]);
    assert.equal(picture.message, "Sales");
    assert.equal(words.message, "Here it is.", "the words come after the picture they are about");
  } finally {
    await s.done();
  }
});

test("a number signal-cli does not have yet is linked with a code on the channel's page, a new one each time one runs out, and the code goes once scanned", async () => {
  let linked = false;
  let scan!: () => void;
  const scanned = new Promise<void>((resolve) => (scan = resolve));
  let codes = 0;
  const s = await signal({}, async () => "", (method) => {
    if (method === "listAccounts") return linked ? [{ number: ME, aci: "aci-me" }] : [];
    if (method === "startLink") return { deviceLinkUri: `sgnl://linkdevice?uuid=${++codes}&pub_key=k` };
    if (method === "finishLink") {
      if (codes === 1) throw new Error("Link request timed out, please try again.");
      return scanned.then(() => ((linked = true), { number: ME, aci: "aci-me" }));
    }
    return undefined;
  });
  try {
    await until(() => s.pairings.filter(Boolean).length === 2, "a second code after the first ran out");
    assert.deepEqual(s.pairings.map((p: any) => p?.code ?? null), ["sgnl://linkdevice?uuid=1&pub_key=k", null, "sgnl://linkdevice?uuid=2&pub_key=k"], "the one that ran out is taken off first");
    assert.match((s.pairings[0] as any).hint, /Linked devices/);
    const finish = s.daemon.rpc.find((c) => c.method === "finishLink")!;
    assert.equal(finish.params.deviceName, "Pithagoras");
    assert.equal(finish.params.account, undefined, "linking is the daemon's, not an account's");

    scan();
    await s.daemon.connected();
    assert.equal(s.pairings.at(-1), null, "the code is gone once it is used");
    assert.ok(s.logged.includes(`linked as ${ME}`));
  } finally {
    await s.done();
  }
});

test("a Signal number that the phone scanning the code does not have is not taken for it", async () => {
  let linked = false;
  const s = await signal({}, async () => "", (method) => {
    if (method === "listAccounts") return linked ? [{ number: "+15550000077", aci: "other" }] : [];
    if (method === "startLink") return { deviceLinkUri: "sgnl://linkdevice?uuid=1&pub_key=k" };
    if (method === "finishLink") return ((linked = true), { number: "+15550000077", aci: "other" });
    return undefined;
  });
  try {
    await until(() => s.logged.some((l) => l.includes("+15550000077")), "it says which number scanned it");
    assert.match(s.logged.find((l) => l.includes("+15550000077"))!, /not \+15550000001/);
    await sleep(30);
    assert.equal(s.daemon.rpc.some((c) => c.method === "send"), false);
  } finally {
    await s.done();
  }
});

test("a signal-cli daemon that is not there fails the start, so that it is tried again", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as any;
  try {
    const { start } = await import("../channels/signal/index.js");
    const { ctx } = context({ url: "http://127.0.0.1:1", account: ME }, async () => "");
    await assert.rejects(start(ctx), /Could not reach signal-cli at http:\/\/127\.0\.0\.1:1/);
  } finally {
    globalThis.fetch = real;
  }
});

test("the same person on Signal stays one person and one conversation when signal-cli learns their number", async () => {
  const s = await signal({ allowedSenders: "uuid-kim" }, async () => "ok");
  try {
    const stream = await s.daemon.connected();
    const kim = (sourceNumber: string | undefined, message: string) => ({ account: ME, envelope: { sourceNumber, sourceUuid: "uuid-kim", sourceName: "Kim", dataMessage: { message } } });
    stream.push(kim(undefined, "hidden number"));
    stream.push(kim(KIM, "now it shows"));
    await until(() => s.asked.length === 2, "both reached the agent");
    assert.deepEqual(s.asked.map((a) => [a.meta.session, a.meta.from.id]), [["chat:uuid-kim", "uuid-kim"], ["chat:uuid-kim", "uuid-kim"]]);
    // Allowed by number, the same person gets through whichever they show.
  } finally {
    await s.done();
  }
});

test("a long Signal message is taken as the text it is, without a word about the file it came with", async () => {
  const s = await signal({ allowedSenders: KIM }, async () => "read it");
  try {
    const stream = await s.daemon.connected();
    stream.push(dm(KIM, "ü".repeat(1500), { attachments: [{ contentType: "text/x-signal-plain", id: "lt1", size: 3000 }] }));
    await until(() => s.daemon.sent().length, "it was answered");
    assert.equal(s.asked[0].text, "ü".repeat(1500));
    assert.deepEqual(s.daemon.sent().map((p) => p.message), ["read it"]);
    assert.equal(s.daemon.rpc.some((c) => c.method === "getAttachment"), false);
  } finally {
    await s.done();
  }
});

test("Signal picks up after the last message it took in, across a restart, and only on the same daemon and number", async () => {
  const kept: { value?: unknown } = {};
  const first = await signal({ allowedSenders: KIM }, async () => "ok", undefined, kept);
  try {
    const stream = await first.daemon.connected();
    assert.equal(stream.headers["last-event-id"], undefined, "nothing to pick up after the first time");
    stream.push(dm(KIM, "one"));
    await until(() => first.asked.length, "it was taken in");
    assert.deepEqual(kept.value, { url: "http://signal-cli:8080", account: ME, lastEventId: "1" }, "kept before it is answered");
  } finally {
    await first.done();
  }

  const again = await signal({ allowedSenders: KIM }, async () => "ok", undefined, kept);
  try {
    assert.equal((await again.daemon.connected()).headers["last-event-id"], "1", "so that signal-cli replays what came while it was stopped");
  } finally {
    await again.done();
  }

  const other = await signal({ allowedSenders: KIM, url: "http://elsewhere:8080" }, async () => "ok", undefined, kept);
  try {
    assert.equal((await other.daemon.connected()).headers["last-event-id"], undefined, "another daemon's ids are not this one's");
  } finally {
    await other.done();
  }
});

test("a daemon that runs for another number than the channel's says so, rather than taking in nothing without a word", async () => {
  const s = await signal({ allowedSenders: "*" }, async () => "ok", (method) => {
    if (method === "listAccounts") throw Object.assign(new Error("Method not implemented"), { code: -32601 });
    return undefined;
  });
  try {
    const stream = await s.daemon.connected();
    stream.push({ ...dm(KIM, "hello"), account: "+15550000042" });
    stream.push({ ...dm(KIM, "hello again"), account: "+15550000042" });
    await until(() => s.logged.some((l) => l.includes("+15550000042")), "the daemon's number is named");
    assert.equal(s.logged.filter((l) => l.includes("+15550000042")).length, 1);
    assert.equal(s.asked.length, 0);
  } finally {
    await s.done();
  }
});

test("an expired Signal link code does not stay on the page while there is no new one", async () => {
  let starts = 0;
  const s = await signal({}, async () => "", (method) => {
    if (method === "listAccounts") return [];
    if (method === "startLink") {
      if (++starts > 1) throw new Error("signal-cli is restarting");
      return { deviceLinkUri: "sgnl://linkdevice?uuid=1&pub_key=k" };
    }
    if (method === "finishLink") throw new Error("Link request timed out, please try again.");
    return undefined;
  });
  try {
    await until(() => s.logged.some((l) => l.includes("restarting")), "the next code could not be made");
    assert.equal(s.pairings.at(-1), null, "the old code is gone");
  } finally {
    await s.done();
  }
});

test("a Signal stream that goes quiet is opened again after a minute, rather than waited on for half an hour", async (t) => {
  // Only setTimeout is the test's: what the fake daemon and the stream need runs on immediates.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const s = await signal({}, async () => "");
  try {
    await settle();
    assert.equal(s.daemon.streams.length, 1);
    // A keep-alive is something heard: the minute starts again.
    t.mock.timers.tick(50_000);
    s.daemon.streams[0].beat();
    await settle();
    t.mock.timers.tick(50_000);
    await settle();
    assert.equal(s.daemon.streams.length, 1, "a stream that keeps beating is left alone");
    assert.equal(s.logged.some((l) => l.startsWith("lost connection")), false);

    t.mock.timers.tick(11_000);
    await settle();
    assert.ok(s.logged.includes("lost connection: nothing came from signal-cli for a minute"), s.logged.join("\n"));
    t.mock.timers.tick(5_000);
    await settle();
    assert.equal(s.daemon.streams.length, 2, "and it is opened again");
  } finally {
    await s.done();
  }
});

test("what signal-cli replays from more than a day ago is taken as read but not answered, and said in one line", async () => {
  const s = await signal({ allowedSenders: KIM }, async () => "ok");
  try {
    const stream = await s.daemon.connected();
    const old = (message: string, daysAgo: number) => {
      const event = dm(KIM, message);
      Object.assign(event.envelope, { serverReceivedTimestamp: Date.now() - daysAgo * 24 * 60 * 60_000 });
      return event;
    };
    stream.push(old("please delete the old branch", 3));
    stream.push(old("and the tag", 2));
    stream.push(dm(KIM, "good morning"));
    // Sent now from a phone whose clock is two days behind: the server's time is what counts.
    const behind = dm(KIM, "my clock is wrong");
    Object.assign(behind.envelope, { timestamp: Date.now() - 2 * 24 * 60 * 60_000, serverReceivedTimestamp: Date.now() });
    stream.push(behind);
    await until(() => s.logged.some((l) => l.startsWith("skipped")) && s.asked.length === 2, "the skipped ones are named");
    assert.deepEqual(s.asked.map((a) => a.text), ["good morning", "my clock is wrong"], "only what is recent reaches the agent");
    assert.ok(s.logged.includes("skipped 2 messages older than a day, which came while this channel was not reading"));
    assert.equal((s.kept.value as any).lastEventId, "4", "nor are they replayed again");
  } finally {
    await s.done();
  }
});
