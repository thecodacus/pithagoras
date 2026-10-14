// Voice mode's turn decision, run on recorded speech without a browser: Silero v5 and vad-web's own FrameProcessor,
// with Smart Turn's TurnEnd driving it as VoiceControl does, frame by frame. Time is counted in frames, and Smart
// Turn's answer arrives a set latency after it is asked, so a run is the same every time.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_VAD } from '../core/web/src/api.ts';
import { FRAME_MS, TurnEnd, type SmartTurnSettings } from '../core/web/src/smart-turn.ts';
import { smartTurnModel } from '../core/web/src/smart-turn-model.ts';
import { downloadSmartTurn } from '../core/web/scripts/smart-turn-model.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'web/package.json'));
const vadDir = path.dirname(require.resolve('@ricky0123/vad-web'));
const { FrameProcessor, Message } = require('@ricky0123/vad-web');
const { SileroV5 } = require(path.join(vadDir, 'models/v5.js'));
const ortDir = path.dirname(require.resolve('onnxruntime-web/wasm'));
const ort = require('onnxruntime-web/wasm');
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = `${ortDir}/`;

export const RATE = 16000;
const FRAME = 512;

/** The 16-bit mono samples of a WAV file, as the browser has them: -1 to 1. */
export function readWav(file: string): Float32Array {
  const wav = readFileSync(file);
  assert16kMono(wav);
  const data = wav.indexOf('data');
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + data + 8, wav.byteOffset + data + 8 + wav.readUInt32LE(data + 4)));
  return Float32Array.from(pcm, v => v / 32768);
}
function assert16kMono(wav: Buffer) {
  const fmt = wav.indexOf('fmt ');
  if (wav.readUInt16LE(fmt + 10) !== 1 || wav.readUInt32LE(fmt + 12) !== RATE || wav.readUInt16LE(fmt + 22) !== 16) throw new Error('Expected 16 kHz mono 16-bit PCM');
}

export const silence = (ms: number) => new Float32Array(Math.round((ms / 1000) * RATE));
export function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

let model: Promise<(window: Float32Array) => Promise<number>> | undefined;
/** Smart Turn, the file the web build serves, on the same runtime the browser uses. */
export function smartTurn() {
  return model ??= downloadSmartTurn(path.join(root, 'core/web/public/voice-assets')).then(file => smartTurnModel(readFileSync(file), `${ortDir}/`));
}

export interface Run {
  /** When Silero ended a turn, in ms from the start. */
  ends: number[];
  /** Each time Smart Turn was asked: when, and what it said. */
  checks: { at: number; probability: number }[];
  /** The end of the last frame Silero took for speech, before each end. */
  lastSpeech: number[];
  /** When Silero dropped what it heard as too short to be speech. */
  misfires: number[];
}

/**
 * Runs `audio` through Silero and, with `settings`, through Smart Turn as voice mode does, answering each check
 * `latencyMs` after it is asked. Without `settings` it is the plain silence rule, `DEFAULT_VAD.redemptionMs`.
 */
export async function simulate(audio: Float32Array, settings: SmartTurnSettings | null, latencyMs = 0): Promise<Run> {
  const silero = await SileroV5.new(ort, async () => readFileSync(path.join(vadDir, 'silero_vad_v5.onnx')));
  const processor = new FrameProcessor(silero.process, silero.reset_state, { ...DEFAULT_VAD, submitUserSpeechOnPause: false }, FRAME_MS);
  processor.resume();
  const predict = settings && await smartTurn();
  const run: Run = { ends: [], checks: [], lastSpeech: [], misfires: [] };
  let index = 0, lastSpeech = 0;
  const due: { frame: number; deliver: () => Promise<void> }[] = [];
  const turns = settings && new TurnEnd(DEFAULT_VAD, settings, {
    predict: window => {
      const asked = index;
      const answer = predict!(window).then(probability => { run.checks.push({ at: (asked + 1) * FRAME_MS, probability }); return probability; });
      return new Promise((resolve, reject) => due.push({ frame: asked + Math.ceil(latencyMs / FRAME_MS), deliver: () => answer.then(resolve, reject) }));
    },
    redemption: ms => processor.setOptions({ redemptionMs: ms }),
  });
  turns?.ready();
  for (; (index + 1) * FRAME <= audio.length; index++) {
    // Answers that have arrived by this frame are taken in before it, as the page would.
    for (const answer of due.filter(d => d.frame <= index)) { due.splice(due.indexOf(answer), 1); await answer.deliver(); }
    await new Promise(resolve => setImmediate(resolve));
    await processor.process(audio.slice(index * FRAME, (index + 1) * FRAME), (event: any) => {
      if (event.msg === Message.FrameProcessed) {
        if (event.probs.isSpeech >= DEFAULT_VAD.positiveSpeechThreshold) lastSpeech = (index + 1) * FRAME_MS;
        turns?.frame(event.probs.isSpeech, event.frame);
      } else if (event.msg === Message.SpeechEnd) {
        turns?.ended();
        run.ends.push((index + 1) * FRAME_MS);
        run.lastSpeech.push(lastSpeech);
      } else if (event.msg === Message.VADMisfire) {
        turns?.ended();
        run.misfires.push((index + 1) * FRAME_MS);
      }
    });
  }
  return run;
}
