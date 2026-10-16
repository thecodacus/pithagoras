/**
 * Signal, through a signal-cli daemon.
 *
 * Signal has no bot API: an account is a phone number, and a program that
 * speaks for it is a device of that account like any phone. signal-cli is
 * such a device, and its daemon answers JSON-RPC over HTTP — POST
 * /api/v1/rpc to send, and a stream of server-sent events at /api/v1/events
 * for what arrives — so this needs `fetch` and nothing else.
 *
 * The daemon is one you run, not one the portal runs for you. It keeps the
 * account's keys, which are as good as the phone itself: they stay on the
 * machine that runs it and never pass through the portal, let alone the
 * browser. And the portal image stays without Java or signal-cli's own
 * 400 MB build.
 *
 * Either kind of account works. A number of the agent's own, registered with
 * signal-cli beforehand, or your own: then the portal links itself to it as a
 * second device, with a code shown on the channel's page, and writes as you.
 */

export const manifest = {
  id: "signal",
  label: "Signal",
  blurb: "Message a Signal number; its replies come back in the same chat. Needs a signal-cli daemon.",
  fields: [
    {
      key: "url",
      label: "signal-cli daemon",
      required: true,
      hint: "Where `signal-cli daemon --http` listens. It has no password: keep it on this machine or a private network.",
      placeholder: "http://127.0.0.1:8080",
    },
    {
      key: "account",
      label: "Signal number",
      required: true,
      hint: "The number the agent writes as, with its country code: one registered for it, or your own to link the portal to.",
      placeholder: "+15551234567",
    },
    {
      key: "allowedSenders",
      label: "Allowed senders",
      hint: "Numbers or Signal account ids, comma separated, that may write to the agent. Anybody else is ignored without an answer. * lets everybody through to Settings → People: only for a number of the agent's own.",
      placeholder: "+15557654321",
    },
    {
      key: "allowedGroups",
      label: "Allowed groups",
      hint: "Group ids, comma separated, where the agent reads and answers every message. The activity below names a group that wrote while not allowed.",
      placeholder: "aGVsbG8gd29ybGQ…=",
    },
    {
      key: "deviceName",
      label: "Device name",
      hint: "What your phone lists the portal as once it is linked. Only for linking.",
      placeholder: "Pithagoras",
    },
  ],
};

/**
 * Signal carries 2000 bytes of a message's text inline, in UTF-8, and the
 * whole of a longer one as a file beside it: so a reply is split there
 * instead. Bytes, not characters: a line of umlauts or emoji is two to four
 * times as long.
 */
const MAX_TEXT_BYTES = 2000;
/** The file a long text comes with, whose words signal-cli has already put in the message. */
const LONG_TEXT = "text/x-signal-plain";
/** What the portal takes as a picture with a message. */
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
/** Methods of the daemon as a whole, which take no account. */
const DAEMON_METHODS = new Set(["listAccounts", "startLink", "finishLink", "version"]);
/** A line of the event stream longer than this is no event signal-cli sends: attachments are fetched apart. */
const MAX_EVENT = 4 * 1024 * 1024;
/**
 * signal-cli writes a keep-alive to the stream every fifteen seconds unless it
 * is told otherwise. A minute with nothing at all is a connection that went
 * away without saying so — a host that lost power, a NAT that forgot it — and
 * is opened again rather than waited on for the half hour before fetch gives up.
 */
const STREAM_QUIET_MS = 60_000;
/**
 * How old a message may be and still be answered. What signal-cli replays
 * after a restart can be days old on a quiet number; an answer to that, or a
 * request acted on long after the people who made it moved on, is worse than
 * none. Telegram keeps a bot's backlog for a day, and so does this.
 */
const MAX_AGE_MS = 24 * 60 * 60_000;
/** Signal's typing indicator goes after fifteen seconds; a run takes minutes. */
const TYPING_EVERY_MS = 10_000;

/** A connection that failed to open is worth another go; a rejected one is not. */
const transient = (e) =>
  e?.name === "TypeError" ||
  /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(
    `${e?.message ?? ""} ${e?.cause?.code ?? ""}`
  );

/** An error the daemon answered with, as opposed to one on the way to it. */
class DaemonError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** JSON-RPC's "no such method": what a daemon for one account answers for the ones for several. */
const NOT_FOUND = -32601;

/** A phone number as Signal writes it: + and digits, whatever spaces or dashes it was typed with. */
const number = (s) => String(s ?? "").replace(/[\s().-]/g, "");

/** A comma separated list from a field. Numbers lose their spacing; account ids their case. */
const list = (s) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith("+") ? number(x) : x));

const sameId = (a, b) => Boolean(a && b) && (a.startsWith("+") ? a === b : a.toLowerCase() === b.toLowerCase());

/** Waits, or less once the channel is being stopped. */
const pause = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export async function start(ctx) {
  const base = String(ctx.config.url ?? "").trim().replace(/\/+$/, "");
  const account = number(ctx.config.account);
  const senders = list(ctx.config.allowedSenders);
  const groups = list(ctx.config.allowedGroups);
  const deviceName = String(ctx.config.deviceName ?? "").trim() || "Pithagoras";
  if (!/^https?:\/\/[^/]/i.test(base)) throw new Error("The daemon's address starts with http:// or https://");
  if (!/^\+\d{6,15}$/.test(account)) throw new Error("The Signal number needs its country code, as in +15551234567");

  /**
   * Whether the daemon holds several accounts, and so has to be told which
   * one each call is for. One started for a single account (`-a`) answers
   * for that one and knows no other.
   */
  let several = true;
  /** This account's id beside its number: what a message from one of its own devices carries when the number is hidden. */
  let aci = null;
  let nextId = 1;

  /** Retries the connection, not the request, as the Telegram package does. */
  async function call(method, params = {}, attempts = 3) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${base}/api/v1/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: nextId++,
            method,
            params: several && !DAEMON_METHODS.has(method) ? { account, ...params } : params,
          }),
          signal: ctx.signal,
        });
        if (!res.ok) throw new Error(refusal(res.status));
        const data = await res.json();
        if (data.error) throw new DaemonError(data.error.message || `${method} failed`, data.error.code);
        return data.result;
      } catch (e) {
        if (ctx.signal.aborted || attempt >= attempts || !transient(e)) throw e;
        await pause(400 * attempt, ctx.signal);
      }
    }
  }

  let accounts;
  try {
    accounts = await call("listAccounts");
  } catch (e) {
    if (!(e instanceof DaemonError && e.code === NOT_FOUND)) {
      throw new Error(`Could not reach signal-cli at ${base}: ${e.message}`);
    }
    several = false;
  }
  const own = several ? (accounts ?? []).find((a) => a?.number === account) : undefined;
  aci = own?.aci ?? null;
  // A daemon for one account is for this one: there is nothing to link.
  const linking = several && !own;
  ctx.log(linking ? `${account} is not set up in signal-cli: link it with the code on this page` : `connected as ${account}`);
  if (!senders.length && !groups.length) {
    ctx.log("nobody is allowed to write yet: only Note to Self reaches the agent");
  }

  /** Who has been ignored since this start, so that the log names each once rather than every message. */
  const ignored = new Set();
  /** What goes out, per chat, in the order it was said: pieces of a reply and the pictures between them. */
  const outgoing = new Map();
  const typing = new Set();

  const isMe = (num, uuid) => num === account || (Boolean(aci) && sameId(uuid, aci));

  /**
   * The last event of the stream seen, to pick up after. Kept across starts
   * for the last message taken in: signal-cli goes on receiving while nobody
   * reads its stream, and replays what came after an id it is given — but only
   * one it is given, so a restart that forgot it would never read what arrived
   * meanwhile. Only for the same daemon and number: another one's ids are not
   * this one's.
   */
  const kept = (() => {
    try {
      return ctx.state?.get();
    } catch {
      return undefined;
    }
  })();
  let lastId = kept?.url === base && kept?.account === account && typeof kept?.lastEventId === "string" ? kept.lastEventId : undefined;
  let keepFailed = false;
  /** Replayed messages too old to answer, waiting to be told of in one line. */
  let stale = 0;
  let staleTimer;

  const loop = (async () => {
    if (linking && !(await link())) return;
    await receive();
  })().catch((e) => {
    if (!ctx.signal.aborted) ctx.log(`stopped: ${e.message}`);
  });

  return {
    async stop() {
      for (const timer of typing) clearInterval(timer);
      typing.clear();
      clearTimeout(staleTimer);
      await loop;
    },

    /**
     * Send without being asked — how a routine reports back. The target is
     * the conversation key handed to ctx.ask.
     */
    async send(target, text) {
      await queue(target, () => sendText(targetOf(target), text));
    },
  };

  /**
   * Link the portal to the account as a new device.
   *
   * signal-cli makes a code for it, which the phone scans; the daemon waits
   * two minutes for that and then gives up, so a fresh code is made for as
   * long as nobody has scanned one. False when it did not happen.
   */
  async function link() {
    while (!ctx.signal.aborted) {
      let uri;
      try {
        uri = (await call("startLink"))?.deviceLinkUri;
        if (typeof uri !== "string" || !uri) throw new Error("signal-cli gave no code to link with");
      } catch (e) {
        if (ctx.signal.aborted) return false;
        // The code on the page has run out: nobody should scan it while there is no other.
        ctx.showPairing?.(null);
        ctx.log(`could not start linking: ${e.message}`);
        await pause(30_000, ctx.signal);
        continue;
      }
      ctx.showPairing?.({
        code: uri,
        hint:
          `Open Signal on the phone with ${account}, go to Settings → Linked devices → Link new device, and scan this code. ` +
          `The portal then reads your messages and writes as you. A new code comes every two minutes until one is scanned.`,
      });
      try {
        await call("finishLink", { deviceLinkUri: uri, deviceName }, 1);
      } catch (e) {
        if (ctx.signal.aborted) return false;
        // Nobody scanned it in time: the next code. Taken off the page at once,
        // as a phone that scans it now is refused.
        if (/timed out/i.test(e.message)) {
          ctx.showPairing?.(null);
          continue;
        }
        ctx.showPairing?.(null);
        ctx.log(`linking failed: ${e.message}`);
        await pause(30_000, ctx.signal);
        continue;
      }
      ctx.showPairing?.(null);
      const now = (await call("listAccounts").catch(() => [])) ?? [];
      const mine = now.find((a) => a?.number === account);
      if (!mine) {
        // The phone that scanned it is another number's. Answering as that one
        // would be answering as somebody this channel was not set up for.
        const other = now.find((a) => !(accounts ?? []).some((b) => b?.number === a?.number))?.number;
        ctx.log(`the code was scanned by ${other ?? "another account"}, not ${account}: put that number in Signal number and save`);
        return false;
      }
      aci = mine.aci ?? null;
      ctx.log(`linked as ${account}`);
      return true;
    }
    return false;
  }

  /**
   * Follow the event stream for as long as the channel runs.
   *
   * One line when it drops and one when it is back, rather than one every
   * few seconds while it is away. The daemon keeps its last thousand events,
   * and picking up after the last one seen means a message that came while
   * the connection was down is not lost.
   */
  async function receive() {
    let offline = false;
    while (!ctx.signal.aborted) {
      const quiet = new AbortController();
      let timer;
      const awake = () => {
        clearTimeout(timer);
        timer = setTimeout(() => quiet.abort(), STREAM_QUIET_MS);
      };
      try {
        awake();
        const res = await fetch(`${base}/api/v1/events?account=${encodeURIComponent(account)}`, {
          headers: { accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) },
          signal: AbortSignal.any([ctx.signal, quiet.signal]),
        });
        if (!res.ok || !res.body) throw new Error(refusal(res.status, true));
        if (offline) {
          offline = false;
          ctx.log("connection back");
        }
        for await (const event of events(res.body, awake)) {
          if (event.id) lastId = event.id;
          if (event.data) take(event.data, event.id);
        }
        throw new Error("the daemon closed the event stream");
      } catch (e) {
        if (ctx.signal.aborted) return;
        if (!offline) {
          offline = true;
          ctx.log(`lost connection: ${quiet.signal.aborted ? "nothing came from signal-cli for a minute" : e.message}`);
        }
        await pause(5000, ctx.signal);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** Where to pick up after a restart: written before the message is handed on, so that a crash loses it rather than answering it twice. */
  function keep(id) {
    if (!id || !ctx.state) return;
    try {
      ctx.state.set({ url: base, account, lastEventId: id });
    } catch (e) {
      if (keepFailed) return;
      keepFailed = true;
      ctx.log(`could not keep where the stream was: ${e.message}`);
    }
  }

  /** One event from the stream: a message for the agent, or something it has no business with. */
  function take(raw, id) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    // The stream carries what a JSON-RPC notification has as its params.
    const params = event?.params ?? event;
    if (params?.account && params.account !== account) {
      // A daemon for one account sends that one's, whatever it is asked for.
      noteIgnored(`account:${params.account}`, `ignored messages for ${params.account}: signal-cli runs for that number, not ${account}. Put the daemon's number in Signal number and save`);
      return;
    }
    const message = read(params?.envelope);
    if (!message) return;
    keep(id);
    // Taken as read, so that it is not replayed again, but not answered. Aged
    // by when Signal's server took it in: the sender's own timestamp is their
    // device's clock, and one a few days behind would never be answered.
    const sent = Number(params.envelope.serverReceivedTimestamp ?? params.envelope.timestamp);
    if (Number.isFinite(sent) && sent > 0 && Date.now() - sent > MAX_AGE_MS) {
      stale++;
      // Counted, and said once the replay is through, rather than a line for each.
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        ctx.log(`skipped ${stale} ${stale === 1 ? "message" : "messages"} older than a day, which came while this channel was not reading`);
        stale = 0;
      }, 1000);
      if (typeof staleTimer.unref === "function") staleTimer.unref();
      return;
    }
    // Deliberately not awaited: a `stop` is the next message, and it has to be
    // read while the run it stops is going. The portal keeps each chat's
    // messages in order.
    void handle(message);
  }

  /**
   * What an envelope says, if it is something said to the agent by somebody
   * allowed to: receipts, typing, reactions, edits and group changes are not.
   */
  function read(envelope) {
    if (!envelope || typeof envelope !== "object") return null;
    const fromMe = isMe(envelope.sourceNumber, envelope.sourceUuid);
    let data;
    if (!fromMe && envelope.dataMessage) {
      data = envelope.dataMessage;
    } else if (fromMe && envelope.syncMessage?.sentMessage) {
      // On a linked account, what you write on your phone reaches this device
      // too, as a copy. Only Note to Self and an allowed group are for the
      // agent: everything else is your conversations with other people.
      data = envelope.syncMessage.sentMessage;
      if (!data.groupInfo?.groupId && !isMe(data.destinationNumber, data.destinationUuid)) return null;
    } else {
      return null;
    }

    const text = withMentions(typeof data.message === "string" ? data.message : "", data.mentions).trim();
    const attachments = Array.isArray(data.attachments)
      ? data.attachments.filter((a) => a && typeof a.id === "string" && a.contentType !== LONG_TEXT)
      : [];
    if (!text && !attachments.length) return null;

    // The sender is their Signal account id. Not their number: signal-cli
    // knows that only once they show it or it is looked up, and the same
    // person would then become somebody else, with a conversation of their
    // own; nor does it survive a change of number. And never the profile
    // name, which anybody can set to anything. You are this channel's number.
    const sender = fromMe ? account : envelope.sourceUuid || envelope.sourceNumber;
    if (typeof sender !== "string" || !sender) return null;
    const from = { id: sender, name: envelope.sourceName || envelope.sourceNumber || sender };

    const groupId = typeof data.groupInfo?.groupId === "string" ? data.groupInfo.groupId : "";
    if (groupId) {
      if (!allowed(groups, [groupId])) {
        noteIgnored(`group:${groupId}`, `ignored a message in the group ${data.groupInfo.groupName ? `“${data.groupInfo.groupName}” ` : ""}(${groupId}): add its id to Allowed groups to answer there`);
        return null;
      }
      return { key: `group:${groupId}`, title: data.groupInfo.groupName || "Signal group", target: { groupId }, from, text, attachments };
    }
    if (fromMe) {
      return { key: `chat:${account}`, title: "Note to Self", target: { self: true }, from, text, attachments };
    }
    if (!allowed(senders, [envelope.sourceNumber, envelope.sourceUuid])) {
      const who = envelope.sourceNumber && envelope.sourceNumber !== sender ? `${envelope.sourceNumber} (account id ${sender})` : sender;
      noteIgnored(`chat:${sender}`, `ignored a message from ${who}: add it to Allowed senders to let it through`);
      return null;
    }
    return { key: `chat:${sender}`, title: envelope.sourceName || sender, target: { recipient: sender }, from, text, attachments };
  }

  function allowed(entries, ids) {
    if (entries.includes("*")) return true;
    return ids.some((id) => typeof id === "string" && entries.some((entry) => sameId(entry, id)));
  }

  function noteIgnored(key, line) {
    if (ignored.has(key)) return;
    ignored.add(key);
    ctx.log(line);
  }

  async function handle({ key, title, target, from, text, attachments }) {
    const say = (body) => queue(key, () => sendText(target, body));

    // Pictures go to the agent; anything else is said to be left out rather
    // than quietly dropped, so that nobody waits for an answer about it.
    const images = [];
    const left = [];
    for (const a of attachments) {
      const name = a.filename || (a.isVoiceNote ? "a voice note" : a.contentType || "a file");
      if (!PICTURE_TYPES.has(a.contentType) || a.isVoiceNote || Number(a.size) > MAX_PICTURE_BYTES) {
        left.push(name);
        continue;
      }
      try {
        const got = await call("getAttachment", { id: a.id, ...(target.groupId ? { groupId: target.groupId } : { recipient: from.id }) });
        const data = typeof got === "string" ? got : got?.data;
        if (typeof data !== "string" || !data) throw new Error("no data");
        images.push({ data, mimeType: a.contentType });
      } catch (e) {
        ctx.log(`could not fetch a picture from ${key}: ${e.message}`);
        left.push(name);
      }
    }
    if (left.length) {
      await say(`I can only take pictures here (PNG, JPEG, GIF or WebP, up to 5 MB), so I left out ${left.join(", ")}.`).catch(() => {});
    }
    if (!text && !images.length) return;

    const typer = target.self ? null : startTyping(target);
    try {
      // The chat is the conversation and the sender is the person: in a group
      // those differ every message.
      const reply = await ctx.ask(text, {
        session: key,
        title,
        from,
        ...(images.length ? { images } : {}),
        onReply: say,
        onPicture: (picture) => queue(key, () => sendAttachment(target, picture)),
        onVideo: (video) => queue(key, () => sendAttachment(target, video)),
      });
      // Non-empty only when the portal was not relaying as it went.
      if (reply) await say(reply);
    } catch (e) {
      ctx.log(`failed to answer ${key}: ${e.message}`);
      await say(
        transient(e) ? "I lost my connection for a moment and did not get that. Try again." : `Something went wrong: ${e.message}`
      ).catch(() => {});
    } finally {
      if (typer) {
        clearInterval(typer);
        typing.delete(typer);
        void call("sendTyping", { ...to(target), stop: true }, 1).catch(() => {});
      }
    }
  }

  /** Shows the agent at work for as long as it is, since one indicator lasts seconds and a run minutes. */
  function startTyping(target) {
    const tick = () => void call("sendTyping", to(target), 1).catch(() => {});
    tick();
    const timer = setInterval(tick, TYPING_EVERY_MS);
    if (typeof timer.unref === "function") timer.unref();
    typing.add(timer);
    return timer;
  }

  /** In order per chat: the pieces of one reply arrive as they were said, a picture where it was shown. */
  function queue(key, job) {
    const next = (outgoing.get(key) ?? Promise.resolve()).catch(() => {}).then(job);
    outgoing.set(key, next);
    void next.catch(() => {}).finally(() => {
      if (outgoing.get(key) === next) outgoing.delete(key);
    });
    return next;
  }

  async function sendText(target, text) {
    for (const chunk of split(String(text ?? ""), MAX_TEXT_BYTES)) {
      await call("send", { ...to(target), message: chunk });
    }
  }

  async function sendAttachment(target, file) {
    const name = String(file.name ?? "file").replace(/[^\w.-]+/g, "_") || "file";
    await call("send", {
      ...to(target),
      message: file.title ?? "",
      attachments: [`data:${file.mimeType};filename=${name};base64,${file.data}`],
    });
  }

  /** The conversation key handed to ctx.ask, back as somewhere to send to. */
  function targetOf(key) {
    const k = String(key);
    if (k.startsWith("group:")) return { groupId: k.slice(6) };
    const recipient = k.replace(/^chat:/, "");
    return recipient === account ? { self: true } : { recipient };
  }

  function to(target) {
    if (target.self) return { noteToSelf: true };
    if (target.groupId) return { groupId: target.groupId };
    return { recipient: [target.recipient] };
  }
}

/** What an HTTP status from the daemon means for whoever reads the log. */
function refusal(status, stream = false) {
  // Bound to localhost, signal-cli answers only to the names localhost has.
  if (status === 421) return "the daemon refused the host name it was reached by: it answers other names only when it listens on 0.0.0.0";
  // The stream's answer for an account it does not have.
  if (stream && status === 400) return "the daemon does not know this account";
  return `the daemon answered ${status}`;
}

/**
 * A mention is a placeholder character in the text, with who it stands for
 * beside it. Written back as @name, so that the agent can read who was meant.
 */
function withMentions(text, mentions) {
  if (!Array.isArray(mentions) || !mentions.length) return text;
  let out = text;
  for (const m of [...mentions].sort((a, b) => (b?.start ?? 0) - (a?.start ?? 0))) {
    const start = Number(m?.start);
    const length = Number(m?.length) || 1;
    if (!Number.isInteger(start) || start < 0 || start > out.length) continue;
    out = `${out.slice(0, start)}@${m.name || m.number || m.uuid || "somebody"}${out.slice(start + length)}`;
  }
  return out;
}

/** Server-sent events from a response body: each with its id and its data lines joined. `heard` is told of every chunk, keep-alives included. */
async function* events(body, heard = () => {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let id;
  let data = [];
  for await (const chunk of body) {
    heard();
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "") {
        if (data.length) yield { id, data: data.join("\n") };
        id = undefined;
        data = [];
        continue;
      }
      // A comment: the daemon's keep-alive.
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (buffer.length > MAX_EVENT) throw new Error("the event stream sent a line too long to be an event");
  }
}

/** Pieces of at most `size` bytes in UTF-8, broken at a line or a space where there is one near the end. */
function split(text, size) {
  const out = [];
  let rest = text;
  while (Buffer.byteLength(rest) > size) {
    // The longest start that fits, by whole characters: an emoji is not cut in two.
    let fit = 0;
    let bytes = 0;
    for (const ch of rest) {
      const n = Buffer.byteLength(ch);
      if (bytes + n > size) break;
      bytes += n;
      fit += ch.length;
    }
    let cut = rest.lastIndexOf("\n", fit);
    if (cut < fit / 2) cut = rest.lastIndexOf(" ", fit);
    if (cut < fit / 2) cut = fit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^[ \n]+/, "");
  }
  if (rest || !out.length) out.push(rest);
  return out;
}
