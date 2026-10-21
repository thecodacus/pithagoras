/**
 * The Speaker extension's server half: a voice provider for the portal's tests. It runs a speech recognition and a
 * speech synthesis service of its own on a loopback port it opens as it starts, and offers them to voice mode with
 * `portal.voice.provide`. Its routes say what it was asked and told, and change what it answers, as a real one's
 * services coming and going would:
 *
 *   GET  /api/x/test-speaker/state      { uses, heard, spoken }: each `use` it was told, the model each recognition
 *                                       named (null for none), and the model each phrase was asked of
 *   PUT  /api/x/test-speaker/settings   { ready?, speaks?, model?, fails? }: whether `where` answers, how it speaks
 *                                       ("kokoro", "chatterbox", or "none" for recognition alone), the recognition
 *                                       model it names, and whether `use(true)` fails
 *   POST /api/x/test-speaker/choose     { chosen }: `portal.voice.choose`
 */
import { createServer } from "node:http";

/** A phrase as a speech engine that answers with a WAV gives it: mono, 24 kHz, 16-bit, two samples. */
function wav() {
  const pcm = Buffer.from([0, 0, 255, 127]);
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export default async function (portal) {
  const asked = { uses: [], heard: [], spoken: [] };
  const settings = { ready: true, speaks: "kokoro", model: "speaker-asr", fails: false };
  const service = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
        asked.heard.push(body.match(/name="model"\r\n\r\n(.*)\r\n/)?.[1] ?? null);
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ text: " Heard by the speaker. " }));
      }
      if (req.method === "POST" && req.url === "/v1/audio/speech") {
        asked.spoken.push(JSON.parse(body).model);
        res.setHeader("content-type", "audio/wav");
        return res.end(wav());
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${service.address().port}`;

  portal.voice.provide({
    label: "Speaker",
    where: () =>
      settings.ready
        ? {
            listen: { url: `${at}/v1/audio/transcriptions`, ...(settings.model ? { model: settings.model } : {}) },
            ...(settings.speaks === "none" ? {} : { speak: { url: `${at}/v1/audio/speech`, runtime: settings.speaks } }),
          }
        : undefined,
    async use(inUse) {
      if (inUse && settings.fails) throw new Error("The speaker could not load its model");
      asked.uses.push(inUse);
    },
  });

  portal.router.get("/state", (_req, res) => res.json(asked));
  portal.router.put("/settings", portal.http.json(), (req, res) => res.json(Object.assign(settings, req.body)));
  portal.router.post("/choose", portal.http.json(), (req, res) => {
    portal.voice.choose(req.body.chosen);
    res.json({ ok: true });
  });
  return () =>
    new Promise((resolve) => {
      service.closeAllConnections();
      service.close(resolve);
    });
}
