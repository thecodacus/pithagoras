import { t } from "./i18n";
import type { Item } from "./transcript";

/** Keep code blocks and link destinations out of speech; split without losing text. */
export function speechChunks(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?(?:```|$)/g, () => ` ${t("Code is shown in the transcript.")} `)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let remaining = plain;
  while (remaining.length > 600) {
    const prefix = remaining.slice(0, 600);
    const sentence = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('? '), prefix.lastIndexOf('! '));
    const end = sentence > 100 ? sentence + 1 : prefix.lastIndexOf(' ') > 0 ? prefix.lastIndexOf(' ') : 600;
    chunks.push(remaining.slice(0, end)); remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
/** Silero already returns mono 16 kHz samples, ready for Whisper. */
export function samplesWav(samples: Float32Array): Blob {
  const data = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(data);
  const str = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767), true));
  return new Blob([data], { type: "audio/wav" });
}

/** Consume stable raw-text boundaries once, including while a reply is streaming. */
export class StreamingSpeech {
  private offsets = new Map<string, number>();
  private ignored = new Set<string>();
  constructor(private afterSeq: number) {}
  ignore(items: Item[]) {
    for (const item of items) if (item.kind === 'assistant') this.ignored.add(item.id);
  }
  observe(items: Item[]): string[] {
    const result: string[] = [];
    for (const item of items) {
      if (item.kind !== 'assistant' || Number(item.id.slice(1)) <= this.afterSeq || this.ignored.has(item.id)) continue;
      let offset = this.offsets.get(item.id) || 0;
      while (offset < item.text.length) {
        const tail = item.text.slice(offset);
        const end = phraseBoundary(tail, item.done);
        if (!end) break;
        result.push(...speechChunks(tail.slice(0, end).replace(/—$/, '').replace(/—/g, ', ')));
        offset += end;
      }
      this.offsets.set(item.id, offset);
      if (item.done) this.ignored.add(item.id);
    }
    return result;
  }
}

function speechBoundary(text: string): number {
  let fence = false, inline = false, brackets = 0, link = false, end = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('```', i)) { fence = !fence; i += 2; continue; }
    if (fence) continue;
    if (text[i] === '`') { inline = !inline; continue; }
    if (inline) continue;
    if (text[i] === '[') brackets++;
    if (text[i] === ']') { brackets = Math.max(0, brackets - 1); if (text[i + 1] === '(') link = true; }
    if (link) { if (text[i] === ')') link = false; continue; }
    if (brackets) continue;
    const punctuation = /[.!?。！？]/.test(text[i]);
    const boundary = punctuation && (/[。！？]/.test(text[i]) || /\s/.test(text[i + 1] || ''));
    // Avoid common title/initial/decimal breaks; the next sentence or completion flushes them.
    const abbreviation = text[i] === '.' && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc)|\b[A-Za-z])\.$/i.test(text.slice(0, i + 1));
    if ((boundary && !abbreviation) || text[i] === '\n' || text[i] === '—' || (i >= 240 && /\s/.test(text[i]))) return i + 1;
  }
  return end;
}

/** Three or fewer spoken words wait for the next phrase; final text still flushes. */
function phraseBoundary(text: string, done: boolean): number {
  let end = 0;
  while (end < text.length) {
    const boundary = speechBoundary(text.slice(end)) || (done ? text.length - end : 0);
    if (!boundary) return 0;
    end += boundary;
    const spoken = speechChunks(text.slice(0, end).replace(/—/g, ' ')).join(' ');
    const words = displaySpeechText(spoken, true).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    if (words > 3 || done && end === text.length) return end;
  }
  return 0;
}


/** Display-only: synthesis always receives the original speech cues. */
export function displaySpeechText(text: string, done: boolean): string {
  let visible = text.replace(/[ \t]*\((?:laugh|cough|clears throat|sigh)\)[ \t]*/gi, ' ');
  if (!done) {
    const start = visible.lastIndexOf('(');
    if (start >= 0) {
      const tail = visible.slice(start).toLowerCase();
      if (['(laugh)', '(cough)', '(clears throat)', '(sigh)'].some(tag => tag.startsWith(tail))) visible = visible.slice(0, start);
    }
  }
  return visible.replace(/[ \t]+([,.!?])/g, '$1').trim();
}

/** What the agent said, as it is read — without the reasoning model's stray tags. */
export const assistantText = (item: { text: string; done: boolean; audio?: boolean }): string =>
  (item.audio ? displaySpeechText(item.text, item.done) : item.text).replace(/<\/?think(ing)?>/gi, "");
