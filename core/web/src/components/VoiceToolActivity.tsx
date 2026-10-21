import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNow } from '../use-now';
import { LuCheck, LuCircleAlert, LuLoaderCircle, LuSparkles } from 'react-icons/lu';
import { api, type PortalEvent } from '../api';
import { describeCall, describeOutcome, elapsed, unwrap, type ToolCall, type ToolTarget } from '../tool-activity';
import { shownFiles } from '../../../server/src/file-outputs';
import { msg, t } from "../i18n";
import type { CallFile, ToolCallView } from '@pithagoras/extension-api';

/** A card for one tool call, in one of four places around the orb. */
type Card = ToolCall & {
  id: number; callId: string; start: unknown; startedAt: number;
  status: 'running' | 'done' | 'failed'; outcome: string;
  slot: number; leaving: boolean;
  /** The files its call gave, once it ended: for an extension's tile of it. */
  files?: CallFile[];
};

/** Where the page fetches a file a call gave, by its kind: see file-outputs.ts. */
const fileUrl = { picture: api.pictureUrl, video: api.videoUrl, file: api.fileUrl };

/** How long a finished card stays: long enough to read its outcome, longer for a failure. */
const STAYS = { done: 4500, failed: 7000 };
/** How long a card takes to go, so it is taken out after its animation. */
const LEAVING = 600;
const SLOTS = 4;
const SLOT_IDS = Array.from({ length: SLOTS }, (_, i) => i);

/** Where a card leads, as its title names it. */
const TARGET: Record<ToolTarget, string> = {
  pictures: msg("the picture"),
};

/**
 * What the agent is doing, as cards flying out of the orb.
 *
 * A card stays while its call runs — a long build is still going, and a card
 * that faded after eight seconds said nothing about the minutes after — and
 * shows how long it has been. When the call ends it says what came of it, and
 * goes a few seconds later. One that can be looked at opens it when tapped:
 * the picture, or a window an extension brought for it (a file's in Files, a
 * document's in Canvases: `opens` names it).
 * That is a role it takes on, not another element: see the card below.
 */
export function VoiceToolActivity({ events, sessionId, folder, onOpen, opens, words, tile }: {
  events: PortalEvent[]; sessionId: string; folder: string;
  onOpen: (call: ToolCall, view: ToolCallView) => void;
  /** What an extension draws small for a call of its tool, in the place of the mark (its `chat.tool` entry's `tile`). */
  tile?: (view: ToolCallView) => ReactNode;
  /** The title of a window an extension brought for a call, when one is for it. */
  opens?: (view: ToolCallView) => string | undefined;
  /** What the card of a call says, when the extension that knows the call says (`describe`). */
  words?: (view: ToolCallView) => { label: string; detail?: string } | undefined;
}) {
  const seen = useRef(events.reduce((n, e) => Math.max(n, e.seq), 0));
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const cards = useRef<Card[]>([]);
  const [shown, setShown] = useState<Card[]>([]);
  const update = (next: Card[]) => { cards.current = next; setShown(next); };
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => { timers.current.delete(timer); run(); }, ms);
    timers.current.add(timer);
  };
  const leave = (id: number) => {
    update(cards.current.map(card => card.id === id ? { ...card, leaving: true } : card));
    later(LEAVING, () => update(cards.current.filter(card => card.id !== id)));
  };

  useEffect(() => {
    const fresh = events.filter(e => e.seq > seen.current);
    if (!fresh.length) return;
    seen.current = fresh.reduce((n, e) => Math.max(n, e.seq), seen.current);
    let next = cards.current;
    for (const event of fresh) {
      const p = event.payload ?? {};
      if (event.type === 'tool_execution_start') {
        let taken = new Set(next.filter(c => !c.leaving).map(c => c.slot));
        if (taken.size >= SLOTS) {
          // Full: the oldest finished card makes room, or failing that the oldest of all.
          const out = next.find(c => !c.leaving && c.status !== 'running') ?? next.find(c => !c.leaving)!;
          next = next.filter(c => c !== out);
          taken = new Set(next.filter(c => !c.leaving).map(c => c.slot));
        }
        // A slot a card is still leaving from is taken last, and that card then
        // goes at once rather than being flown over.
        const leavingFrom = new Set(next.filter(c => c.leaving).map(c => c.slot));
        const slot = SLOT_IDS.find(s => !taken.has(s) && !leavingFrom.has(s)) ?? SLOT_IDS.find(s => !taken.has(s)) ?? 0;
        next = next.filter(c => !(c.leaving && c.slot === slot));
        const call = unwrap(p);
        const said = words?.({ name: call.name, callId: String(p.toolCallId ?? '') || undefined, status: 'running', input: call.input });
        next = [...next, { ...describeCall(p, folder), ...(said ? { label: said.label, detail: said.detail ?? '' } : {}), id: event.seq, callId: String(p.toolCallId ?? ''), start: p, startedAt: Date.now(), status: 'running', outcome: '', slot, leaving: false }];
      } else if (event.type === 'tool_execution_end') {
        const card = next.find(c => c.callId && c.callId === String(p.toolCallId ?? '') && c.status === 'running');
        if (!card) continue;
        const status = p.isError ? 'failed' as const : 'done' as const;
        // A card leads to the pictures once its call has given one (see file-outputs.ts): a call that makes one has none to open before that.
        const picture = shownFiles(p).find(file => file.kind === 'picture');
        const target = picture ? 'pictures' as const : undefined;
        const files = shownFiles(p).map(file => ({ ...file, url: fileUrl[file.kind](sessionId, file.path, event.seq) }));
        next = next.map(c => c === card ? { ...c, status, outcome: describeOutcome(c.start, p), ...(target ? { target } : {}), ...(files.length ? { files } : {}) } : c);
        later(STAYS[status], () => leave(card.id));
      } else if (event.type === 'agent_end' || (event.type === 'portal_status' && p.status !== 'running')) {
        // The run is over: a call that never reported its end is not still going.
        for (const card of next) if (card.status === 'running' && !card.leaving) later(0, () => leave(card.id));
      }
    }
    update(next);
  }, [events, folder, sessionId]);

  // A running card counts its time, so it is only redrawn while one is.
  const now = useNow(shown.some(card => card.status === 'running'));
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);

  return <div className="voice-tool-activity" role="log" aria-label={t("Tool activity")} aria-live="polite" aria-relevant="additions">
    {shown.map(card => {
      const took = Math.max(0, now - card.startedAt);
      const note = card.status === 'running' ? (took >= 3000 ? elapsed(took) : '') : card.outcome;
      const className = `voice-tool-float flies-${card.slot % 2 ? 'right' : 'left'} flight-lane-${Math.floor(card.slot / 2)} is-${card.status}${card.leaving ? ' is-leaving' : ''}`;
      // What the extension of a call's tool draws of it, in the place of the mark: a picture being made, made or not made, say.
      const own = tile?.(viewOf(card));
      const body = <>
        {own ? <div className="voice-tool-tile">{own}</div>
          : card.status === 'failed' ? <LuCircleAlert aria-hidden="true" /> : card.status === 'done' ? <LuCheck aria-hidden="true" /> : took >= 3000 ? <LuLoaderCircle aria-hidden="true" className="animate-spin" /> : <LuSparkles aria-hidden="true" />}
        <div>
          <span>{card.label}</span>
          {card.detail && <p>{card.detail}</p>}
          {note && <p className="voice-tool-note">{card.status === 'failed' ? t('Failed: {note}', { note }) : note}</p>}
          {!note && card.status === 'failed' && <p className="voice-tool-note">{t("Failed")}</p>}
        </div>
      </>;
      // One element for the card's whole life, a button only by its role: a card that is given something to
      // open when its call ends (a picture it made) would otherwise be a new element, flying out of the
      // orb again and read out again by a screen reader.
      const view = viewOf(card);
      const open = () => onOpen(card, view);
      const brought = card.target ? undefined : opens?.(view);
      const lead = card.target || brought ? {
        role: 'button', tabIndex: 0, onClick: open,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } },
        title: t('Show {what}', { what: card.target ? t(TARGET[card.target]) : brought! }),
      } : {};
      return <div key={card.id} className={className} {...lead}>{body}</div>;
    })}
  </div>;
}

/** A card's call as an extension is told of it. */
function viewOf(card: Card): ToolCallView {
  const { name, input } = unwrap(card.start);
  return { name, callId: card.callId || undefined, status: card.status === 'failed' ? 'error' : card.status, input, since: card.startedAt, ...(card.files ? { files: card.files } : {}) };
}
