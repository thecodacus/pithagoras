import type { PortalEvent, Session } from "../core/web/src/api.ts";
import type { StreamSource } from "../core/web/src/kernel/chats.ts";

/** An event stream the test drives: what the portal would send, in the order the test says. */
export class FakeSource implements StreamSource {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  private named = new Map<string, ((m: { data: string }) => void)[]>();
  constructor(readonly url: string) {}
  /** The `since` cursor the page asked to read from. */
  get since(): number {
    return Number(new URL(this.url, "http://portal").searchParams.get("since"));
  }
  get chat(): string {
    return this.url.split("/")[3];
  }
  addEventListener(type: string, listener: (m: { data: string }) => void): void {
    this.named.set(type, [...(this.named.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  /** A named event (`reloads`, `versions`, `live-reset`, `extension`, `caught-up`). */
  named_(type: string, data: unknown = {}): void {
    for (const l of this.named.get(type) ?? []) l({ data: JSON.stringify(data) });
  }
  /** An event of the conversation. */
  send(event: PortalEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  /** What a portal says as a stream opens: the count of reloads, the versions, and when it has caught up. */
  start(opts: { reloads?: number; events?: PortalEvent[]; versions?: Record<number, number[]> } = {}): void {
    this.open();
    this.named_("reloads", { reloads: opts.reloads ?? 0 });
    this.named_("versions", { versions: opts.versions ?? {} });
    this.named_("live-reset");
    for (const ev of opts.events ?? []) this.send(ev);
    this.named_("caught-up", { seq: opts.events?.at(-1)?.seq ?? 0 });
  }
  fail(): void {
    this.onerror?.({});
  }
}

/** The streams a store opened, newest last, and what opens them. */
export function streams() {
  const all: FakeSource[] = [];
  return {
    all,
    open: (url: string) => {
      const s = new FakeSource(url);
      all.push(s);
      return s;
    },
    /** The streams open now. */
    live: () => all.filter((s) => !s.closed),
    /** The latest stream of a chat. */
    of: (chat: string) => [...all].reverse().find((s) => s.chat === chat)!,
  };
}

/** What `frame` is in a test: nothing is applied until the test says the frame came. */
export function frames() {
  let queue: (() => void)[] = [];
  return {
    frame: (run: () => void) => {
      queue.push(run);
      return () => {
        queue = queue.filter((r) => r !== run);
      };
    },
    /** The next frame is drawn. */
    tick: () => {
      const now = queue;
      queue = [];
      for (const run of now) run();
    },
  };
}

/** What `poll` is in a test: each poll is kept, and a tick of it is called by the test. */
export function polls() {
  const all: { tick: () => void; ms: number; stopped: boolean }[] = [];
  return {
    all,
    poll: (tick: () => void, ms: number) => {
      const p = { tick, ms, stopped: false };
      all.push(p);
      return () => {
        p.stopped = true;
      };
    },
    /** Everything still polling is polled once. */
    tick: () => all.filter((p) => !p.stopped).forEach((p) => p.tick()),
    running: () => all.filter((p) => !p.stopped),
  };
}

export const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  title: `Chat ${id}`,
  workspace: "/work",
  executor: "host",
  status: "idle",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_error: null,
  pinned: false,
  provider: null,
  model: null,
  thinking_level: null,
  mode: null,
  ...extra,
});

export const event = (seq: number, type: string, payload: unknown = {}): PortalEvent => ({ seq, type, at: 1000 + seq, payload });

/** A failure the portal answers with, as `api` throws it. */
export async function apiError(status: number, message = "no"): Promise<never> {
  const { ApiError } = await import("../core/web/src/api.ts");
  throw new ApiError(message, status, {});
}

/** Lets what is waiting on promises run. */
export const settle = () => new Promise<void>((r) => setTimeout(r, 0));
