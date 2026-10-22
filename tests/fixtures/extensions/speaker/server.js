/**
 * The Speaker extension's server half: a voice provider for the portal's tests. It recognises and speaks in its own
 * process, with no service behind it, and offers that to voice mode with `portal.voice.provide`. Its routes say what it
 * was asked and told, and change what it answers, as a real one's engines coming and going would:
 *
 *   GET  /api/x/test-speaker/state      { uses, heard, spoken, aborted, cancelled }: each `use` it was told, each
 *                                       recording heard ({ purpose, bytes }), each phrase asked for ({ text, voice },
 *                                       voice null for none), the signals it was given that ended, and the answers
 *                                       whose body was cancelled
 *   PUT  /api/x/test-speaker/settings   { ready?, speaks?, voices?, answer?, stateThrows?, stateAnswers?, fails?, hangs? }:
 *                                       whether `state` answers, whether it speaks, the voices it offers, what `speak`
 *                                       answers ("pcm", "pcm48k", "wav", "wav22k", "text", "notOk", "notResponse",
 *                                       "throws", or "hangs", which `transcribe` does too), whether `state` throws, what
 *                                       it answers in place of its own (null for its own), and whether `use(true)` fails
 *                                       or never settles
 *   POST /api/x/test-speaker/choose     { chosen }: `portal.voice.choose`
 *   GET  /api/x/test-speaker/chosen     { chosen }: `portal.voice.chosen`
 *
 * Each `use` it was told is also kept in `globalThis.speakerTold`, as "<package>#<instance> <inUse>", where the
 * instance counts the server halves started in the process: so that what a half that has stopped since was told can
 * still be read.
 */

/** Two samples of mono 16-bit PCM. */
const PCM = Buffer.from([0, 0, 255, 127]);

/** A phrase as a speech engine that answers with a WAV gives it: mono, 16-bit, two samples, at `rate`. */
function wav(rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + PCM.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(PCM.length, 40);
  return Buffer.concat([header, PCM]);
}

export default function (portal) {
  const instance = (globalThis.speakerInstances = (globalThis.speakerInstances ?? 0) + 1);
  const told = (globalThis.speakerTold ??= []);
  const asked = { uses: [], heard: [], spoken: [], aborted: 0, cancelled: 0 };
  const settings = {
    ready: true,
    speaks: true,
    voices: [{ id: "speaker-warm", name: "Warm" }],
    answer: "pcm",
    stateThrows: false,
    stateAnswers: null,
    fails: false,
    hangs: false,
  };
  /** A body whose cancelling is counted. */
  const body = (bytes) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
    const cancel = stream.cancel.bind(stream);
    stream.cancel = (reason) => {
      asked.cancelled++;
      return cancel(reason);
    };
    return stream;
  };
  /** The signal of a call, counted when it ends. */
  const watch = (signal) => signal.addEventListener("abort", () => asked.aborted++, { once: true });

  portal.voice.provide({
    label: "Speaker",
    state() {
      if (settings.stateThrows) throw new Error("The speaker lost track of its engines");
      if (settings.stateAnswers !== null) return settings.stateAnswers;
      return settings.ready ? { speaks: settings.speaks, voices: settings.voices } : undefined;
    },
    async transcribe(recording, { purpose, signal }) {
      watch(signal);
      asked.heard.push({ purpose, bytes: recording.length });
      if (settings.answer === "throws") throw new Error("The speaker could not hear");
      if (settings.answer === "hangs") return new Promise(() => {});
      return " Heard by the speaker. ";
    },
    async speak(text, { voice, signal }) {
      watch(signal);
      asked.spoken.push({ text, voice: voice ?? null });
      const audio = (type, bytes, more = {}) => new Response(body(bytes), { headers: { "content-type": type, ...more } });
      switch (settings.answer) {
        case "pcm":
          return audio("audio/pcm", PCM, { "x-sample-rate": "24000" });
        case "pcm48k":
          return audio("audio/pcm", PCM, { "x-sample-rate": "48000" });
        case "wav":
          return audio("audio/wav", wav(24000));
        case "wav22k":
          return audio("audio/wav", wav(22050));
        case "text":
          return audio("text/plain", Buffer.from("not audio"));
        case "notOk":
          return new Response(body(Buffer.from("busy")), { status: 500 });
        case "notResponse":
          return { ok: true, body: PCM };
        case "throws":
          throw new Error("The speaker lost its voice");
        case "hangs":
          return new Promise(() => {});
      }
    },
    async use(inUse) {
      if (inUse && settings.fails) throw new Error("The speaker could not load its model");
      if (inUse && settings.hangs) return new Promise(() => {});
      asked.uses.push(inUse);
      told.push(`${portal.extension}#${instance} ${inUse}`);
    },
  });

  portal.router.get("/state", (_req, res) => res.json(asked));
  portal.router.put("/settings", portal.http.json(), (req, res) => res.json(Object.assign(settings, req.body)));
  portal.router.post("/choose", portal.http.json(), (req, res) => {
    portal.voice.choose(req.body.chosen);
    res.json({ ok: true });
  });
  portal.router.get("/chosen", (_req, res) => res.json({ chosen: portal.voice.chosen() }));
}
