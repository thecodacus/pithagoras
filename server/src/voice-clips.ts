import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PHRASES, fillerPhrases, statusPhrases } from "./voice-phrases.js";

export const clipHash = (text: string) => createHash("sha256").update(text).digest("hex");
const HEX = /^[0-9a-f]{32,64}$/;
/** 24 kHz s16le mono; a filler longer than this rendered wrong. */
const MAX_CLIP_BYTES = 24000 * 2 * 8;

export interface ClipOptions {
  root: string;
  /** Changes whenever anything that affects how speech sounds changes. */
  version: () => string;
  /** False when fillers are switched off; nothing is rendered then. */
  enabled: () => boolean;
  render: (text: string, signal: AbortSignal) => Promise<Buffer>;
  /** Keeps a lazily loaded speech model loaded while a batch renders. */
  hold?: () => Promise<() => Promise<void>>;
  /** Live speech must have been idle this long before a clip renders. */
  quietMs?: number;
  /** Rendered voices kept on disk, most recently used first. */
  keep?: number;
  log?: (message: string) => void;
}

/**
 * Filler clips rendered once per voice and language and kept on disk, so a
 * voice conversation never waits for them. Rendering runs in the background and
 * yields to live speech and transcription.
 */
export class VoiceClips {
  private live = 0;
  private lastLive = 0;
  private pending = new Set<string>();
  private running?: Promise<void>;
  private stopped = new AbortController();
  constructor(private options: ClipOptions) {}

  /** Marks a live speech or transcription request; call the result when it ends. */
  liveRequest() {
    this.live++; this.lastLive = Date.now();
    let done = false;
    return () => { if (!done) { done = true; this.live--; this.lastLive = Date.now(); } };
  }
  private dir(version: string) { return path.join(this.options.root, version); }
  private file(version: string, hash: string) { return path.join(this.dir(version), `${hash}.pcm`); }
  private async exists(file: string) { return stat(file).then(() => true, () => false); }

  async list(language: string) {
    const version = this.options.version();
    const clips = await Promise.all(fillerPhrases(language).map(async ({ kind, text }) => {
      const hash = clipHash(text);
      return { kind, text, hash, ready: await this.exists(this.file(version, hash)) };
    }));
    const { think, compacting, compactionWait, compactionDone, compactionStopped } = statusPhrases(language);
    return { version, language, notices: { think, compacting, compactionWait, compactionDone, compactionStopped }, clips };
  }
  async read(version: string, hash: string) {
    if (!HEX.test(version) || !HEX.test(hash)) return;
    return readFile(this.file(version, hash)).catch(() => undefined);
  }

  /**
   * Languages voice clients have asked for, so auto-detect setups are warmed
   * again after a voice change or a restart without waiting for a conversation.
   */
  async remember(language: string) {
    const known = await this.known();
    if (known[0] === language) return;
    await mkdir(this.options.root, { recursive: true });
    await writeFile(path.join(this.options.root, "languages.json"), JSON.stringify([language, ...known.filter(l => l !== language)].slice(0, 4)));
  }
  async known(): Promise<string[]> {
    try {
      const value = JSON.parse(await readFile(path.join(this.options.root, "languages.json"), "utf8"));
      return Array.isArray(value) ? value.filter((l): l is string => typeof l === "string" && /^[a-z]{2,3}$/.test(l)) : [];
    } catch { return []; }
  }
  /** Renders every missing clip for these languages; one batch at a time. */
  warm(...languages: string[]) {
    if (!this.options.enabled()) return Promise.resolve();
    for (const language of languages) this.pending.add(language);
    this.running ??= this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }
  close() { this.stopped.abort(); }

  private async drain() {
    while (this.pending.size) {
      const [language] = this.pending; this.pending.delete(language);
      try { await this.renderLanguage(language); }
      catch (e) { if (!this.stopped.signal.aborted) this.options.log?.(`filler clips for ${language}: ${(e as Error).message}`); }
    }
  }
  private async renderLanguage(language: string) {
    const version = this.options.version();
    const missing = (await this.list(language)).clips.filter(clip => !clip.ready);
    await this.touch(version);
    if (!missing.length) return;
    const signal = this.stopped.signal;
    const release = await this.options.hold?.();
    try {
      for (const clip of missing) {
        await this.quiet(signal);
        // Settings changed mid-batch: the rest would render in the old voice.
        if (!this.options.enabled()) return;
        if (this.options.version() !== version) { this.pending.add(language); return; }
        const pcm = await this.options.render(clip.text, signal);
        if (!pcm.length || pcm.length % 2 || pcm.length > MAX_CLIP_BYTES) { this.options.log?.(`skipped filler "${clip.text}": ${pcm.length} bytes`); continue; }
        await mkdir(this.dir(version), { recursive: true });
        const file = this.file(version, clip.hash), partial = `${file}.${process.pid}.partial`;
        await writeFile(partial, pcm); await rename(partial, file);
      }
      this.options.log?.(`rendered ${missing.length} filler clips for ${language}`);
    } finally { await release?.(); await this.prune(version); }
  }
  private async quiet(signal: AbortSignal) {
    const quietMs = this.options.quietMs ?? 5000;
    while (this.live > 0 || Date.now() - this.lastLive < quietMs) await delay(250, undefined, { signal });
    signal.throwIfAborted();
  }
  private async touch(version: string) {
    const now = new Date();
    await utimes(this.dir(version), now, now).catch(() => {});
  }
  private async prune(current: string) {
    // Phrases dropped in an update leave clips nothing will ask for again.
    const phrases = new Set(Object.keys(PHRASES).flatMap(language => fillerPhrases(language).map(clip => `${clipHash(clip.text)}.pcm`)));
    for (const name of await readdir(this.dir(current)).catch(() => [] as string[]))
      if (name.endsWith(".pcm") && !phrases.has(name)) await rm(path.join(this.dir(current), name), { force: true });
    const entries = await readdir(this.options.root, { withFileTypes: true }).catch(() => []);
    const dirs = await Promise.all(entries.filter(e => e.isDirectory() && HEX.test(e.name) && e.name !== current)
      .map(async e => ({ name: e.name, at: (await stat(this.dir(e.name))).mtimeMs })));
    dirs.sort((a, b) => b.at - a.at);
    for (const old of dirs.slice(Math.max(0, (this.options.keep ?? 4) - 1))) await rm(this.dir(old.name), { recursive: true, force: true });
  }
}
