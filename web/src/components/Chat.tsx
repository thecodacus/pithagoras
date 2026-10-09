import { StatusIndicator } from "./ChatActivity";
import { TranscriptRow, type RowActions } from "./TranscriptRow";
import { useStableActions } from "../use-stable-actions";
import { splitContext } from "../context-blocks";
import { workingText } from "./StatusDot";
import { VoiceTerminal } from "./VoiceTerminal";
import { RunningTray } from "./RunningTray";
import { mentionsCommand } from "../status-commands";
import { SubagentPanel } from "./SubagentPanel";
import { BackgroundJobs } from "./BackgroundJobs";
import { stableSubagents, subagents, type Subagent } from "../subagents";
import { useBackground } from "../use-background";
import { useWorkPanels } from "../use-work-panels";
import { useFollowBottom } from "../use-follow-bottom";
import { CanvasPanel } from "./CanvasPanel";
import { latestBrowserActivity, latestTerminalActivity } from "../voice-browser";
import { VoiceControl } from "./VoiceControl";
import { DictationButton, DictationStrip } from "./Dictation";
import { insertAtCaret } from "../dictation";
import { useDictation } from "../use-dictation";
import { createPortal } from "react-dom";
import { Fragment, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DiagramPlugin } from "streamdown";
import { followPointer } from "../pointer-drag";
import { LuGripVertical, LuMenu, LuBot, LuArrowDown, LuFolderOpen, LuGlobe, LuSquareTerminal, LuSquare, LuFileText, LuGitBranch, LuArrowUp, LuPaperclip, LuX } from "react-icons/lu";
import { api, type PiCommand, type PortalEvent, type PromptOptions, type Session } from "../api";
import { pending, refetchImage, sortFiles, uploadedNote, type Attachment } from "../attachments";
import { activity, buildTranscript, keepItems, type Item, type SentImage } from "../transcript";
import { HAS_MERMAID, loadMermaidPlugin } from "../mermaid";
import { useResolvedTheme } from "../theme";
import { ComposerBar } from "./ComposerBar";
import { useChatPictures } from "./ChatPictures";
import { confirmDialog } from "./ConfirmDialog";
import { ErrorBoundary, PartFailed } from "./ErrorBoundary";
import { moveHighlight, paletteMatches, slashToken, typedCommand } from "../slash-palette";
import { useCommandTrigger } from "../command-trigger";
import { lazyComponent } from "../lazy";
import { forgetFileDraft } from "../file-drafts";
import { FilesPanel } from "./FilesPanel";
import { GIT_TABS, GitPanel, type GitTab } from "./git/GitPanel";
import { TitleInput } from "./TitleInput";
import { keepFileActivity, latestFileActivity, type FileActivity } from "../file-activity";
import { caretFrom, drafts, withUnsent } from "../drafts";
import { onFill } from "../editor-fills";
import { local } from "../safe-storage";
import { fancy, glide, launch, leaveRef, mark, settle, useLeaveRef, type Mark } from "../motion";
import { CLIENT_COMMANDS, isClientCommand, isCommand } from "../client-commands";
import { isComposing, isEnter, opensComposer, stopsRun } from "../shortcuts";
import { DOCKED_MIN, EDGE, KEEP, SPLIT, SPLIT_LEAST, across, dockedFrameAmong, dockedSize, dropTarget, fitFrame, groupPanels, isDock, readFrame, readFrames, readPlaceSizes, readPlaces, spreadFrames, type Dock, type Frame, type Frames, type PlaceSizes, type Places, type Size } from "../panel-dock";
import { labelOf, msg, t } from "../i18n";
import { tabKeys } from "../tab-keys";
import { STEP, arrowSteps } from "../resize-keys";

// The terminal emulator is large and only a chat that opens a shell needs it.
const TerminalPanel = lazyComponent(() => import("./TerminalPanel"), "TerminalPanel");

/** How many messages are drawn at first, and added each time you scroll up to the edge. */
const PAGE = 40;

/** Wide enough for the panels to sit beside the conversation: below it they cover it. */
const BESIDE = "(min-width: 768px)";
let besideQuery: MediaQueryList | undefined;
/** One query for every chat and every render, made when first asked. */
const besideNow = () => (besideQuery ??= matchMedia(BESIDE));
const watchBeside = (changed: () => void) => {
  const query = besideNow();
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};

/** The panels' edge towards the conversation, or a window's frame when they float. */
const ASIDE: Record<Dock, string> = {
  right: "border-l border-line",
  left: "border-r border-line",
  bottom: "border-t border-line",
  float: "absolute z-20 rounded-xl border border-line bg-surface shadow-pop",
};

/** The panels that sit beside the conversation, each in a place of its own. */
type AsidePanel = "browser" | "agents" | "files" | "git" | "terminal";
/** What each panel is called: in its header, and on its close button. */
const PANEL: Record<AsidePanel, { label: string; close: string }> = {
  browser: { label: msg("Browser"), close: msg("Close the browser") },
  agents: { label: msg("Subagents"), close: msg("Close the subagents") },
  files: { label: msg("Files"), close: msg("Close the files") },
  git: { label: msg("Git"), close: msg("Close the git panel") },
  terminal: { label: msg("Terminal"), close: msg("Close the terminal") },
};

/** Where a slash command comes from; one a newer portal adds is shown as it is named. */
const COMMAND_SOURCE: Record<string, string> = {
  builtin: msg("builtin"),
  extension: msg("extension"),
  prompt: msg("prompt"),
  skill: msg("skill"),
};

type Movable = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
/** Whether a node can be moved into `parent` without being taken off the page (Element.moveBefore). */
const canMove = (parent: HTMLElement) => typeof (parent as Movable).moveBefore === "function";
/** `box` put at the end of `parent`: moved, where both are on the page and the browser can. */
const moveInto = (parent: HTMLElement, box: HTMLElement) => {
  if (canMove(parent) && parent.isConnected && box.isConnected) {
    try {
      return (parent as Movable).moveBefore!(box, null);
    } catch {
      // Not movable after all (another document, say): taken off and put back.
    }
  }
  parent.appendChild(box);
};

/*
 * Each panel is drawn once, into a box of its own that goes into whichever
 * place it is in: carried elsewhere, it is the same panel — Files keeps an
 * edit not saved, the terminal its lines — rather than one made anew there.
 *
 * A box taken off the page and put back loses what the page held for it: the
 * browser's page loads again, and a list is scrolled back to its top. So
 * before the place it is in goes, it steps out into `park`, and on into its
 * next place, with moveBefore — which moves it without taking it off. A
 * browser without moveBefore takes it off and puts it back as before. Made
 * once per chat, holding nothing of it but these.
 */
function panelBoxes(park: { readonly current: HTMLElement | null }, pressed: { readonly current: (kind: AsidePanel) => void }) {
  const boxes: Partial<Record<AsidePanel, HTMLDivElement>> = {};
  const slots: Partial<Record<AsidePanel, (el: HTMLDivElement | null) => void>> = {};
  const box = (kind: AsidePanel) => {
    let el = boxes[kind];
    if (!el) {
      el = boxes[kind] = document.createElement("div");
      el.className = `flex min-h-0 min-w-0 flex-1 flex-col${kind === "browser" ? " bg-black" : ""}`;
      // On the page, not in React: what is in the box is drawn from elsewhere
      // in the chat (a portal), and its events never reach the window it is in.
      el.addEventListener("pointerdown", () => pressed.current(kind), true);
    }
    return el;
  };
  /** Where the box of `kind` goes in a place. */
  const slot = (kind: AsidePanel) =>
    (slots[kind] ??= (el) => {
      const b = box(kind);
      if (el) {
        if (b.parentElement !== el) moveInto(el, b);
        // Called as the slot goes, while it is still on the page.
      } else if (park.current && canMove(park.current) && b.isConnected) moveInto(park.current, b);
    });
  /** Boxes of panels no longer open taken off the page, where they waited to go somewhere: fullscreen, if one was, with them. */
  const letGo = (open: readonly AsidePanel[]) => {
    for (const [kind, b] of Object.entries(boxes)) if (!open.includes(kind as AsidePanel) && b.parentElement === park.current) b.remove();
  };
  return { box, slot, letGo };
}

/** A size kept in storage, or `fallback` for one that is missing or smaller than may be drawn. */
const storedSize = (key: string, fallback: number, least: number) => {
  const n = Number(local.get(key));
  return Number.isFinite(n) && n >= least ? n : fallback;
};

const COMPOSER_HEIGHT_KEY = "pithagoras.composerHeight";
const DEFAULT_COMPOSER_HEIGHT = 72;
const MIN_COMPOSER_HEIGHT = 56;

function storedComposerHeight(): number {
  const stored = Number.parseInt(local.get(COMPOSER_HEIGHT_KEY) ?? "", 10);
  return Number.isFinite(stored) && stored >= MIN_COMPOSER_HEIGHT ? stored : DEFAULT_COMPOSER_HEIGHT;
}

function persistComposerHeight(height: number) {
  local.set(COMPOSER_HEIGHT_KEY, String(Math.round(height)));
}

/** `list` with one `id` taken out. */
function without(list: string[], id: string): string[] {
  const at = list.indexOf(id);
  return at < 0 ? list : list.filter((_, i) => i !== at);
}

export function Chat({
  session,
  events,
  onSend,
  onEditMessage,
  onDeleteMessage,
  onAbort,
  onClientCommand,
  onRename,
  onOpenNavigation,
  versions = {},
  loading,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
}: {
  session: Session;
  events: PortalEvent[];
  /** The conversation is still arriving; drawing it now would show it half-built. */
  loading?: boolean;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  onSend: (message: string, options?: PromptOptions) => Promise<void>;
  /** Replace a sent message: it and everything after it are dropped, and the new text is sent. */
  onEditMessage: (seq: number, message: string) => Promise<void>;
  /** Remove a sent message and the agent's answer to it. */
  onDeleteMessage: (seq: number) => Promise<void>;
  onAbort: () => Promise<void>;
  /** Builtins the portal itself services — /settings, /new, /name. */
  onClientCommand: (name: string, args: string) => void | Promise<void>;
  /** Give the chat another name, from its header. */
  onRename: (title: string) => Promise<void>;
  /** On a phone, where the sidebar is a drawer: opens it. */
  onOpenNavigation?: () => void;
  /**
   * The versions of messages edited or sent again, by the seq of the one
   * shown: the seqs of all of them, oldest first. Said by the chat's stream.
   */
  versions?: Record<number, number[]>;
}) {
  const [input, setInput] = useState(() => drafts.get(session.id));
  // Where dictated words go. Kept beside the state because several phrases can
  // arrive before React has drawn the first, and each must land after the last.
  const box = useRef<HTMLTextAreaElement>(null);
  const draft = useRef(input);
  draft.current = input;
  const caret = useRef<{ start: number; end: number } | null>(null);
  const caretTo = useRef<number | null>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [voiceHost, setVoiceHost] = useState<HTMLDivElement | null>(null);
  // Sends and uploads on their way, by the chat they are for: this is one component for every chat, and what is
  // still going on in one must not hold up another (one id for each thing going on).
  const [sendingIn, setSendingIn] = useState<string[]>([]);
  const sending = sendingIn.includes(session.id);
  // Which sent message is being rewritten, and what went wrong with the last
  // thing done to one — shown in the transcript, where the message is.
  const [editing, setEditing] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // This is one component for every chat, so what belongs to one must be put
  // away when another opens: the words half written in the box (kept, and
  // there again when you come back), the message being rewritten — a number
  // that would name a different message here — and the last complaint.
  // Pictures waiting to go with the next message, kept per chat like the words.
  const [attached, setAttached] = useState<Attachment[]>(() => pending.get(session.id));
  // Pictures being read or files being uploaded: the message waits for them.
  const [addingIn, setAddingIn] = useState<string[]>([]);
  const adding = addingIn.filter((id) => id === session.id).length;
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [boxOf, setBoxOf] = useState(session.id);
  if (boxOf !== session.id) {
    setBoxOf(session.id);
    setInput(drafts.get(session.id));
    setAttached(pending.get(session.id));
    setEditing(null);
    setRenaming(false);
    setActionError(null);
  }
  const currentSession = useRef(session.id);
  currentSession.current = session.id;
  // Voice mode adds to and takes from the same pictures.
  useEffect(() => pending.subscribe((id) => {
    if (id === currentSession.current) setAttached(pending.get(id));
  }), []);
  const [panelRequest, setPanelRequest] = useState<"model" | "effort" | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [composerHeight, setComposerHeight] = useState(storedComposerHeight);
  // Whether there is a browser to watch, and whether you are watching it. Asked
  // once — the answer only changes when somebody installs or removes one.
  const [browserUp, setBrowserUp] = useState(false);
  const [watching, setWatching] = useState(false);
  const [terminal, setTerminal] = useState(false);
  // The terminal panel holds two: what the agent ran, and a shell of your own.
  // The shell is only started once asked for, and kept while the panel is open.
  const [terminalTab, setTerminalTab] = useState<"agent" | "jobs" | "shell">("agent");
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [shellStarted, setShellStarted] = useState(false);
  const [terminalFocus, setTerminalFocus] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!terminal) setShellStarted(false);
  }, [terminal]);
  useEffect(() => {
    if (terminalTab === "shell" && terminal) setShellStarted(true);
  }, [terminalTab, terminal]);
  const openAgent = (id: string) => {
    setSelectedAgent(id);
    setAgentsOpen(true);
  };
  const openJob = (key: string) => {
    setSelectedJob(key);
    setTerminalTab("jobs");
    setTerminal(true);
  };
  /** A command from the chat, found in the agent terminal. */
  const showInTerminal = (callId: string) => {
    setTerminalTab("agent");
    setTerminal(true);
    setTerminalFocus({ id: callId, at: Date.now() });
  };
  const [files, setFiles] = useState(false);
  // Whether Files has an edit that is not saved: closing it would lose it.
  const [filesDirty, setFilesDirty] = useState(false);
  // The same entry while it has not changed, so that Files and Git, which are given it, are not drawn for every event.
  const lastFile = useRef<FileActivity | null>(null);
  const fileActivity = useMemo(() => (lastFile.current = keepFileActivity(lastFile.current, latestFileActivity(events, session.workspace))), [events, session.workspace]);
  // A file Git asked Files to show, by its path in the chat's folder; `seq` makes the same file asked twice a new ask.
  const [fileAsked, setFileAsked] = useState<{ path: string; seq: number } | null>(null);
  const [git, setGit] = useState(false);
  const [gitTab, setGitTab] = useState<GitTab>("changes");
  // How many files have changed, for the Changes tab: known only while the panel is open.
  const [gitCount, setGitCount] = useState(0);
  // Files opened from Git beside it: a third panel closes the one open longest,
  // and that must not be Git, which was just clicked in.
  const [gitHeld, setGitHeld] = useState(false);
  const showInFiles = useCallback((path: string) => {
    setGitHeld(true);
    setFiles(true);
    setFileAsked({ path, seq: Date.now() });
  }, []);
  useEffect(() => {
    if (!files || !git) setGitHeld(false);
  }, [files, git]);
  // An ask is for the chat it was made in, and answered once: Files, drawn
  // again later or for another chat, is not sent back to it.
  const fileAnswered = useCallback(() => setFileAsked(null), []);
  useEffect(() => setFileAsked(null), [session.id]);
  useWorkPanels(
    { browser: !voiceMode && watching, terminal: !voiceMode && terminal, canvas: canvasOpen, files: !voiceMode && files, git: !voiceMode && git, agents: !voiceMode && agentsOpen },
    panel => { if (panel === "browser") setWatching(false); else if (panel === "terminal") setTerminal(false); else if (panel === "files") setFiles(false); else if (panel === "git") setGit(false); else if (panel === "agents") setAgentsOpen(false); else setCanvasOpen(false); },
    // A third panel closes another one instead, while Files has an edit in it.
    // An edit not saved outweighs keeping Git in view: with both kept nothing
    // could go, and the fallback closed Files — edit and all — unasked.
    filesDirty ? ["files"] : gitHeld ? ["git"] : [],
  );
  const closeFiles = async () => {
    if (
      filesDirty &&
      !(await confirmDialog({ title: t("Discard your changes?"), message: t("The file open in Files has changes that are not saved."), confirmLabel: t("Discard"), danger: true }))
    ) {
      return;
    }
    // Given up on: the panel's unmounting would otherwise keep the edit for the next time it opens.
    forgetFileDraft(session.id);
    setFiles(false);
  };
  // Beside the conversation, top to bottom in this order.
  const asidePanels = [watching && "browser", agentsOpen && "agents", files && "files", git && "git", terminal && "terminal"].filter(Boolean) as AsidePanel[];

  // Kept across reloads: a width you dragged is a preference, and losing it on
  // every refresh makes the handle feel decorative. Where each panel goes, the
  // width or height each place has, and where each floating window was put,
  // the same. What was kept for all of them before they were placed one by
  // one — where they went, how wide or tall, and their one window — is what a
  // panel not placed yet, or a place not sized yet, has.
  const [before] = useState(() => {
    const stored = local.get("panelDock");
    return {
      dock: isDock(stored) ? stored : ("right" as Dock),
      width: storedSize("panelWidth", 560, DOCKED_MIN.w),
      height: storedSize("panelHeight", 320, DOCKED_MIN.h),
      frame: readFrame(local.get("panelFloat")),
    };
  });
  const [places, setPlaces] = useState<Places>(() => readPlaces(local.get("panelPlaces")));
  const [sizes, setSizes] = useState<PlaceSizes>(() => readPlaceSizes(local.get("panelSizes")));
  // Between the two panels in one place. One for all places: no more than two
  // panels are open (useWorkPanels), so only one place ever holds two.
  const [split, setSplit] = useState(() => Number(local.get("panelSplit")) || SPLIT);
  const [frames, setFrames] = useState<Frames>(() => readFrames(local.get("panelFloats")));
  useEffect(() => local.set("panelPlaces", JSON.stringify(places)), [places]);
  useEffect(() => local.set("panelSizes", JSON.stringify(sizes)), [sizes]);
  useEffect(() => local.set("panelSplit", String(split)), [split]);
  useEffect(() => local.set("panelFloats", JSON.stringify(frames)), [frames]);
  // On a phone the panels cover the conversation, wherever they are docked.
  const beside = useSyncExternalStore(watchBeside, () => besideNow().matches);
  const placeOf = (kind: AsidePanel): Dock => (beside ? places[kind] ?? before.dock : "right");
  const widthAt = (side: "left" | "right") => sizes[side] ?? before.width;
  const heightAt = () => sizes.bottom ?? before.height;
  const groups = groupPanels(asidePanels, placeOf);
  const groupAt = (place: Dock) => groups.find((g) => g.place === place);
  const floaters = groupAt("float")?.kinds ?? [];
  // Of two floating windows, the one last carried, sized or pressed in is on top.
  const [onTop, setOnTop] = useState<AsidePanel | null>(null);
  // The room the conversation and the panels share, which a floating window
  // stays inside. Only measured while one floats: docked panels are held by
  // the page itself, and every change to it drew the whole conversation again.
  const body = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  // Not while a window is carried or sized: drawn again for a new room, it
  // would be put back where it was until the next move. Measured when let go.
  const moving = useRef(false);
  const measureRoom = useRef(() => {});
  const measuring = beside && floaters.length > 0;
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !measuring) return;
    const measure = (measureRoom.current = () => {
      if (!moving.current) setRoom((r) => (r.w === el.clientWidth && r.h === el.clientHeight ? r : { w: el.clientWidth, h: el.clientHeight }));
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      measureRoom.current = () => {};
    };
  }, [measuring]);
  // Put aside from one another where they would lie on one another: those
  // never put anywhere by hand before those that were.
  const fitted = floaters.map((k) => fitFrame(frames[k] ?? before.frame, room));
  const order = floaters.map((_, i) => i).sort((a, b) => Number(!frames[floaters[a]]) - Number(!frames[floaters[b]]));
  const windows: Frame[] = [];
  spreadFrames(order.map((i) => fitted[i]), room).forEach((f, j) => (windows[order[j]] = f));
  const placed = (kind: AsidePanel) => windows[floaters.indexOf(kind)];
  /**
   * How a side is drawn: as wide as made, giving way where the conversation —
   * which keeps its 320px — would be squeezed (see fitSides). The side sized
   * last hardly gives way, and the other, first, as far as the least of use
   * (or its own width, or what there is room for); neither sized yet, the two
   * in proportion to their widths.
   */
  const sideStyle = (side: "left" | "right", s: PlaceSizes = sizes) => {
    const w = s[side] ?? before.width;
    // Given way in proportion to how much each may: the other side's is so
    // much more that it gives way nearly alone, until it is at the least.
    // (Not by the side sized last giving way at under 1: then the page gives
    // way that fraction of what is needed, and the chat ran over its edge.)
    if (s.lead && s.lead !== side && groupAt(s.lead)) return { flex: `0 10000 ${w}px`, minWidth: `min(${DOCKED_MIN.w}px, ${w}px, max(0px, 100% - ${KEEP.w + 2 * EDGE}px))` };
    return { flex: `0 1 ${w}px`, minWidth: "0px" };
  };
  /** The widths wanted at the sides, leaving out `without`, which is being carried. */
  const sidesWanted = (without?: AsidePanel) => {
    const at = (side: "left" | "right") => (groupAt(side)?.kinds.some((k) => k !== without) ? widthAt(side) : 0);
    return { left: at("left"), right: at("right") };
  };

  // Where a panel's box waits while it goes from one place to another, and
  // what a press anywhere in a floating one does: brings its window up.
  const park = useRef<HTMLDivElement>(null);
  const pressed = useRef<(kind: AsidePanel) => void>(() => {});
  const [boxes] = useState(() => panelBoxes(park, pressed));
  useLayoutEffect(() => {
    pressed.current = (kind) => {
      if (floaters.length > 1 && floaters.includes(kind)) setOnTop(kind);
    };
    boxes.letGo(asidePanels);
  });
  // Drawn in its new place, the panel flies there from where it was let go.
  useLayoutEffect(() => {
    const f = flight.current;
    flight.current = null;
    const box = f && boxes.box(f.kind);
    const slot = box?.parentElement, there = box?.closest("aside");
    if (f && slot && there) glide(slot, f.from, [there as HTMLElement]);
  }, [places]);
  // A window put aside from another (spreadFrames), kept where it is drawn:
  // it jumped back onto the other's place when that one closed.
  useEffect(() => {
    if (!room.w || moving.current) return;
    const unplaced = floaters.filter((k, i) => !frames[k] || windows[i] !== fitted[i]);
    if (unplaced.length) setFrames((f) => ({ ...f, ...Object.fromEntries(unplaced.map((k) => [k, placed(k)])) }));
  });

  /**
   * Dragging, on pointer events rather than mouse ones (see followPointer).
   * `end` is told whether it was let go or cancelled — a touch the browser
   * took over for a pan drops nothing.
   */
  const drag = (e: React.PointerEvent, move: (dx: number, dy: number) => void, end?: (cancelled: boolean) => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x = e.clientX, y = e.clientY;
    // No frame under the pointer taking the moves, and no text selected on the way.
    document.body.classList.add("is-resizing");
    followPointer(
      e,
      (ev) => move(ev.clientX - x, ev.clientY - y),
      (cancelled) => {
        document.body.classList.remove("is-resizing");
        end?.(cancelled);
      },
    );
  };

  // The places and windows, their dividers' effect, and what shows where a
  // carried panel would go. While a drag goes on they are moved here, on the
  // elements, and the chat is drawn again once, when it ends: at every move
  // it drew the whole conversation again, and wrote the size or place to
  // storage each time. By place — "left", "right", "bottom" — and by panel
  // for the floating windows.
  const asides = useRef<Partial<Record<string, HTMLElement | null>>>({});
  // A panel carried to another place goes there itself (see `glide`), from where
  // it was let go: its old place does not also close behind it.
  const flight = useRef<{ kind: AsidePanel; from: DOMRect } | null>(null);
  // A place whose panels are all gone drops away as a picture of itself (see
  // motion.ts): each place with a ref of its own, held so that React does not
  // put the element away and back at every draw.
  const asideRefs = useRef<Record<string, (el: HTMLElement | null) => void>>({});
  const asideRef = (place: string) =>
    (asideRefs.current[place] ??= leaveRef<HTMLElement>(
      () => (flight.current ? null : "panel"),
      (el) => {
        asides.current[place] = el;
      },
    ));
  const zones = useRef<HTMLDivElement>(null);
  const setBox = (el: HTMLElement | null | undefined, f: Frame) => {
    if (el) Object.assign(el.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
  };

  /**
   * What a side can be made, from the width drawn — at both sides, what the two
   * gave way to. Made wider, the other side gives way, as far as it would for
   * the side sized last (see sideStyle); the conversation keeps its room. No
   * narrower than of use, unless drawn narrower already: then from there, not
   * with a jump to the least.
   */
  const sideRange = (place: "left" | "right", el: HTMLElement, area: HTMLElement) => {
    const other: "left" | "right" = place === "left" ? "right" : "left";
    const them = asides.current[other];
    const mine = el.getBoundingClientRect().width;
    const room = area.clientWidth - KEEP.w - (them ? 2 : 1) * EDGE;
    const least = Math.min(DOCKED_MIN.w, mine);
    const most = Math.max(least, room - (them ? Math.min(DOCKED_MIN.w, widthAt(other), room) : 0));
    return { other, them, mine, least, most };
  };

  /** The edge between the conversation and the panels in a place: their width, or their height at the bottom. */
  const dragSize = (place: Exclude<Dock, "float">) => (e: React.PointerEvent) => {
    const el = asides.current[place], area = body.current;
    if (!el || !area) return;
    if (place === "bottom") {
      // From the height drawn, and within the conversation's room.
      const within = { w: area.clientWidth, h: area.clientHeight };
      const was = heightAt(), from = dockedSize({ width: 0, height: was }, within).height;
      let to = from;
      drag(
        e,
        (_dx, dy) => {
          to = dockedSize({ width: 0, height: from - dy }, within).height;
          el.style.height = `${to}px`;
        },
        (cancelled) => {
          if (cancelled) el.style.height = `${was}px`;
          else setSizes((s) => ({ ...s, bottom: to }));
        },
      );
      return;
    }
    // Let go, this side is the one sized last.
    const { other, them, mine, least, most } = sideRange(place, el, area);
    const after = (to: number): PlaceSizes => ({ ...sizes, [place]: to, lead: place });
    const draw = (s: PlaceSizes) => {
      Object.assign(el.style, sideStyle(place, s));
      if (them) Object.assign(them.style, sideStyle(other, s));
    };
    let to = mine, moved = false;
    drag(
      e,
      (dx) => {
        moved = true;
        to = Math.round(Math.min(most, Math.max(least, mine + (place === "left" ? dx : -dx))));
        draw(after(to));
      },
      (cancelled) => {
        // Nothing moved, nothing kept.
        if (cancelled || !moved) return draw(sizes);
        draw(after(to));
        setSizes(after(to));
      },
    );
  };

  /** The edge between two panels in one place: one above the other, or side by side. */
  const dragSplit = (place: Dock) => (e: React.PointerEvent) => {
    const aside = e.currentTarget.parentElement as HTMLElement;
    const box = aside.getBoundingClientRect();
    const x = e.clientX, y = e.clientY;
    let ratio = split;
    const draw = (r: number) => {
      const [first, second] = aside.querySelectorAll<HTMLElement>(":scope > .chat-aside-panel");
      if (first && second) {
        first.style.flex = `${r} 1 0%`;
        second.style.flex = `${1 - r} 1 0%`;
      }
    };
    drag(
      e,
      (dx, dy) => {
        ratio = Math.min(Math.max(across(place) ? (x + dx - box.left) / box.width : (y + dy - box.top) / box.height, SPLIT_LEAST), 1 - SPLIT_LEAST);
        draw(ratio);
      },
      (cancelled) => (cancelled ? draw(split) : setSplit(ratio)),
    );
  };

  /**
   * The keys of the edge between the conversation and the panels, for whoever has no pointer: an arrow
   * moves the edge that way by a step (four with Shift), Home gives the place its first size back.
   */
  const keySize = (place: Exclude<Dock, "float">) => (e: React.KeyboardEvent) => {
    const area = body.current;
    if (!area) return;
    const bottom = place === "bottom";
    if (e.key === "Home") {
      e.preventDefault();
      return setSizes((s) => ({ ...s, [place]: undefined }));
    }
    const steps = arrowSteps(e, bottom ? "y" : "x");
    if (!steps) return;
    e.preventDefault();
    // The edge goes the way the arrow points, as it does with the pointer: a panel at the right is wider for a move to the left.
    const delta = steps * STEP * (place === "right" || bottom ? -1 : 1);
    if (bottom) {
      const within = { w: area.clientWidth, h: area.clientHeight };
      const from = dockedSize({ width: 0, height: heightAt() }, within).height;
      const to = dockedSize({ width: 0, height: from + delta }, within).height;
      return setSizes((s) => ({ ...s, bottom: to }));
    }
    const el = asides.current[place];
    if (!el) return;
    const { mine, least, most } = sideRange(place, el, area);
    setSizes({ ...sizes, [place]: Math.round(Math.min(most, Math.max(least, mine + delta))), lead: place });
  };

  /** The keys of the edge between two panels in one place: an arrow moves it that way, Home puts it back in the middle. */
  const keySplit = (place: Dock) => (e: React.KeyboardEvent) => {
    if (e.key === "Home") {
      e.preventDefault();
      return setSplit(SPLIT);
    }
    const steps = arrowSteps(e, across(place) ? "x" : "y");
    if (!steps) return;
    e.preventDefault();
    setSplit(Math.min(Math.max(split + steps * 0.05, SPLIT_LEAST), 1 - SPLIT_LEAST));
  };

  /** Done carrying or sizing: the room measured again, for whatever changed meanwhile. */
  const stopMoving = () => {
    moving.current = false;
    measureRoom.current();
  };

  /** A floating window, sized by its corner. */
  const sizeFrame = (kind: AsidePanel) => (e: React.PointerEvent) => {
    // Only a press that drag() takes: another button would leave the room unmeasured for good.
    if (e.button !== 0) return;
    const from = placed(kind), area = room, el = asides.current[kind];
    let at = from;
    moving.current = true;
    setOnTop(kind);
    drag(
      e,
      (dx, dy) => {
        at = fitFrame({ ...from, w: Math.min(from.w + dx, area.w - from.x), h: Math.min(from.h + dy, area.h - from.y) }, area);
        setBox(el, at);
      },
      (cancelled) => {
        if (cancelled) setBox(el, from);
        else setFrames((f) => ({ ...f, [kind]: at }));
        stopMoving();
      },
    );
  };

  /** The keys of a floating window's corner: an arrow makes it larger or smaller by a step, Home, Enter or Space give it the size it first had. */
  const keyFrame = (kind: AsidePanel) => (e: React.KeyboardEvent) => {
    const from = placed(kind);
    const reset = e.key === "Home" || e.key === "Enter" || e.key === " ";
    const wide = arrowSteps(e, "x"), tall = arrowSteps(e, "y");
    if (!reset && !wide && !tall) return;
    e.preventDefault();
    // The size it had before it was ever sized by hand.
    const first = fitFrame(before.frame, room);
    const w = reset ? first.w : from.w + wide * STEP, h = reset ? first.h : from.h + tall * STEP;
    const at = fitFrame({ ...from, w: Math.min(w, room.w - from.x), h: Math.min(h, room.h - from.y) }, room);
    setFrames((f) => ({ ...f, [kind]: at }));
    setOnTop(kind);
  };

  /**
   * Carrying a panel by its header — not by a button or tab in it — to an
   * edge of the chat, where it docks, or anywhere else, where it floats in a
   * window of its own. Only that panel goes: the terminal to the left, Files
   * to the right. While held, the edges show, the one under the pointer lit,
   * and where it would go is drawn; floating, its window goes along with the
   * pointer.
   */
  const carryPanel = (kind: AsidePanel) => (e: React.PointerEvent) => {
    const el = body.current;
    if (!el || e.button !== 0 || (e.target as Element).closest("button, a, input, [role=tab]")) return;
    const holder = e.currentTarget.closest("aside") as HTMLElement;
    const place = placeOf(kind), afloat = place === "float";
    const area = el.getBoundingClientRect(), size = { w: el.clientWidth, h: el.clientHeight };
    const held = holder.getBoundingClientRect();
    // As the window it floated in last, held by its header where it was taken.
    const from = afloat ? placed(kind) : fitFrame(frames[kind] ?? before.frame, size);
    const start = { x: e.clientX - area.left, y: e.clientY - area.top };
    // For a floating window, an edge the press began in counts only once the
    // pointer has left it: one at the top right, nudged by its header near
    // its right end, was docked at the right. Docked panels are carried from
    // wherever their header is — at the bottom, from the left edge.
    let from0: Dock | null = afloat ? dropTarget(start, size) : null;
    if (from0 === "float") from0 = null;
    const grab = { x: Math.min(e.clientX - held.left, from.w - 24), y: Math.min(e.clientY - held.top, 24) };
    // Where it would go among what stays where it is, at the size of the place.
    const others = sidesWanted(kind);
    const sizeOf = (to: Exclude<Dock, "float">): Size => ({ width: to === "bottom" ? 0 : widthAt(to), height: heightAt() });
    let to: Dock | null = null, at = from;
    moving.current = true;
    if (afloat) setOnTop(kind);
    drag(
      e,
      (dx, dy) => {
        // A press that goes nowhere moves nothing.
        if (!to && Math.hypot(dx, dy) < 6) return;
        const x = start.x + dx, y = start.y + dy;
        to = dropTarget({ x, y }, size);
        if (to === from0) to = "float";
        else if (from0 && to !== from0) from0 = null;
        at = fitFrame({ ...from, x: x - grab.x, y: y - grab.y }, size);
        if (afloat) setBox(holder, at);
        const z = zones.current;
        if (!z) return;
        z.hidden = false;
        document.body.classList.add("is-carrying");
        for (const edge of z.querySelectorAll<HTMLElement>("[data-edge]")) edge.classList.toggle("is-active", edge.dataset.edge === to);
        const preview = z.querySelector<HTMLElement>(".dock-preview")!;
        // Floating already, the window itself shows where it goes.
        preview.hidden = afloat && to === "float";
        setBox(preview, to === "float" ? at : dockedFrameAmong(to, size, sizeOf(to), others, sizes.lead));
      },
      (cancelled) => {
        document.body.classList.remove("is-carrying");
        if (zones.current) zones.current.hidden = true;
        if (to && afloat && cancelled) setBox(holder, from);
        if (to && !cancelled) {
          if (to === "float") {
            setFrames((f) => ({ ...f, [kind]: at }));
            setOnTop(kind);
          }
          if (to !== place) {
            flight.current = { kind, from: boxes.box(kind).getBoundingClientRect() };
            setPlaces((p) => ({ ...p, [kind]: to! }));
          }
        }
        stopMoving();
      },
    );
  };
  const scroller = useFollowBottom<HTMLDivElement>();
  const lastSpoken = useRef<string | null>(null);
  // Interrupted or failed, the process is gone: nothing it started is still going.
  const ended = session.status === "interrupted" || session.status === "error";
  // Entries that have not changed are the same entries as in the last draw, so that their rows are not drawn again (see TranscriptRow).
  const lastItems = useRef<Item[]>([]);
  const items = useMemo(() => (lastItems.current = keepItems(lastItems.current, buildTranscript(events, { ended }))), [events, ended]);
  // A click on a picture opens it over the chat, not in a tab of its own.
  const pictures = useChatPictures(items, session);
  // What arrived while the chat was open slides in; what was there when it
  // opened, or was loaded from further up, is simply there.
  const entered = useRef<{ session: string; ready: boolean; at: Map<string, number> }>({ session: session.id, ready: false, at: new Map() });
  if (entered.current.session !== session.id) entered.current = { session: session.id, ready: false, at: new Map() };
  const arriving = (id: string, index: number) => {
    const e = entered.current;
    let at = e.at.get(id);
    if (at === undefined) {
      at = e.ready && index >= items.length - 3 ? performance.now() : 0;
      e.at.set(id, at);
    }
    return at > 0 && performance.now() - at < 700;
  };
  useEffect(() => {
    if (loading) return;
    for (const it of items) if (!entered.current.at.has(it.id)) entered.current.at.set(it.id, 0);
    entered.current.ready = true;
  }, [items, loading]);
  // A chat that has just loaded: its last few messages come in one after
  // another (see motion.css), for a moment, and then it is just a chat.
  const opened = useRef({ session: "", until: 0 });
  if (!loading && opened.current.session !== session.id) opened.current = { session: session.id, until: performance.now() + 1100 };
  const opening = !loading && fancy() && performance.now() < opened.current.until;
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!opening) return;
    const timer = window.setTimeout(() => redraw((n) => n + 1), 1150);
    return () => window.clearTimeout(timer);
  }, [opening, session.id]);
  // Messages taken out of the conversation break apart where they stood, and
  // what was below them slides up (see motion.ts): marked before it is asked
  // for, played when the server says it has done it.
  const taken = useRef<Mark | null>(null);
  const takeOut = () => {
    taken.current?.stop();
    const m = (taken.current = mark(list.current, scroller.ref.current));
    window.setTimeout(() => {
      if (taken.current !== m) return;
      m?.stop();
      taken.current = null;
    }, 5000);
  };
  useLayoutEffect(() => {
    if (taken.current && settle(taken.current)) taken.current = null;
  }, [items]);
  // The last thing the person said. Retrying it replaces it and what came of
  // it, which is only safe where nothing follows that would go too.
  const lastSaid = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "user" && !it.queued && !it.unsent && (splitContext(it.text).text || it.images)) return it.id;
    }
    return undefined;
  }, [items]);
  // A switch to another version, by the message clicked: until the chat has
  // loaded again without it, a second click would ask about a message that is
  // on its way out, and fail after the first had worked.
  const [switching, setSwitching] = useState<number | null>(null);
  useEffect(() => {
    if (switching === null) return;
    if (!items.some((it) => it.kind === "user" && it.seq === switching)) return setSwitching(null);
    // A stream that does not come back does not leave the switches locked.
    const t = window.setTimeout(() => setSwitching(null), 15_000);
    return () => window.clearTimeout(t);
  }, [items, switching]);

  // Only the end of a conversation is drawn to begin with. Drawing all of a long
  // one is what made opening it slow, and the top of it is not what anybody
  // opens it for. Earlier messages are added as you scroll towards them.
  const [shown, setShown] = useState(PAGE);
  // Reading above the end: what is appended must not push the oldest message
  // drawn out of the window, and with it whatever is being read. The window
  // grows by what was added instead; at the end it slides along as before.
  const [tail, setTail] = useState<{ id?: string; count: number }>({ count: 0 });
  const lastId = items.length ? items[items.length - 1].id : undefined;
  if (lastId !== tail.id || items.length !== tail.count) {
    let appended = 0;
    if (tail.id && lastId !== tail.id) {
      for (let i = items.length - 1; i >= 0 && items[i].id !== tail.id; i--) appended++;
      // The one that was last is gone, so this is not something added after it.
      if (appended === items.length) appended = 0;
    }
    if (appended > 0 && !scroller.isFollowing()) setShown((n) => n + appended);
    setTail({ id: lastId, count: items.length });
  }
  const visible = shown >= items.length ? items : items.slice(items.length - shown);
  const hiddenHere = items.length - visible.length;
  const topEdge = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /**
   * The message being read when earlier ones were requested, and where it sat.
   * Messages are added above it, and their height keeps changing for a moment
   * (markdown and code blocks settle after they mount), so the view is kept on
   * that message rather than on a scroll offset worked out once.
   */
  const reading = useRef<{ el: Element; offset: number; first?: string; count: number; until: number } | null>(null);
  const reveal = () => {
    const box = scroller.ref.current;
    if (box && list.current) {
      const top = box.getBoundingClientRect().top;
      // A message, not the edge or the button above them: those come and go.
      const el = [...list.current.children].find(
        (k) => k !== topEdge.current && !k.hasAttribute("data-earlier") && k.getBoundingClientRect().bottom > top + 1,
      );
      reading.current = el
        ? { el, offset: el.getBoundingClientRect().top - top, first: visible[0]?.id, count: items.length, until: Infinity }
        : null;
    }
    if (hiddenHere > 0) setShown((n) => n + PAGE);
    else if (hasEarlier && !loadingEarlier) onLoadEarlier?.();
  };
  const keepPlace = () => {
    const box = scroller.ref.current;
    const r = reading.current;
    if (!box || !r) return;
    if (performance.now() > r.until || !r.el.isConnected) {
      reading.current = null;
      return;
    }
    // Nothing has been added yet — the request is still on its way.
    if (r.until === Infinity) return;
    const drift = r.el.getBoundingClientRect().top - box.getBoundingClientRect().top - r.offset;
    if (Math.abs(drift) >= 1) box.scrollTop += drift;
  };
  const revealNow = useRef(reveal);
  revealNow.current = reveal;
  // A different conversation starts from its end again. Only `shown`: what was
  // last said follows from the events, and clearing it here as well would make
  // the first update after opening look like a message just sent — and pull the
  // view to the end from wherever it was being read.
  useEffect(() => {
    setShown(PAGE);
  }, [session.id]);
  // Added above without moving what is being read.
  useLayoutEffect(() => {
    const r = reading.current;
    // What was asked for has arrived: from here the place is held while it settles.
    if (r && r.until === Infinity && (visible[0]?.id !== r.first || items.length !== r.count)) {
      r.until = performance.now() + 1500;
    }
    keepPlace();
  });
  useEffect(() => {
    if (!list.current) return;
    const observer = new ResizeObserver(keepPlace);
    observer.observe(list.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const root = scroller.ref.current;
    const edge = topEdge.current;
    if (!root || !edge || loading) return;
    if (hiddenHere === 0 && (!hasEarlier || loadingEarlier)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) revealNow.current();
      },
      { root, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(edge);
    return () => observer.disconnect();
  }, [loading, hiddenHere, hasEarlier, loadingEarlier, shown]);


  // Diagrams: the plugin is only fetched once a reply actually contains a
  // mermaid fence, and mermaid bakes its palette into the SVG, so it is handed
  // the theme rather than left to guess at dark text on a dark background.
  const wantsMermaid = useMemo(
    () => items.some((item) => item.kind === "assistant" && HAS_MERMAID.test(item.text ?? "")),
    [items],
  );
  const [mermaid, setMermaid] = useState<DiagramPlugin | null>(null);
  const theme = useResolvedTheme();
  const mermaidOptions = useMemo(
    () => ({ config: { theme: theme === "light" ? ("default" as const) : ("dark" as const) } }),
    [theme],
  );

  useEffect(() => {
    if (!wantsMermaid || mermaid) return;
    let live = true;
    loadMermaidPlugin().then(
      (plugin) => live && setMermaid(plugin),
      // A failed chunk fetch leaves the fence as a code block, which is still
      // readable — better than an error where the answer should be.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wantsMermaid, mermaid]);
  const running = session.status === "running";

  // What it is doing, and for how long. The clock ticks only while something is
  // running, so an idle session re-renders no more than it used to.
  const phase = useMemo(() => (running ? activity(events) : null), [running, events]);
  // Scans of every event, for the voice view: with the box's text in this component, they would run for each key typed.
  const browserActivity = useMemo(() => latestBrowserActivity(events), [events]);
  const terminalActivity = useMemo(() => latestTerminalActivity(events), [events]);
  // Beside the conversation: subagents, jobs left running, extension statuses.
  // The same entry for a subagent whose own events have not changed: an open
  // panel draws its transcript again only when there is more of it, not on
  // every word of the main chat.
  const lastAgents = useRef<Subagent[]>([]);
  const agents = useMemo(() => (lastAgents.current = stableSubagents(lastAgents.current, subagents(events, items, ended))), [events, items, ended]);
  const [background, refreshBackground] = useBackground(session.id, running, events);
  const agentFor = (callId?: string) => (callId ? agents.find((a) => a.toolCallId === callId || a.id === `tool:${callId}`) : undefined);
  // The thinking block and the compaction marker already say so, animated,
  // where it is happening; the status pill would say it twice.
  const statusShownElsewhere = useMemo(() => {
    const last = items[items.length - 1];
    if (!last) return false;
    if (last.kind === "compaction" && last.status === "running") return true;
    return phase?.label === "thinking" && last.kind === "assistant" && !last.done && !!last.thinking && !last.text;
  }, [items, phase]);
  // What tells the composer that pi has a new token count to show. A compaction
  // moves it too, and it is not a turn.
  const turns = useMemo(
    () => events.reduce((n, e) => n + (e.type === "turn_end" || e.type === "compaction_end" ? 1 : 0), 0),
    [events],
  );
  // A notice is the portal speaking, not a message: only what a person or pi
  // said counts. Earlier pages that are not loaded yet count as said.
  const started = useMemo(
    () => hasEarlier || items.some((item) => item.kind === "user" || item.kind === "assistant" || item.kind === "command"),
    [items, hasEarlier],
  );
  // A screen reader is told when a run ends, with the start of the reply it ended on: once, and not
  // as the words stream in, which a live region over the transcript would read out a few at a time.
  const [heard, setHeard] = useState<{ id: string; text: string } | null>(null);
  // Not kept: back on the chat it was said in, it would be put into the region again, and read out as a run that had just ended.
  useEffect(() => {
    if (!heard) return;
    const timer = setTimeout(() => setHeard(null), 10_000);
    return () => clearTimeout(timer);
  }, [heard]);
  useEffect(() => setHeard(null), [session.id]);
  const wasRunning = useRef({ id: session.id, running });
  useEffect(() => {
    const before = wasRunning.current;
    wasRunning.current = { id: session.id, running };
    if (before.id !== session.id || !before.running || running) return;
    const id = session.id;
    // The status comes at once and the last words a frame later (see App's drain), so the reply is read once they are drawn.
    const timer = setTimeout(() => {
      const reply = [...lastItems.current].reverse().find((item) => item.kind === "assistant" && item.text.trim());
      setHeard({ id, text: reply?.kind === "assistant" ? reply.text.trim().slice(0, 300) : t("The run has finished.") });
    }, 200);
    return () => clearTimeout(timer);
  }, [running, session.id]);
  // Commands come from pi at runtime, so anything a newly installed package
  // registers shows up here without the portal knowing about it in advance.
  //
  // Asked for only once the command character is typed. Listing them starts pi
  // for the chat, and it stays up — so fetching them on open started a runtime
  // for every chat looked at, which the config route goes out of its way not to do.
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const commandList = useRef<{ key: string; list: Promise<PiCommand[]> } | null>(null);
  /** Per chat, a send that is waiting for the command list, which what is sent after it queues behind. */
  const held = useRef(new Map<string, Promise<unknown>>());
  /** The commands for this chat, fetched once per chat and again after each run. */
  const loadCommands = (): Promise<PiCommand[]> => {
    // A run can install an extension, whose commands should then be offered.
    const key = `${session.id}:${turns}`;
    if (commandList.current?.key !== key) {
      const list = api.commands(session.id).then(
        (r) => r.commands,
        () => [] as PiCommand[],
      );
      commandList.current = { key, list };
    }
    // Shown every time, not only when fetched: opening another chat empties
    // the list, and coming back finds this chat's still here to be offered.
    const { list } = commandList.current;
    void list.then((found) => {
      if (commandList.current?.key === key) setCommands(found);
    });
    return list;
  };
  // What was listed for another chat is not offered here.
  useEffect(() => setCommands([]), [session.id]);
  // A status line that names a command can run it — once it is known to be
  // one of this chat's. Asked only of a pi that is up: a status can outlast
  // the pi that set it, and asking must not start another.
  const statusNamesCommand = background.statuses.some((s) => mentionsCommand(s.text));
  useEffect(() => {
    if (!statusNamesCommand) return;
    const key = `${session.id}:${turns}`;
    if (commandList.current?.key === key) {
      void loadCommands();
      return;
    }
    let live = true;
    api.commands(session.id, { ifRunning: true }).then(
      (r) => {
        if (!live || r.notRunning) return;
        // The same list a "/" would fetch, so kept as that.
        if (commandList.current?.key !== key) commandList.current = { key, list: Promise.resolve(r.commands) };
        setCommands(r.commands);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [statusNamesCommand, session.id, turns]);
  const commandNames = useMemo(() => new Set(commands.map((c) => c.name)), [commands]);

  // Show the palette while the composer holds a bare "/name" prefix — with
  // whatever character commands start with in this browser.
  const trigger = useCommandTrigger();
  const slashText = slashToken(input, trigger);
  const wantsCommands = slashText !== null;
  useEffect(() => {
    if (wantsCommands) void loadCommands();
  }, [wantsCommands, session.id, turns]);
  const allMatches = useMemo(
    () => (slashText === null ? [] : paletteMatches(commands, slashText)),
    [commands, slashText],
  );
  /** Escape puts the list away until something else is typed. */
  const [paletteShut, setPaletteShut] = useState(false);
  /** Which command Enter runs and Tab completes; the first until an arrow says otherwise. */
  const [picked, setPicked] = useState(0);
  useEffect(() => {
    setPicked(0);
    setPaletteShut(false);
  }, [slashText]);
  const matches = paletteShut ? [] : allMatches;
  // The list is the message box's to the screen reader: which command the arrows are on is what it reads out.
  const paletteId = useId();
  const paletteBox = useRef<HTMLDivElement>(null);
  // Shut, the command list and the way back to the end drop away as pictures of themselves (see motion.ts).
  const paletteRef = useLeaveRef<HTMLDivElement>("menu", paletteBox);
  const jumpRef = useLeaveRef<HTMLButtonElement>("menu");
  useEffect(() => {
    paletteBox.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [picked, matches.length]);
  /** What is left in the box once a command is chosen: its name, ready for arguments. */
  const complete = (c: PiCommand) => {
    caret.current = null;
    changeInput(`${trigger}${c.name} `);
  };

  useEffect(() => {
    // Only offered where it would work: an iframe needs a secure context, and
    // over plain HTTP the client inside it refuses to start.
    if (!window.isSecureContext) return;
    api
      .browser()
      .then((b) => setBrowserUp(b.install.container === "running"))
      .catch(() => setBrowserUp(false));
  }, []);

  useLayoutEffect(() => {
    // Stay at the end while the agent writes — unless you scrolled up to read,
    // which new output must not undo. Something you just said, and the first
    // paint of a conversation, always go to the end — before it is painted, so
    // the top of it is never seen, nor new content at the old scroll position.
    let said: string | null = null;
    for (let i = items.length - 1; i >= 0 && !said; i--) if (items[i].kind === "user") said = items[i].id;
    const fresh = said !== lastSpoken.current;
    lastSpoken.current = said;
    scroller.follow(fresh);
  }, [items.length, events.length]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const startComposerResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startY = event.clientY;
    const maxHeight = Math.round(window.innerHeight * 0.45);
    const startHeight = Math.min(maxHeight, box.current?.getBoundingClientRect().height ?? composerHeight);

    const move = (moveEvent: PointerEvent) => {
      setComposerHeight(Math.max(MIN_COMPOSER_HEIGHT, Math.min(maxHeight, startHeight + startY - moveEvent.clientY)));
    };
    // Kept however it ends — let go, cancelled, or the capture lost with no pointerup at all.
    resizeCleanupRef.current = followPointer(event, move, () => {
      resizeCleanupRef.current = null;
      persistComposerHeight(box.current?.getBoundingClientRect().height ?? composerHeight);
    });
  };

  /**
   * Send `msg` as a message, or run it if it is one of the portal's own commands.
   *
   * What came from the box is taken out of it at once, so that it does not sit
   * there looking unsent while it is on its way — and put back if it does not
   * get there. Throws, for the caller to say what went wrong.
   */
  const submit = async (msg: string, fromBox: boolean): Promise<void> => {
    const sent = session.id;
    const typed = typedCommand(msg, trigger);
    // pi is told "/name" whatever character the command was typed with, so the
    // page has to know it is one: the server cannot tell "!name" from a message.
    // Typed before the list has come — it starts pi for the chat, which can take
    // a while — it is waited for, rather than the command going out as words.
    // The list held may be the one from before the last run, which can have
    // added commands — a skill the agent wrote, an extension it installed — so
    // that is waited for too, and it comes at once when it is the current one.
    // The box is emptied first all the same: what is typed while waiting is for
    // the next message, and the chat may have been left by then. The portal's
    // own commands do not wait, as under the slash: they open UI here and need
    // nothing from pi.
    const listCurrent = commandList.current?.key === `${session.id}:${turns}`;
    const waits = typed !== null && !msg.startsWith("/") && (!commands.length || !listCurrent) && !CLIENT_COMMANDS.has(typed.name);
    const knownIn = (list: PiCommand[]) => (typed && isCommand(typed.name, list) ? typed : null);
    // The pictures in the box go with what came from it, and nothing else. A
    // command is run rather than said — this one here, any other by pi — so
    // they stay in the box for later rather than going where nothing shows them.
    let known = waits ? null : knownIn(commands);
    let images = fromBox && !known ? attached : [];

    if (fromBox) {
      if (known) {
        caret.current = null;
        changeInput("");
      } else clearBox();
    }
    const run = async () => {
      try {
        let listed = commands;
        if (waits) {
          listed = await loadCommands();
          known = knownIn(listed);
          // It was a command after all: its pictures go back where they were.
          if (known && images.length) putBack(sent, "", images);
          if (known) images = [];
        }
        // Some builtins are UI, not prompts: /model opens the picker the pill uses,
        // /settings opens the modal. Sending them to pi would just be a chat line.
        const command = typed && isClientCommand(typed.name, listed) ? typed : null;
        if (command) {
          if (command.name === "model") setPanelRequest("model");
          else await onClientCommand(command.name, command.args);
          return;
        }
        setSendingIn((l) => [...l, sent]);
        try {
          // Mid-run, typed words steer the run — taken in after the step it is on
          // — rather than waiting for it to finish, which on a long run looked
          // like the message had gone nowhere. Voice mode has its own switch.
          const steer = running && !voiceMode;
          await onSend(
            known ? known.wire : msg,
            voiceMode || images.length || steer
              ? { voice: voiceMode || undefined, images: images.length ? images : undefined, steer: steer || undefined }
              : undefined,
          );
        } finally {
          setSendingIn((l) => without(l, sent));
        }
      } catch (e) {
        if (fromBox) putBack(sent, msg, images);
        throw e;
      }
    };
    // In the order they were said: a command still waiting for the list is not
    // overtaken by what is sent after it, which may depend on it. What opens UI
    // here is not part of that order.
    const earlier = held.current.get(sent);
    const opensUi = typed !== null && isClientCommand(typed.name, commands);
    if (!waits && (!earlier || opensUi)) return run();
    const mine = (earlier ?? Promise.resolve()).then(run);
    const settled = mine.then(() => undefined, () => undefined);
    held.current.set(sent, settled);
    void settled.then(() => {
      if (held.current.get(sent) === settled) held.current.delete(sent);
    });
    return mine;
  };

  /** A message that did not go, back where it was typed — in that chat, if you have left it. */
  const putBack = (id: string, msg: string, images: Attachment[] = []) => {
    const back = [...images, ...pending.get(id)];
    if (currentSession.current === id) {
      changeInput(msg ? withUnsent(draft.current, msg) : draft.current);
      changeAttached(back);
    } else {
      if (msg) drafts.set(id, withUnsent(drafts.get(id), msg));
      pending.set(id, back);
    }
  };

  /** A message from the conversation, with its pictures, sent as a new one. */
  const sendAgain = async (item: { images?: SentImage[] }, text: string) => {
    const images = await Promise.all(
      (item.images ?? []).map((image) => refetchImage(api.imageUrl(session.id, image.name), t("A picture"))),
    );
    // Into a run that is going, the same as typing it again would.
    const steer = running && !voiceMode;
    await onSend(text, images.length || steer ? { images: images.length ? images : undefined, steer: steer || undefined } : undefined);
  };

  const attempt = async (fn: () => Promise<void>) => {
    const id = session.id;
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      // What was asked may be answered when another chat is open: the complaint is not for that one.
      if (currentSession.current === id) setActionError((e as Error).message);
    }
  };

  // What the rows can do. Rows are drawn only when what they show changes, so they are handed one object
  // that stays the same, whose functions do what these do now (see useStableActions).
  // Results trusted while this page is open, before the chat's details say so.
  const trustedHere = useRef(new Set<string>());
  const rowActions = useStableActions<RowActions>({
    openPicture: pictures.open,
    showInTerminal,
    openAgent,
    edit: setEditing,
    cancelEdit: () => setEditing(null),
    saveEdit: (seq, next) => {
      const id = session.id;
      return attempt(async () => {
        await onEditMessage(seq, next);
        // Not the message of that number in the chat open now.
        if (currentSession.current === id) setEditing(null);
      });
    },
    // The same as editing without changing a word. After a Stop this is what clears the half-finished
    // answer out of the agent's memory instead of stacking a second question on top of it.
    retry: (seq, text) => {
      takeOut();
      void attempt(() => onEditMessage(seq, text));
    },
    again: (item, text) => attempt(() => sendAgain(item, text)),
    remove: async (seq) => {
      if (
        await confirmDialog({
          title: t("Delete this message?"),
          message: t("The agent's reply to it goes too, and the agent forgets both."),
          confirmLabel: t("Delete"),
          danger: true,
          deletes: true,
        })
      ) {
        takeOut();
        void attempt(() => onDeleteMessage(seq));
      }
    },
    trustFlagged: async (id) => {
      let done = false;
      await attempt(async () => {
        await api.trustFlagged(session.id, id);
        trustedHere.current.add(id);
        done = true;
      });
      return done;
    },
    isTrusted: (id) => trustedHere.current.has(id) || (session.trustedResults ?? []).includes(id),
    switchVersion: (seq, to) => {
      setSwitching(seq);
      void attempt(async () => {
        try {
          await api.switchVersion(session.id, seq, to);
        } catch (e) {
          setSwitching(null);
          throw e;
        }
      });
    },
  });

  const send = async () => {
    const msg = input.trim();
    if ((!msg && !attached.length) || sending || adding) return;
    launch(box.current?.closest("form")?.querySelector(".prompt-send") ?? null);
    await attempt(() => submit(msg, true));
  };

  const changeAttached = (next: Attachment[]) => {
    pending.set(session.id, next);
    setAttached(next);
  };

  /**
   * Pictures and files pasted, dropped or picked. Pictures wait in the box to
   * go with the message; anything else is put in the chat's folder at once and
   * the message says so, so the agent knows to look.
   */
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const id = session.id;
    const { images, others } = sortFiles(files);
    setActionError(null);
    setAddingIn((l) => [...l, id]);
    const problems: string[] = [];
    try {
      problems.push(...(await pending.add(id, images)));
      const uploaded: string[] = [];
      for (const file of others) {
        try {
          uploaded.push((await api.uploadFile(id, "", file)).path);
        } catch (e) {
          problems.push((e as Error).message);
        }
      }
      const note = uploadedNote(uploaded);
      if (note) {
        if (currentSession.current === id) changeInput(draft.current.trim() ? `${draft.current.trimEnd()}\n${note}` : note);
        else drafts.set(id, drafts.get(id).trim() ? `${drafts.get(id).trimEnd()}\n${note}` : note);
      }
    } finally {
      setAddingIn((l) => without(l, id));
      if (problems.length && currentSession.current === id) setActionError(problems.join(" "));
    }
  };

  /** Every change to the box goes through here, so that the draft is kept as it is typed. */
  const changeInput = (next: string) => {
    drafts.set(session.id, next);
    setInput(next);
  };

  // An extension that fills the chat box — pi's setEditorText, pasteToEditor —
  // fills this one, for the person to send or change: the whole of it, or a
  // paste where the cursor is, as in pi's terminal. One right after another
  // builds on it: the box's text is taken as it now is, not as last drawn.
  useEffect(
    () =>
      onFill(session.id, ({ text: given, paste }) => {
        const before = draft.current;
        const where = caret.current ?? { start: before.length, end: before.length };
        const next = paste ? before.slice(0, where.start) + given + before.slice(where.end) : given;
        const at = paste ? where.start + given.length : next.length;
        draft.current = next;
        caret.current = paste ? { start: at, end: at } : null;
        // The same text again draws nothing, and a cursor left to be placed
        // then would move under the next key typed.
        if (next === before) box.current?.setSelectionRange(at, at);
        else caretTo.current = at;
        changeInput(next);
        requestAnimationFrame(() => box.current?.focus());
      }),
    [session.id],
  );

  // Where a paste from an extension goes, for the portal to read the box as it will be.
  useEffect(() => caretFrom((id) => (id === currentSession.current ? caret.current ?? undefined : undefined)), []);

  const clearBox = () => {
    caret.current = null;
    changeInput("");
    changeAttached([]);
  };

  /** Dictated words, put in the box where the cursor was and the cursor left after them. */
  const insertSpoken = (text: string) => {
    const at = caret.current ?? { start: draft.current.length, end: draft.current.length };
    const next = insertAtCaret(draft.current, at.start, at.end, text);
    draft.current = next.value;
    caret.current = { start: next.caret, end: next.caret };
    caretTo.current = next.caret;
    changeInput(next.value);
  };
  useLayoutEffect(() => {
    if (caretTo.current === null) return;
    box.current?.setSelectionRange(caretTo.current, caretTo.current);
    caretTo.current = null;
  }, [input]);

  // The command character from anywhere on the page: the box, with the command list open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Not behind a dialog: the box is not what is being talked to.
      if (voiceMode || document.querySelector('[aria-modal="true"]')) return;
      const altGraph = e.getModifierState?.("AltGraph");
      if (!opensComposer({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, altGraph, target }, trigger)) return;
      e.preventDefault();
      box.current?.focus();
      if (!draft.current.trim()) changeInput(trigger);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voiceMode, session.id, trigger]);

  // Phrases sent as they are said go one at a time: a second must not overtake
  // the first, and one that fails goes back in the box rather than being lost.
  const spoken = useRef<Promise<unknown>>(Promise.resolve());
  const sendSpoken = (text: string) => {
    spoken.current = spoken.current.then(async () => {
      try {
        await submit(text, false);
      } catch {
        insertSpoken(text);
      }
    });
  };
  const dictation = useDictation({
    sessionId: session.id,
    disabled: voiceMode,
    onText: insertSpoken,
    onSend: sendSpoken,
  });
  // One microphone: voice mode takes over from dictation.
  useEffect(() => {
    if (voiceMode) void dictation.stop();
  }, [voiceMode, dictation.stop]);

  const closePanel: Record<AsidePanel, () => void> = {
    browser: () => setWatching(false),
    agents: () => setAgentsOpen(false),
    files: () => void closeFiles(),
    git: () => setGit(false),
    terminal: () => setTerminal(false),
  };

  /** What is in a panel: its header, which carries it, and what it shows. */
  const panelContent = (kind: AsidePanel) => (
    <>
      <div
        // What the panel is carried by, to an edge or to float.
        onPointerDown={beside ? carryPanel(kind) : undefined}
        className="chat-aside-head flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
      >
        <span title={t("Drag to an edge to dock this panel there, anywhere else to float it")} className="-ml-1.5 shrink-0 text-fg-faint max-md:hidden">
          <LuGripVertical aria-hidden className="h-3.5 w-3.5" />
        </span>
        {kind === "terminal" ? (
          <div className="chat-tabs" role="tablist" aria-label={t("Terminals")} onKeyDown={tabKeys}>
            <button type="button" role="tab" aria-selected={terminalTab === "agent"} tabIndex={terminalTab === "agent" ? 0 : -1} onClick={() => setTerminalTab("agent")}>
              {t("Agent")}
              {running && <i className="chat-tab-live" role="img" aria-label={t("Running")} />}
            </button>
            <button type="button" role="tab" aria-selected={terminalTab === "jobs"} tabIndex={terminalTab === "jobs" ? 0 : -1} onClick={() => setTerminalTab("jobs")}>
              {t("Background")}
              {background.jobs.some((j) => j.state === "running" && !j.attached) && <i className="chat-tab-live" role="img" aria-label={t("Running")} />}
            </button>
            <button type="button" role="tab" aria-selected={terminalTab === "shell"} tabIndex={terminalTab === "shell" ? 0 : -1} onClick={() => setTerminalTab("shell")}>
              {t("Your shell")}
            </button>
          </div>
        ) : kind === "git" ? (
          <div className="chat-tabs" role="tablist" aria-label={t("Git")} onKeyDown={tabKeys}>
            {GIT_TABS.map((tab) => (
              <button key={tab.id} type="button" role="tab" aria-selected={gitTab === tab.id} tabIndex={gitTab === tab.id ? 0 : -1} onClick={() => setGitTab(tab.id)}>
                {t(tab.label)}
                {tab.id === "changes" && gitCount > 0 && <span className="ml-1 rounded-full bg-fg/10 px-1 text-[10px]">{gitCount}</span>}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-fg-subtle">{t(PANEL[kind].label)}</span>
        )}
        {kind === "terminal" && terminalTab === "shell" && <span className="max-md:hidden truncate font-mono text-[10px] text-fg-faint">{session.workspace}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {kind === "browser" && (
            <button
              // The browser's own box is what goes fullscreen, not the place
              // it shares: the terminal or Files beside it stays where it is,
              // and closed, the box leaves the page, and fullscreen with it.
              onClick={() => boxes.box("browser").requestFullscreen?.()}
              className="rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg"
            >
              {t("Fullscreen")}
            </button>
          )}
          <button
            onClick={closePanel[kind]}
            title={t("Collapse")}
            aria-label={t(PANEL[kind].close)}
            className="rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg"
          >
            ✕
          </button>
        </div>
      </div>
      {kind === "browser" && (
        <iframe
          src="/browser-ui/"
          title={t("The agent's browser")}
          className="fx-power min-h-0 flex-1 border-0"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      )}
      {kind === "agents" && (
        <div className="min-h-0 flex-1 bg-surface">
          <SubagentPanel sessionId={session.id} agents={agents} items={items} selected={selectedAgent} onSelect={setSelectedAgent} />
        </div>
      )}
      {kind === "files" && (
        <div className="min-h-0 flex-1 bg-surface">
          {/* Not before the chat's events are here: what it did earlier is not news. */}
          {!loading && <FilesPanel key={session.id} sessionId={session.id} folder={session.workspace} activity={fileActivity} reveal={fileAsked} onRevealed={fileAnswered} onDirtyChange={setFilesDirty} keepDraft />}
        </div>
      )}
      {kind === "git" && (
        <div className="min-h-0 flex-1 bg-surface">
          <GitPanel key={session.id} sessionId={session.id} tab={gitTab} onTab={setGitTab} activity={fileActivity?.seq} running={running} onOpenFile={showInFiles} onCount={setGitCount} />
        </div>
      )}
      {kind === "terminal" && (
        <div className="relative min-h-0 flex-1 bg-[#0b0b0d]">
          <div className={terminalTab === "agent" ? "chat-terminal-pane" : "chat-terminal-pane is-hidden"}>
            <VoiceTerminal events={events} limit={500} maxOutput={200_000} ended={ended} hidden={terminalTab !== "agent"} focus={terminalFocus} onFocused={() => setTerminalFocus(null)} />
          </div>
          <div className={terminalTab === "jobs" ? "chat-terminal-pane" : "chat-terminal-pane is-hidden"}>
            {terminalTab === "jobs" && (
              <BackgroundJobs sessionId={session.id} state={background} selected={selectedJob} onSelect={setSelectedJob} onChanged={refreshBackground} />
            )}
          </div>
          {shellStarted && (
            <div className={terminalTab === "shell" ? "chat-terminal-pane" : "chat-terminal-pane is-hidden"}>
              {/* Its code is fetched when the tab is first opened: a file that is gone must not take the chat with it. */}
              <ErrorBoundary resetKey={session.id} fallback={(error) => <div className="p-4"><PartFailed error={error} /></div>}>
                <Suspense fallback={null}>
                  <TerminalPanel sessionId={session.id} />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}
        </div>
      )}
    </>
  );

  // On a phone there is no room beside the conversation: the panels cover it,
  // under the header that opened them, until closed.
  const COVER = "max-md:absolute max-md:inset-0 max-md:z-20 max-md:!h-full max-md:!max-h-none max-md:!w-full max-md:!max-w-none max-md:border-0 max-md:bg-surface";

  /** The panels in one place, where each one's own box goes (see panelBoxes), with the divider between two. */
  const slotsIn = (place: Dock, kinds: readonly AsidePanel[]) =>
    kinds.map((kind, i) => (
      <Fragment key={kind}>
        {i > 0 && (
          <div
            onPointerDown={dragSplit(place)}
            onKeyDown={keySplit(place)}
            title={t("Drag to resize")}
            role="separator"
            tabIndex={0}
            aria-label={t("Space between the two panels")}
            aria-orientation={across(place) ? "vertical" : "horizontal"}
            aria-valuenow={Math.round(split * 100)}
            aria-valuemin={Math.round(SPLIT_LEAST * 100)}
            aria-valuemax={Math.round((1 - SPLIT_LEAST) * 100)}
            className={`shrink-0 touch-none bg-line transition hover:bg-accent/40 focus-visible:bg-accent ${across(place) ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}`}
          />
        )}
        <div
          ref={boxes.slot(kind)}
          className="chat-aside-panel flex min-h-0 min-w-0 flex-col"
          style={{ flex: kinds.length === 1 ? "1 1 0%" : `${i === 0 ? split : 1 - split} 1 0%` }}
        />
      </Fragment>
    ));

  /** The panels docked in one place, and the edge between them and the conversation that sizes them. */
  const placeAside = (place: Exclude<Dock, "float">) => {
    const kinds = groupAt(place)?.kinds;
    if (!kinds) return null;
    const wide = across(place);
    const aside = (
      <aside
        ref={asideRef(place)}
        data-dock={place}
        aria-label={wide ? t("Panels at the bottom") : place === "left" ? t("Panels on the left") : t("Panels on the right")}
        // At a side, as wide as made, giving way where the conversation would
        // be squeezed (see sideStyle). At the bottom, never so tall that the
        // composer and a few lines above it are squeezed out (260px): a chat
        // made shorter by the keyboard, or a window made smaller, keeps room for it.
        style={wide ? { height: heightAt() } : sideStyle(place)}
        className={`chat-aside flex overflow-hidden ${wide ? "max-h-[calc(100%-260px)] shrink-0 flex-row" : "min-w-0 flex-col"} ${ASIDE[place]} ${COVER}`}
      >
        {slotsIn(place, kinds)}
      </aside>
    );
    const edge = (
      <div
        onPointerDown={dragSize(place)}
        onKeyDown={keySize(place)}
        title={t("Drag to resize")}
        role="separator"
        tabIndex={0}
        aria-label={wide ? t("Height of the panels at the bottom") : place === "left" ? t("Width of the panels on the left") : t("Width of the panels on the right")}
        aria-orientation={wide ? "horizontal" : "vertical"}
        aria-valuenow={Math.round(wide ? heightAt() : widthAt(place))}
        aria-valuemin={wide ? DOCKED_MIN.h : DOCKED_MIN.w}
        aria-valuemax={Math.max(Math.round(wide ? heightAt() : widthAt(place)), wide ? innerHeight : innerWidth)}
        className={`chat-aside-edge shrink-0 touch-none bg-line transition hover:bg-accent/40 focus-visible:bg-accent max-md:hidden ${wide ? "h-1 cursor-row-resize" : "w-1 cursor-col-resize"}`}
      />
    );
    return place === "left" ? <>{aside}{edge}</> : <>{edge}{aside}</>;
  };

  /** A floating panel, in a window of its own, sized by its corner. */
  const floatWindow = (kind: AsidePanel) => {
    const at = placed(kind);
    return (
      <aside
        key={kind}
        ref={asideRef(kind)}
        data-dock="float"
        aria-label={t("{panel}, floating", { panel: t(PANEL[kind].label) })}
        style={{ left: at.x, top: at.y, width: at.w, height: at.h }}
        className={`chat-aside flex flex-col overflow-hidden ${ASIDE.float} ${onTop === kind ? "!z-[21]" : ""} ${COVER}`}
      >
        {slotsIn("float", [kind])}
        <div
          onPointerDown={sizeFrame(kind)}
          onKeyDown={keyFrame(kind)}
          title={t("Drag to resize")}
          role="button"
          tabIndex={0}
          aria-label={t("Resize {panel}", { panel: t(PANEL[kind].label) })}
          aria-description={t("The arrow keys make the window larger or smaller, Home gives it its first size back.")}
          className="chat-aside-grip max-md:hidden"
        />
      </aside>
    );
  };

  return (
    <div className="session-workspace relative flex h-full min-h-0 flex-col">
      {pictures.viewer}
      <CanvasPanel key={session.id} sessionId={session.id} folder={session.workspace} open={canvasOpen} setOpen={setCanvasOpen}/>
      <div ref={setVoiceHost} className={voiceMode ? "flex min-h-0 flex-1 flex-col" : "hidden"} />
      <header className={voiceMode ? "hidden" : "chat-header border-b border-line px-4 py-3 max-md:px-3 max-md:py-2"}>
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 max-md:gap-2">
        {onOpenNavigation && (
          <button type="button" aria-label={t("Open navigation")} aria-controls="mobile-navigation" onClick={onOpenNavigation} className="-ml-1 rounded-lg p-2 text-fg hover:bg-fg/10 md:hidden">
            <LuMenu size={20} aria-hidden />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <TitleInput
              value={session.title}
              label={t("Chat name")}
              // The field's padding hangs outside the line, so the header
              // keeps its height and the text stays where the title was.
              className="-my-0.5 -ml-1.5 block w-full text-sm font-medium leading-5"
              onCommit={(next) => {
                setRenaming(false);
                void attempt(() => onRename(next));
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <h2 key={session.id} className="chat-title truncate text-sm font-medium text-fg">
              <button
                type="button"
                onClick={() => setRenaming(true)}
                title={t("Rename this chat")}
                className={`max-w-full truncate rounded text-left hover:text-accent ${workingText(session.status)}`}
              >
                {session.title}
              </button>
            </h2>
          )}
          <p className="truncate font-mono text-[11px] text-fg-faint">{session.workspace}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {session.status === "interrupted" && (
            <span className="rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
              {t("interrupted — send a message to resume")}
            </span>
          )}
          {agents.length > 0 && (
            <PanelToggle
              open={agentsOpen}
              onClick={() => setAgentsOpen((v) => !v)}
              label={t("Subagents")}
              title={agentsOpen ? t("Hide the subagents") : t("The agents working beside this one")}
              live={agents.some((a) => a.status === "running")}
            >
              <LuBot />
            </PanelToggle>
          )}
          {browserUp && (
            <PanelToggle
              open={watching}
              onClick={() => setWatching((v) => !v)}
              label={t("Browser")}
              title={watching ? t("Hide the browser") : t("Watch the browser the agent is driving")}
            >
              <LuGlobe />
            </PanelToggle>
          )}
          <PanelToggle
            open={terminal}
            onClick={() => setTerminal((v) => !v)}
            label={t("Terminal")}
            title={terminal ? t("Hide the terminal") : t("The agent's terminal, and a shell of your own in this workspace")}
          >
            <LuSquareTerminal />
          </PanelToggle>
          <PanelToggle
            open={files}
            onClick={() => (files ? void closeFiles() : setFiles(true))}
            label={t("Files")}
            title={files ? t("Hide the files") : t("Browse the files in this chat's folder")}
          >
            <LuFolderOpen />
          </PanelToggle>
          <PanelToggle
            open={git}
            onClick={() => setGit((v) => !v)}
            label={t("Git")}
            title={git ? t("Hide git") : t("What changed, commits, branches and pull requests — for this chat's repository")}
          >
            <LuGitBranch />
          </PanelToggle>
          <PanelToggle open={canvasOpen} onClick={() => setCanvasOpen((v) => !v)} label={t("Session canvases")} title={t("Session canvases")}>
            <LuFileText />
          </PanelToggle>
        </div>
        </div>
      </header>

      <div ref={body} className={voiceMode ? "hidden" : "chat-body relative flex min-h-0 flex-1 flex-row"}>
      {placeAside("left")}
      {/* No narrower than 320px beside panels at a side: they give way instead (see placeAside). */}
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${groupAt("left") || groupAt("right") ? "md:min-w-[320px]" : ""}`}>
      <div
        ref={scroller.attach}
        onScroll={scroller.onScroll}
        // Reading takes over from the automatic placement.
        onWheel={(e) => {
          reading.current = null;
          scroller.onWheel(e);
        }}
        onTouchStart={() => (reading.current = null)}
        onKeyDown={(e) => {
          reading.current = null;
          scroller.hold(e);
        }}
        onPointerDown={(e) => {
          reading.current = null;
          scroller.hold(e);
        }}
        data-transcript=""
        className="flex-1 overflow-y-auto px-4 py-6"
      >
        <div role="status" aria-live="polite" className="sr-only">{heard?.id === session.id ? heard.text : ""}</div>
        <div ref={list} className={`chat-list mx-auto w-full max-w-3xl space-y-3${opening ? " is-opening" : ""}`}>
        <div ref={topEdge} aria-hidden className="h-px" />
        {!loading && hasEarlier && hiddenHere === 0 && (
          <div data-earlier="" className="flex justify-center pb-2">
            <button
              onClick={onLoadEarlier}
              disabled={loadingEarlier}
              className="rounded-lg border border-line px-3 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg disabled:opacity-50"
            >
              {loadingEarlier ? t("Loading…") : t("Load earlier messages")}
            </button>
          </div>
        )}

        {loading && <TranscriptSkeleton />}

        {!loading && items.length === 0 && (
          <div className="chat-empty pt-16 text-center">
            <img src="/icon-192.png" alt="" draggable={false} className="chat-empty-mark mx-auto mb-4 h-11 w-11 object-contain" />
            <p className="text-sm text-fg-muted">{t("Give pi a task.")}</p>
            <p className="mt-1 text-xs text-fg-faint">{t("You can close this tab — it keeps working.")}</p>
          </div>
        )}

        {(loading ? [] : visible).map((item, index) => {
          const entering = arriving(item.id, hiddenHere + index);
          // A row that came in while the chat was open is not one of those that are
          // played in when it has loaded, whenever that second is still on (motion.css).
          const live = (entered.current.at.get(item.id) ?? 0) > 0 ? " is-live" : "";
          const enter = (entering ? " chat-enter" : "") + live;
          // What you said comes in from the corner the send button is in; what went wrong shakes (motion.css).
          const mine = entering && item.kind === "user" ? " is-mine" : "";
          const seq = item.kind === "user" ? item.seq : undefined;
          return (
            <TranscriptRow
              key={item.id}
              item={item}
              enter={enter}
              mine={mine}
              entering={entering}
              running={running}
              editing={seq !== undefined && editing === seq}
              last={item.id === lastSaid}
              seqs={seq === undefined ? undefined : versions[seq]}
              switching={switching !== null}
              sessionId={session.id}
              folder={session.workspace}
              mermaid={mermaid}
              mermaidOptions={mermaidOptions}
              agent={item.kind === "tool" ? agentFor(item.callId)?.id : undefined}
              act={rowActions}
            />
          );
        })}

          {actionError && (
            <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{actionError}</div>
          )}
          {!loading && running && phase && !statusShownElsewhere && <StatusIndicator phase={phase} />}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onDragOver={(e) => {
          // The voice stage is portaled from inside this form, and React
          // bubbles its drags here too; whatever took them already handled it.
          if (e.defaultPrevented || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          // Down whatever was dropped: a drag that looked like files can carry
          // none, and the overlay would stay up until the next one left.
          setDragging(false);
          if (e.defaultPrevented || !e.dataTransfer.files.length) return;
          e.preventDefault();
          void addFiles([...e.dataTransfer.files]);
        }}
        className="px-4 pb-4 pt-2 sm:px-6 sm:pb-5"
      >
        <div className="prompt-shell relative mx-auto w-full max-w-3xl">
        {/* Scrolled up to read, the way back to the end is one click rather
            than a long drag — and during a run, where the new output is. */}
        {scroller.away && !loading && matches.length === 0 && (
          <button
            ref={jumpRef}
            type="button"
            onClick={() => {
              reading.current = null;
              scroller.follow(true);
            }}
            className="jump-to-end float-in absolute bottom-full left-1/2 z-10 mb-2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-surface px-3 py-1 text-xs text-fg-muted shadow-pop transition hover:text-fg"
          >
            <LuArrowDown aria-hidden className="h-3.5 w-3.5" />
            {running ? t("Latest output") : t("Jump to the end")}
          </button>
        )}
        {matches.length > 0 && (
          <div
            ref={paletteRef}
            id={paletteId}
            role="listbox"
            aria-label={t("Commands")}
            className="float-in absolute bottom-full left-0 right-0 mb-2 max-h-[min(18rem,35dvh)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface shadow-pop"
          >
            {matches.map((c, i) => (
              <button
                key={c.name}
                id={`${paletteId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === picked}
                onMouseEnter={() => setPicked(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(c);
                }}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left transition ${
                  i === picked ? "bg-fg/5" : ""
                }`}
              >
                <span className="font-mono text-xs text-accent">{trigger}{c.name}</span>
                <span className="truncate text-xs text-fg-subtle">{c.description}</span>
                <span className="ml-auto shrink-0 text-[10px] text-fg-faint">{labelOf(COMMAND_SOURCE, c.source)}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onPointerDown={startComposerResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const maxHeight = Math.round(window.innerHeight * 0.45);
            const direction = event.key === "ArrowUp" ? 16 : -16;
            const nextHeight = Math.max(MIN_COMPOSER_HEIGHT, Math.min(maxHeight, composerHeight + direction));
            setComposerHeight(nextHeight);
            persistComposerHeight(nextHeight);
          }}
          aria-label={t("Resize message composer vertically")}
          aria-valuemin={MIN_COMPOSER_HEIGHT}
          aria-valuemax={Math.round(window.innerHeight * 0.45)}
          aria-valuenow={Math.round(composerHeight)}
          title={t("Drag up or down to resize")}
          className="group flex h-3 w-full touch-none cursor-ns-resize items-center justify-center"
        >
          <span className="h-1 w-12 rounded-full bg-fg/15 transition group-hover:bg-accent/60" />
        </button>
        <RunningTray
          agents={agents}
          jobs={background.jobs}
          statuses={background.statuses}
          commands={commandNames}
          onAgent={openAgent}
          onJob={openJob}
          onCommand={(command) => attempt(() => submit(command, false))}
        />
        <DictationStrip dictation={dictation} />
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-accent/60 bg-accent/10 text-xs text-accent">
            {t("Drop pictures to send them, or files to put them in the folder")}
          </div>
        )}
        {(attached.length > 0 || adding > 0) && (
          <div role="group" className="flex flex-wrap items-center gap-2 px-3 pt-3" aria-label={t("Pictures going with the message")}>
            {attached.map((a) => (
              <div key={a.id} className="pop-in group/att relative">
                <img src={a.data} alt={a.name} title={a.name} className="h-14 w-14 rounded-lg object-cover ring-1 ring-line" />
                <button
                  type="button"
                  onClick={() => changeAttached(attached.filter((x) => x.id !== a.id))}
                  aria-label={t("Remove {name}", { name: a.name })}
                  title={t("Remove")}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-surface text-fg-muted shadow ring-1 ring-line transition hover:text-danger"
                >
                  <LuX aria-hidden className="h-3 w-3" />
                </button>
              </div>
            ))}
            {adding > 0 && <span role="status" className="text-[11px] text-fg-subtle">{t("Adding…")}</span>}
          </div>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void addFiles(files);
          }}
        />
        <textarea
          ref={box}
          value={input}
          onChange={(e) => {
            caret.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
            changeInput(e.target.value);
          }}
          onSelect={(e) => {
            caret.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
            drafts.moved(session.id);
          }}
          onPaste={(e) => {
            // A screenshot, or "Copy image" in a browser. Where there is text as
            // well — cells copied from a spreadsheet come with a picture of
            // themselves — the text is what was meant.
            const files = [...e.clipboardData.files];
            if (!files.length || e.clipboardData.getData("text/plain")) return;
            e.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(e) => {
            if (matches.length > 0 && !isComposing(e)) {
              const chosen = matches[Math.min(picked, matches.length - 1)];
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPicked((i) => moveHighlight(i, e.key === "ArrowDown" ? 1 : -1, matches.length));
                return;
              }
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                complete(chosen);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setPaletteShut(true);
                return;
              }
              // The command that is lit runs, rather than the half of its name
              // that was typed going to the agent as a message. One that cannot
              // do anything without an argument waits for it instead.
              if (isEnter(e) && !e.shiftKey) {
                e.preventDefault();
                if (sending) return;
                if (chosen.needsArgument) complete(chosen);
                else void attempt(() => submit(`${trigger}${chosen.name}`, true));
                return;
              }
            }
            // Up in an empty box opens what you last said for rewriting, as in
            // most chat programs — the quick way to fix a typo just sent.
            if (
              e.key === "ArrowUp" &&
              !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey &&
              !isComposing(e) &&
              !input && !attached.length && !running
            ) {
              const last = items.find((it) => it.id === lastSaid);
              if (last?.kind === "user") {
                e.preventDefault();
                setEditing(last.seq);
                return;
              }
            }
            if (
              stopsRun({
                key: e.key,
                running,
                composing: isComposing(e),
                paletteOpen: matches.length > 0,
              })
            ) {
              e.preventDefault();
              void attempt(onAbort);
              return;
            }
            if (isEnter(e) && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={
            dictation.active
              ? t("Speak — your words appear here…")
              : running
                ? t("pi is working — what you send goes into the run after its current step…")
                : t("Describe the task…")
          }
          aria-label={t("Message")}
          aria-autocomplete={matches.length > 0 ? "list" : undefined}
          aria-controls={matches.length > 0 ? paletteId : undefined}
          aria-activedescendant={matches.length > 0 ? `${paletteId}-${Math.min(picked, matches.length - 1)}` : undefined}
          className="prompt-input"
          style={{ height: composerHeight, minHeight: MIN_COMPOSER_HEIGHT, maxHeight: "45vh" }}
        />
          <ComposerBar
            sessionId={session.id}
            session={session}
            running={running}
            turns={turns}
            started={started}
            panelRequest={panelRequest}
            onPanelConsumed={() => setPanelRequest(null)}
            actions={<>
              <button
                type="button"
                onClick={() => picker.current?.click()}
                aria-label={t("Attach pictures or files")}
                title={t("Attach pictures or files — or paste or drop them here. Pictures go to the model; other files go in the chat's folder.")}
                className="prompt-action"
              >
                <LuPaperclip aria-hidden className="h-4 w-4" />
              </button>
              <DictationButton dictation={dictation} />
              <VoiceControl folder={session.workspace} canvasOpen={canvasOpen} onCanvasMinimize={()=>setCanvasOpen(false)} onCanvasToggle={()=>setCanvasOpen(value=>!value)} key={session.id} sessionId={session.id} items={items} running={running} work={phase} onSend={onSend} onAbort={onAbort} stageTarget={voiceHost} onModeChange={setVoiceMode} title={session.title} browserAvailable={browserUp} browserActivity={browserActivity} terminalActivity={terminalActivity} toolEvents={events} />
              {/* Mid-run, Stop stays while a message is written: it is the
                  moment the agent is seen going the wrong way, and whether to
                  steer it or stop it is still open. */}
              {running && <button type="button" aria-label={t("Stop generation")} title={t("Stop generation (Esc)")} onClick={() => void attempt(onAbort)} className="prompt-action prompt-stop">
                <LuSquare aria-hidden className="h-4 w-4" fill="currentColor" />
              </button>}
              {(!running || input.trim() || attached.length > 0) && <button type="submit" aria-label={t("Send message")} title={running ? t("Send into the running task — it goes in after the current step") : t("Send message")} disabled={sending || adding > 0 || (!input.trim() && !attached.length)}
                className="prompt-action prompt-send">
                <LuArrowUp aria-hidden className="h-5 w-5" />
              </button>}
            </>}
          />
        </div>
      </form>
      {placeAside("bottom")}
      </div>

      {/* Beside the conversation rather than above it: the page changing while
          the agent explains what it is doing is the thing worth seeing, and a
          strip across the top pushed the transcript out of view to show it.
          Each panel where it was put: at the right or the left, under the
          conversation, or floating over it. */}
      {placeAside("right")}
      {floaters.map(floatWindow)}
      {asidePanels.map((kind) => createPortal(panelContent(kind), boxes.box(kind), kind))}
      {/* Where a panel's box waits while it goes from one place to another (see panelBoxes). */}
      <div ref={park} hidden />
      {/* Shown while a panel is carried (see carryPanel). */}
      {beside && asidePanels.length > 0 && (
        <div ref={zones} aria-hidden="true" className="dock-zones" hidden>
          {(["left", "right", "bottom"] as const).map((edge) => (
            <i key={edge} data-edge={edge} className={`dock-edge is-${edge}`} />
          ))}
          <div className="dock-preview" />
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * The shape of a conversation while it is fetched: a question, an answer,
 * a couple of steps. What arrives replaces it where it stood, rather than
 * a line of text that jumps away.
 */
function TranscriptSkeleton() {
  return (
    <div role="status" className="skeleton-group space-y-5 pt-6">
      <span className="sr-only">{t("Loading the conversation…")}</span>
      <div className="flex justify-end">
        <div className="skeleton h-10 w-[55%] rounded-2xl rounded-br-md" />
      </div>
      <div className="space-y-2">
        <div className="skeleton h-3 w-[88%]" />
        <div className="skeleton h-3 w-[72%]" />
        <div className="skeleton h-3 w-[80%]" />
      </div>
      <div className="space-y-1.5">
        <div className="skeleton h-6 w-40" />
        <div className="skeleton h-6 w-52" />
      </div>
      <div className="space-y-2">
        <div className="skeleton h-3 w-[64%]" />
        <div className="skeleton h-3 w-[46%]" />
      </div>
    </div>
  );
}

/** One of the buttons in the chat's header that opens a panel beside it. */
function PanelToggle({
  open,
  onClick,
  label,
  title,
  live,
  children,
}: {
  open: boolean;
  onClick: () => void;
  label: string;
  title: string;
  /** Something in the panel is running: a dot says so while it is shut. */
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={open}
      title={title}
      className={`panel-toggle relative rounded-lg border px-2 py-1 text-xs transition [&>svg]:h-3.5 [&>svg]:w-3.5 ${
        open ? "is-open border-accent/40 bg-accent/10 text-accent" : "border-line text-fg-muted hover:bg-fg/5 hover:text-fg"
      }`}
    >
      {children}
      {live && <i className="header-live-dot" aria-hidden />}
    </button>
  );
}
