import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveVoiceServers, speechServer } from "./portal.mts";

/**
 * Voice servers' routes, as its page in Settings uses them: the settings and their checks, the voices read from a
 * speech server, and voice mode's source chosen, through the portal's own extension host and voice routes.
 */

inProcessHome("pithagoras-voice-servers-routes-");
const { at, api, data } = await serveVoiceServers();
const upstream = await speechServer();

const json = { "content-type": "application/json" };
const put = (settings: unknown) => fetch(`${at}/settings`, { method: "PUT", headers: json, body: JSON.stringify(settings) });
const shown = async () => (await fetch(`${at}/settings`)).json();
const said = async (answer: Response) => [answer.status, (await answer.json()).error];
const RECOGNITION = "http://127.0.0.1:8178/inference";

test("the settings are kept for their owner alone, each left out while it is empty, and said back with whether voice mode uses them", async () => {
  assert.deepEqual(await shown(), { chosen: false });
  const saved = await put({
    sttUrl: ` ${RECOGNITION} `,
    sttModel: "",
    language: "de",
    dictationUrl: "",
    dictationModel: " accurate ",
    ttsUrl: "https://speech.example.test/v1/audio/speech",
    ttsModel: "kokoro",
    voices: [{ id: "af_heart" }, { id: "bm_george", name: "George" }, { id: "am_adam", name: "" }],
    voice: "bm_george",
  });
  const kept = {
    sttUrl: RECOGNITION,
    language: "de",
    dictationModel: "accurate",
    ttsUrl: "https://speech.example.test/v1/audio/speech",
    ttsModel: "kokoro",
    voices: [{ id: "af_heart", name: "af_heart" }, { id: "bm_george", name: "George" }, { id: "am_adam", name: "am_adam" }],
    voice: "bm_george",
  };
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ...kept, chosen: false });
  assert.deepEqual(await shown(), { ...kept, chosen: false });
  const file = path.join(data, "settings.json");
  assert.equal(statSync(file).mode & 0o777, 0o600, "for its owner alone");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), kept);
  // A save says all of them: what it leaves out is no longer set.
  assert.equal((await put({ sttUrl: RECOGNITION })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { sttUrl: RECOGNITION });
});

test("each setting is checked, and a save refused changes nothing", async () => {
  assert.equal((await put({ sttUrl: RECOGNITION })).status, 200);
  const url = (label: string) => `${label} must be an HTTP URL without credentials or a fragment`;
  const model = (label: string) => `${label} may only contain letters, digits, dot, colon, dash or underscore, at most 100 of them`;
  const language = "The input language is a code of two or three small letters, such as en, or empty for the server to detect it";
  const list = "The voices are a list of at most 500";
  const id = "A voice's id is 1–200 characters, with no control characters";
  for (const [settings, error] of [
    [{ sttUrl: "ftp://example.test/inference" }, url("The speech recognition URL")],
    [{ sttUrl: "not an address" }, url("The speech recognition URL")],
    [{ sttUrl: 3 }, "The speech recognition URL must be text"],
    [{ dictationUrl: "http://user:secret@example.test/inference" }, url("The dictation endpoint")],
    [{ ttsUrl: "http://example.test/v1/audio/speech#voice" }, url("The speech synthesis URL")],
    [{ sttModel: "a model" }, model("The speech recognition model")],
    [{ dictationModel: "m".repeat(101) }, model("The dictation model")],
    [{ ttsModel: "kokoro/v1" }, model("The speech synthesis model")],
    [{ language: "EN" }, language],
    [{ language: "auto" }, language],
    [{ voices: "af_heart" }, list],
    [{ voices: Array.from({ length: 501 }, (_, n) => ({ id: `voice-${n}` })) }, list],
    [{ voices: [{ id: "" }] }, id],
    [{ voices: [{ id: "v".repeat(201) }] }, id],
    [{ voices: [{ id: "af\nheart" }] }, id],
    [{ voices: ["af_heart"] }, id],
    [{ voices: [{ id: "af_heart", name: 3 }] }, "A voice's name must be text"],
    [{ voices: [{ id: "af_heart" }], voice: "bm_george" }, "Choose one of the voices listed, or none"],
    [{ voice: "af_heart" }, "Choose one of the voices listed, or none"],
  ] as const) {
    assert.deepEqual(await said(await put(settings)), [400, error], JSON.stringify(settings).slice(0, 100));
  }
  assert.deepEqual(await shown(), { sttUrl: RECOGNITION, chosen: false });
  // As many as 500 voices, of up to 200 characters each.
  assert.equal((await put({ voices: [...Array.from({ length: 499 }, (_, n) => ({ id: `voice-${n}` })), { id: "v".repeat(200) }] })).status, 200);
});

test("the voices are read beside the speech address, in either shape a server lists them, and nothing is saved", async () => {
  assert.equal((await put({ sttUrl: RECOGNITION })).status, 200);
  const read = (ttsUrl: string) => fetch(`${at}/server-voices`, { method: "POST", headers: json, body: JSON.stringify({ ttsUrl }) });
  upstream.answers.set("/v1/audio/voices", { type: "application/json", body: JSON.stringify({ voices: ["af_heart", "bm_george"] }) });
  const names = await read(`${upstream.at}/v1/audio/speech`);
  assert.equal(names.status, 200);
  assert.deepEqual(await names.json(), { voices: [{ id: "af_heart", name: "af_heart" }, { id: "bm_george", name: "bm_george" }] });
  const asked = upstream.heard.at(-1)!;
  assert.deepEqual([asked.method, asked.path, "authorization" in asked.headers], ["GET", "/v1/audio/voices", false]);
  upstream.answers.set("/kokoro/v1/audio/voices", { type: "application/json", body: JSON.stringify({ voices: [{ id: "af_heart", name: "Heart" }, { id: "bm_george" }] }) });
  const entries = await read(` ${upstream.at}/kokoro/v1/audio/speech `);
  assert.deepEqual(await entries.json(), { voices: [{ id: "af_heart", name: "Heart" }, { id: "bm_george", name: "bm_george" }] });
  assert.deepEqual(await shown(), { sttUrl: RECOGNITION, chosen: false });
});

test("an address that does not end in /audio/speech, a list this page does not read, or a server that fails is said so", async () => {
  const read = (ttsUrl: unknown) => fetch(`${at}/server-voices`, { method: "POST", headers: json, body: JSON.stringify({ ttsUrl }) });
  const beside = "The voices are read from …/audio/voices beside an address that ends in /audio/speech";
  for (const [ttsUrl, error] of [
    [`${upstream.at}/inference`, beside],
    [`${upstream.at}/v1/audio/speech/`, beside],
    ["", beside],
    ["ftp://example.test/v1/audio/speech", "The speech synthesis URL must be an HTTP URL without credentials or a fragment"],
  ]) {
    assert.deepEqual(await said(await read(ttsUrl)), [400, error], ttsUrl);
  }
  for (const body of [JSON.stringify(["af_heart"]), JSON.stringify({ voices: [3] }), JSON.stringify({ voices: [{ name: "Heart" }] }), JSON.stringify({ voices: [{ id: "af_heart", name: 3 }] }), "af_heart"]) {
    upstream.answers.set("/odd/audio/voices", { type: "application/json", body });
    assert.deepEqual(await said(await read(`${upstream.at}/odd/audio/speech`)), [400, "The server's list of voices is not one this page reads"], body);
  }
  upstream.answers.delete("/odd/audio/voices");
  assert.deepEqual(await said(await read(`${upstream.at}/odd/audio/speech`)), [502, `Could not read ${upstream.at}/odd/audio/voices: HTTP 404`]);
});

test("voice mode listens and speaks through these servers once there is a recognition address saved, until it is stopped", async () => {
  const choose = async (chosen: unknown) => {
    const answer = await fetch(`${at}/chosen`, { method: "PUT", headers: json, body: JSON.stringify({ chosen }) });
    return [answer.status, await answer.json()];
  };
  const source = async () => (await (await fetch(`${api}/voice`)).json()).provider;
  assert.equal((await put({})).status, 200);
  assert.deepEqual(await choose(true), [400, { error: "Set a speech recognition address first" }]);
  assert.equal(await source(), "");
  assert.deepEqual(await choose("yes"), [400, { error: "chosen must be true or false" }]);
  assert.equal((await put({ sttUrl: RECOGNITION })).status, 200);
  assert.deepEqual(await choose(true), [200, { chosen: true }]);
  assert.equal(await source(), "pithagoras-voice-servers");
  assert.equal((await shown()).chosen, true);
  assert.deepEqual(await choose(false), [200, { chosen: false }]);
  assert.equal(await source(), "");
  assert.equal((await shown()).chosen, false);
});
