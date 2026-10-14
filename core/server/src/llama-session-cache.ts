import { createHash } from 'node:crypto';

/** How long what a server said about its slots is trusted. */
const SLOTS_MS = 10 * 60_000;

/**
 * Serialize save/restore with inference, because the cache is the one slot the
 * server keeps (llama-server with `--parallel 1`, and a `--slot-save-path`):
 * saving and restoring always address slot 0, and a request that ran beside
 * them would be another conversation's state in it. A server that says it has
 * more slots than one is left alone: requests run side by side, and no
 * snapshot is taken.
 */
export class LlamaSessionCache {
  private tails = new Map<string, Promise<void>>();
  private resident = new Map<string, string>();
  private slots = new Map<string, { single: boolean; at: number }>();

  /** Whether the server has a single slot, as it reports in `/props`. One that does not say is taken for one, as it always was. */
  private async single(origin: string, model: string): Promise<boolean> {
    const lane = `${origin}/${model}`;
    const known = this.slots.get(lane);
    if (known && Date.now() - known.at < SLOTS_MS) return known.single;
    let single = true;
    try {
      const response = await fetch(new URL(`/props?model=${encodeURIComponent(model)}`, origin), { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const props = await response.json() as { total_slots?: unknown };
        single = !(typeof props.total_slots === 'number' && props.total_slots > 1);
      } else await response.body?.cancel();
    } catch { /* Not asked: as before. */ }
    this.slots.set(lane, { single, at: Date.now() });
    return single;
  }

  async run(origin: string, model: string, session: string, signal: AbortSignal, work: () => Promise<boolean>) {
    if (!await this.single(origin, model)) { await work(); return; }
    const lane = `${origin}/${model}`;
    const previous = this.tails.get(lane) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(lane, gate);
    const filename = createHash('sha256').update(`${model}\0${session}`).digest('hex') + '.bin';
    const action = async (name: string) => {
      const response = await fetch(new URL(`/slots/0?action=${name}`, origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, filename }), signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const result = await response.json() as Record<string, number>;
      return (result[name === 'save' ? 'n_saved' : 'n_restored'] ?? 0) > 0;
    };
    try {
      await previous;
      signal.throwIfAborted();
      if (this.resident.get(lane) !== session) {
        // Missing or incompatible caches fall back to normal prompt evaluation.
        await action('restore').catch(() => false);
      }
      signal.throwIfAborted();
      const completed = await work();
      this.resident.delete(lane);
      if (completed && !signal.aborted && await action('save').catch(() => false)) this.resident.set(lane, session);
    } finally {
      release();
      if (this.tails.get(lane) === gate) this.tails.delete(lane);
    }
  }
}
