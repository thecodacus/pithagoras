import { ActivityProgress } from './ActivityProgress';
import type { Activity } from '../transcript';
import { useWorkPanels } from "../use-work-panels";
import { FilesPanel } from "./FilesPanel";
import { keepFileActivity, latestFileActivity, type FileActivity } from "../file-activity";
import { VoiceToolActivity } from "./VoiceToolActivity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { Item } from "../transcript";
import { LuMic, LuMicOff, LuX, LuGlobe, LuMaximize2, LuMinimize2, LuMinus, LuTerminal, LuFileText, LuFolderOpen, LuImage, LuImagePlus, LuRotateCcw, LuSquare, LuMessageSquareText, LuSlidersHorizontal } from "react-icons/lu";
import { VoicePictures, shownPictures } from "./VoicePictures";
import { VoiceConversation } from "./VoiceConversation";
import { VoiceSettings, VOICE_RATES } from "./VoiceSettings";
import { ACTIONS, describe, matches, useKeyLabels, useKeybindings, type ActionId } from "../keybindings";
import { MIN, clearOfDock, dockBox, dockSize, freeStrip, placeWindows, type Orb } from "../voice-windows";
import { ErrorBoundary, PartFailed } from "./ErrorBoundary";
import { LuPuzzle } from "react-icons/lu";
import { useSlot, type ChatProps, type Registered } from "../extensions/slots";
import { channelFor } from "../extensions/channel";
import { panelsFor } from "../extensions/panels";
import { ResizeHandles, WINDOWS, areaFor, clearSize, openWindows, workspaceOf } from "./ResizeHandles";
import { IMAGE_TYPES, isImage, type Attachment } from "../attachments";
import type { ToolCall } from "../tool-activity";
import { VoiceTerminal } from "./VoiceTerminal";
import { api, type PortalEvent } from "../api";
import type { VoiceCue } from "../voice-cues";
import type { VoicePhase } from "../hands-free";
import { t } from "../i18n";
import { VoiceOrb, useOrbStyle, type VoiceLevels } from "./VoiceOrb";

export type { VoiceLevels } from "./VoiceOrb";
type OrbMode = "input" | "output" | "idle" | "muted";

/** What a window's place and size slide by (see stage.css). */
const GEOMETRY = new Set(["left", "top", "right", "width", "height", "transform"]);

/**
 * The fields the browser viewer takes keys through for the remote page —
 * everything typed there, into the page or its address bar, goes by one of
 * these, not to a field of the viewer's own. On a desktop and with the
 * on-screen keyboard.
 */
const VIEWER_KEYS = "#overlayInput, #keyboard-input-assist";

/** Wide enough for the orb to stand beside a window, or in a gap between them. */
const WIDE = "(min-width: 601px)";
const watchWide = (changed: () => void) => {
  const query = matchMedia(WIDE);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};

/** Where focus is typing, so Space and a paste belong to that and not to voice mode. */
const editing = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/**
 * A window an extension brought to voice mode: placed and sized as Files, the
 * pictures and the conversation are, with what the extension draws in it. It
 * is there only while open; one that fails to draw says so in its window.
 */
function BroughtWindow({ entry, main, onClose, ...props }: ChatProps & { entry: Registered<"voice.window">; main: boolean; onClose: () => void }) {
  const section = useRef<HTMLElement>(null);
  // The same function each time it is drawn: what is in the window is drawn again only for what is new in what it is handed.
  const latest = useRef(onClose);
  latest.current = onClose;
  const close = useCallback(() => latest.current(), []);
  return (
    <section ref={section} className={`voice-files-window voice-extension-window ${main ? "as-main" : "as-side"} is-open`} aria-label={entry.title} data-extension={entry.extension}>
      <header><span>{entry.icon ? <entry.icon /> : <LuPuzzle />}{entry.title}</span><div><button type="button" aria-label={t("Minimize {panel}", { panel: entry.title })} title={t("Minimize")} onClick={onClose}><LuMinus /></button></div></header>
      <ErrorBoundary resetKey={`${entry.key}:${props.chat.id}`} fallback={(error) => <div className="p-4"><PartFailed error={error} /></div>}>
        <entry.component key={props.chat.id} {...props} close={close} />
      </ErrorBoundary>
      <ResizeHandles target={section} />
    </section>
  );
}

export function VoiceStage({ sessionId, folder, workPhase, canvasOpen, onCanvasMinimize, onCanvasToggle, title, phase, starting, muted, speaking, levels, error, transcript, onMute, onEnd, browserAvailable, browserActivity, terminalActivity, toolEvents, sounds, onSounds, onCue,
  waitingForTap, items, errorsAfter, running, onStop, attachments, onAddPictures, onRemovePicture, canRepeat, onRepeat, rate, onRate, steer, onSteer, ptt, onPtt, holding, onHold }: {
  sessionId: string; folder: string;
  workPhase?: Activity | null;
  canvasOpen: boolean; onCanvasMinimize: () => void; onCanvasToggle: () => void;
  title: string; phase: VoicePhase; starting: boolean; muted: boolean; speaking: boolean;
  levels: MutableRefObject<VoiceLevels>; transcript: string; error: string; onMute: () => void; onEnd: () => void;
  browserAvailable: boolean; browserActivity: number; terminalActivity: number; toolEvents: PortalEvent[]; sounds: boolean; onSounds: () => void; onCue: (kind: VoiceCue) => void;
  /** Back after a reload, and waiting for a tap before audio may start. */
  waitingForTap?: boolean;
  items: Item[];
  /** Where voice mode's controller began (null until it has): only errors after it open the conversation, as only those are said. */
  errorsAfter: number | null; running: boolean; onStop: () => void;
  /** Pictures waiting to go with the next thing said. */
  attachments: Attachment[]; onAddPictures: (files: File[]) => void; onRemovePicture: (id: string) => void;
  canRepeat: boolean; onRepeat: () => void;
  rate: number; onRate: (rate: number) => void;
  steer: boolean; onSteer: (steer: boolean) => void;
  ptt: boolean; onPtt: (ptt: boolean) => void; holding: boolean; onHold: (down: boolean) => void;
}) {
  const end = useRef<HTMLButtonElement>(null), browser = useRef<HTMLElement>(null), stage = useRef<HTMLElement>(null);
  // The browser made as large as the stage allows. Not the browser's own
  // fullscreen: that took the whole of the person's browser with it, and
  // closing the window here did not give it back.
  const [browserMax, setBrowserMax] = useState(false);
  // Where the orb stands once a window has been sized by hand: in a gap, or
  // in its dock. Measured after the windows have moved, for the arrangement
  // they were in then — and for no other: see `presence` below.
  const [placed, setPlaced] = useState<{ for: string; at: "free" | "dock" | null }>({ for: "", at: null });
  const wide = useSyncExternalStore(watchWide, () => matchMedia(WIDE).matches);
  const activity = useRef(browserActivity), terminalSeen = useRef(terminalActivity);
  const terminal = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false), [terminalShown, setTerminalShown] = useState(false);
  const [filesShown, setFilesShown] = useState(false), [filesUsed, setFilesUsed] = useState(false), [filesSince, setFilesSince] = useState<number | undefined>(undefined);
  const filesWindow = useRef<HTMLElement>(null), picturesWindow = useRef<HTMLElement>(null), conversationWindow = useRef<HTMLElement>(null);
  // Pictures the agent showed with show_image or made with generate_image or edit_image. A new one opens the window on it.
  const pictures = useMemo(() => shownPictures(toolEvents), [toolEvents]);
  const picturesSeen = useRef(pictures.at(-1)?.seq ?? 0);
  const [picturesShown, setPicturesShown] = useState(false), [pictureIndex, setPictureIndex] = useState(0);
  const [conversation, setConversation] = useState(false), [settings, setSettings] = useState(false);
  // A failure is said in one short line and written in the conversation, which
  // opens on it: only an error that came after voice mode began, by the same
  // mark the speaking side uses. Before that mark is known (the chat may still
  // be replaying its history) nothing counts, so old errors never open it.
  const errorsSeen = useRef(0);
  useEffect(() => {
    if (errorsAfter === null) return;
    let newest = Math.max(errorsSeen.current, errorsAfter);
    const before = newest;
    for (const item of items) if (item.kind === "notice" && item.tone === "error") newest = Math.max(newest, Number(item.id.slice(1)) || 0);
    errorsSeen.current = newest;
    if (newest > before) setConversation(true);
  }, [items, errorsAfter]);
  const settingsToggle = useRef<HTMLButtonElement>(null);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // The windows the installed extensions brought (the `voice.window` slot), by their entry's key: those still there.
  const windowEntries = useSlot("voice.window");
  const [broughtOpen, setBroughtOpen] = useState<readonly string[]>([]);
  const brought = windowEntries.filter((entry) => broughtOpen.includes(entry.key));
  const broughtShown = Object.fromEntries(brought.map((entry) => [`x:${entry.key}`, true])) as Record<`x:${string}`, boolean>;
  const closeBrought = (key: string) => setBroughtOpen((open) => open.filter((k) => k !== key));
  const chat = useMemo(() => ({ id: sessionId, title, workspace: folder }), [sessionId, title, folder]);
  useWorkPanels({ browser: shown, terminal: terminalShown, canvas: canvasOpen, files: filesShown, pictures: picturesShown, conversation, ...broughtShown }, panel => {
    if (panel.startsWith("x:")) closeBrought(panel.slice(2)); else
    if (panel === "browser") setShown(false); else if (panel === "terminal") setTerminalShown(false); else if (panel === "files") setFilesShown(false); else if (panel === "pictures") setPicturesShown(false); else if (panel === "conversation") setConversation(false); else onCanvasMinimize();
  });
  // What the agent reads or changes in the chat's folder. Files opens on it as
  // the browser and terminal do, and follows it from there. A file opened from
  // a tool card is put after everything that has happened, so that the panel
  // takes it, and the agent's next file after that again.
  const lastFile = useRef<FileActivity | null>(null);
  const agentFile = useMemo(() => (lastFile.current = keepFileActivity(lastFile.current, latestFileActivity(toolEvents, folder))), [toolEvents, folder]);
  const [openedFile, setOpenedFile] = useState<FileActivity | null>(null);
  const fileActivity = openedFile && openedFile.seq > (agentFile?.seq ?? 0) ? openedFile : agentFile;
  const filesSeen = useRef(agentFile?.seq ?? 0);
  // Where the windows go: the browser in the middle, the terminal at the side,
  // and Files and pictures wherever is left (see voice-windows.ts). The stage's
  // classes say whether there is a window in the middle and one at the side,
  // for where the orb goes; which window is open is the window's own `is-open`.
  const place = placeWindows({ browser: shown, terminal: terminalShown, files: filesShown, pictures: picturesShown, conversation, ...broughtShown });
  const filesMain = place.main === "files", picturesMain = place.main === "pictures", conversationMain = place.main === "conversation";
  const browsing = !!place.main;
  const sideWindow = !!place.side;
  const [loaded, setLoaded] = useState(false);
  const [terminalUsed, setTerminalUsed] = useState(false);
  const [browserError, setBrowserError] = useState('');
  const thoughtViewport = useRef<HTMLDivElement>(null);
  const thought = useMemo(() => {
    const latest = items.at(-1);
    return latest?.kind === 'assistant' && !latest.done && !latest.text ? latest.thinking : '';
  }, [items]);
  useEffect(() => {
    const el = thoughtViewport.current;
    if (!el) return;
    const follow = () => { el.scrollTop = el.scrollHeight; };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [thought, shown, terminalShown, filesShown, picturesShown, conversation]);
  useEffect(() => { end.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (browser.current) browser.current.inert = !shown;
    if (terminal.current) terminal.current.inert = !terminalShown;
    if (filesWindow.current) filesWindow.current.inert = !filesShown;
    if (picturesWindow.current) picturesWindow.current.inert = !picturesShown;
    if (conversationWindow.current) conversationWindow.current.inert = !conversation;
  }, [shown, terminalShown, filesShown, picturesShown, conversation]);
  useEffect(() => {
    if (!agentFile || agentFile.seq <= filesSeen.current) return;
    filesSeen.current = agentFile.seq;
    // The first time, the panel starts from just before this, so it shows it.
    if (!filesUsed) { setFilesSince(agentFile.seq - 1); setFilesUsed(true); }
    setFilesShown(true); onCue("focus");
  }, [agentFile?.seq, filesUsed, onCue]);
  useEffect(() => {
    const last = pictures.at(-1);
    if (!last || last.seq <= picturesSeen.current) return;
    picturesSeen.current = last.seq;
    setPictureIndex(pictures.length - 1); setPicturesShown(true); onCue("focus");
  }, [pictures, onCue]);
  const openTerminal = () => { setTerminalUsed(true); setTerminalShown(true); onCue("focus"); };
  const openPictures = () => { setPictureIndex(Math.max(0, pictures.length - 1)); setPicturesShown(true); onCue("focus"); };
  /** A tool card was tapped: bring up what it was about. */
  const openCall = (call: ToolCall) => {
    if (call.target === "files" && call.path) {
      const seq = toolEvents.reduce((n, e) => Math.max(n, e.seq), fileActivity?.seq ?? 0) + 0.5;
      if (!filesUsed) { setFilesSince(seq - 1); setFilesUsed(true); }
      setOpenedFile({ seq, path: call.path, tool: "read" }); setFilesShown(true); onCue("focus");
    } else if (call.target === "terminal") openTerminal();
    else if (call.target === "browser") open();
    else if (call.target === "canvas") { if (!canvasOpen) onCanvasToggle(); }
    else if (call.target === "pictures") openPictures();
  };
  // Pictures pasted anywhere on the stage go with the next thing said; a paste
  // into something being typed in is that field's.
  const add = useRef(onAddPictures); add.current = onAddPictures;
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (editing(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(f => isImage(f.type));
      if (!files.length) return;
      e.preventDefault(); add.current(files);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, []);
  // Keyboard shortcuts (see keybindings.ts). Each action says whether it did
  // anything: one that did not — Stop with nothing running — leaves the key to
  // whatever else wants it. Starting and ending voice mode is VoiceControl's.
  const bindings = useKeybindings(), layout = useKeyLabels();
  const hint = (id: ActionId) => bindings[id] ? ` (${describe(bindings[id], layout)})` : "";
  const step = (by: number) => {
    const at = VOICE_RATES.indexOf(rate), next = VOICE_RATES[Math.min(VOICE_RATES.length - 1, Math.max(0, (at < 0 ? 0 : at) + by))];
    if (next === rate) return false;
    onRate(next); return true;
  };
  const actions: Partial<Record<ActionId, () => boolean | void>> = {
    "voice.mute": () => { if (ptt || starting) return false; onMute(); },
    // Stops the agent while it works; with nothing running, ends voice mode.
    "voice.stop": () => { if (running) onStop(); else onEnd(); },
    "voice.picture": () => { picker.current?.click(); },
    "voice.repeat": () => { if (!canRepeat || speaking) return false; onRepeat(); },
    "voice.conversation": () => { if (!conversation) onCue("focus"); setConversation(v => !v); },
    "voice.canvas": () => { onCanvasToggle(); },
    "voice.files": () => { if (filesShown) setFilesShown(false); else openFiles(); },
    "voice.pictures": () => { if (picturesShown) setPicturesShown(false); else if (pictures.length) openPictures(); else return false; },
    "voice.terminal": () => { if (terminalShown) setTerminalShown(false); else openTerminal(); },
    "voice.browser": () => { if (shown) minimize(); else if (browserAvailable || loaded) open(); else return false; },
    "voice.settings": () => { setSettings(v => !v); },
    "voice.faster": () => step(1),
    "voice.slower": () => step(-1),
    "voice.steer": () => { onSteer(!steer); },
    "voice.ptt": () => { onPtt(!ptt); },
    "voice.sounds": () => { onSounds(); },
  };
  const maximized = browserMax && shown;
  const keys = useRef({ bindings, actions, ptt, onHold, maximized }); keys.current = { bindings, actions, ptt, onHold, maximized };
  useEffect(() => {
    // In the capture phase, before a focused button: holding Space for
    // push-to-talk would otherwise also press whatever button has focus.
    const down = (e: KeyboardEvent) => {
      const { bindings, actions, ptt, onHold } = keys.current;
      // A dialog, or the voice settings card closing on Escape, has the key.
      // So has the confirmation a link in a reply asks before it leaves: it is no aria-modal, and Escape there would otherwise stop the agent or end voice mode.
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"], [data-streamdown="link-safety-modal"]')) return;
      if (e.code === "Escape" && document.querySelector(".voice-settings")) return;
      // Escape gives a maximized browser its place back before it stops anything.
      if (e.code === "Escape" && keys.current.maximized && !editing(e.target)) {
        e.preventDefault(); e.stopPropagation(); setBrowserMax(false);
        return;
      }
      const typing = editing(e.target);
      if (ptt && matches(bindings["voice.hold"], e) && !(typing && !e.ctrlKey && !e.altKey && !e.metaKey)) {
        e.preventDefault(); e.stopPropagation();
        if (!e.repeat) onHold(true);
        return;
      }
      for (const action of ACTIONS) {
        const act = actions[action.id];
        if (!act || !matches(bindings[action.id], e)) continue;
        const b = bindings[action.id]!;
        if (typing && !(b.ctrl || b.alt || b.meta)) return;
        if (e.repeat) { e.preventDefault(); return; }
        if (act() !== false) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
    };
    const up = (e: KeyboardEvent) => {
      const { bindings, ptt, onHold } = keys.current;
      if (!ptt || !matches(bindings["voice.hold"], e)) return;
      e.preventDefault(); e.stopPropagation(); onHold(false);
    };
    const away = () => { holder.current = null; if (keys.current.ptt) keys.current.onHold(false); };
    window.addEventListener("keydown", down, true); window.addEventListener("keyup", up, true); window.addEventListener("blur", away);
    return () => { window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); window.removeEventListener("blur", away); };
  }, []);
  const openFiles = () => {
    setFilesUsed(true); setFilesShown(true); onCue("focus");
  };
  useEffect(() => {
    if (terminalActivity <= terminalSeen.current) return;
    terminalSeen.current = terminalActivity;
    openTerminal();
  }, [terminalActivity, onCue]);
  useEffect(() => {
    if (browserActivity <= activity.current) return;
    activity.current = browserActivity;
    let cancelled = false;
    void api.browser().then(status => {
      if (cancelled) return;
      if (status.install.container !== 'running') { setBrowserError(t('The browser viewer is unavailable.')); return; }
      setBrowserError(''); setLoaded(true); setShown(true); onCue('focus');
    }).catch(() => { if (!cancelled) setBrowserError(t('Could not connect to the browser viewer.')); });
    return () => { cancelled = true; };
  }, [browserActivity, onCue]);
  const open = () => { setLoaded(true); setShown(true); onCue('focus'); };
  const minimize = () => { setShown(false); end.current?.focus({ preventScroll: true }); };
  // However the browser was put away — minimized, or closed for a third
  // window — it comes back at its usual size, and Escape is Stop's again.
  useEffect(() => { if (!shown) setBrowserMax(false); }, [shown]);
  // A window opening — by the person or for what the agent does — is there
  // to be seen, and would open under the browser: it gives its place back.
  // Each window by itself: one opening can close another for room.
  const others = [terminalShown, filesShown, picturesShown, conversation, canvasOpen];
  const othersBefore = useRef(others);
  useEffect(() => {
    if (others.some((open, i) => open && !othersBefore.current[i])) setBrowserMax(false);
    othersBefore.current = others;
  }, others);
  // Escape restores the browser from inside it too, as it left fullscreen:
  // once the page in it has focus, the key is that page's and never reaches
  // the stage. Heard before the viewer, which would pass it on to the page.
  // A field of the viewer's own keeps its Escape, as one on the stage does —
  // but not the field the viewer takes the remote page's keys through, which
  // has focus whenever the page does.
  const frameKeys = (frame: HTMLIFrameElement) => {
    try {
      frame.contentWindow?.addEventListener("keydown", e => {
        if (e.code !== "Escape" || !keys.current.maximized) return;
        if (editing(e.target) && !(e.target as Element).matches(VIEWER_KEYS)) return;
        e.preventDefault(); e.stopPropagation(); setBrowserMax(false);
      }, true);
    } catch { /* not the portal's page: its keys stay its own */ }
  };
  // A press on the microphone button or the orb holds the key down; the pointer is captured so that sliding off, or a touch the phone turns into a scroll or a long-press menu, still ends it where it began. Only the finger that started the hold ends it: a second one lifting is not the first letting go.
  const holder = useRef<number | null>(null);
  // Turning push-to-talk off mid-hold takes the handlers away, so the lift never arrives; the next hold must not find the old one still there.
  useEffect(() => { holder.current = null; }, [ptt]);
  const release = (e: ReactPointerEvent<HTMLElement>) => { if (holder.current !== e.pointerId) return; holder.current = null; onHold(false); };
  const holdHandlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => { e.preventDefault(); if (holder.current !== null) return; holder.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); onHold(true); },
    onPointerUp: release, onPointerCancel: release, onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
  };
  const input = !muted && phase === "Hearing you";
  const mode: OrbMode = input ? "input" : speaking ? "output" : muted ? "muted" : "idle";
  const orbStyle = useOrbStyle(sessionId);
  const touch = typeof matchMedia === "function" && matchMedia("(hover: none)").matches;
  const status = waitingForTap ? (touch ? t("Tap to continue voice mode") : t("Click or press a key to continue voice mode")) : starting ? t("Connecting") : input || holding ? t("Hearing you") : speaking ? t("Speaking") : phase === "Speaking" ? t("Preparing your reply") : phase === "Thinking" ? t("Thinking") : phase === "Transcribing" ? t("Transcribing") : muted ? t("Microphone muted") : ptt ? (touch || !bindings["voice.hold"] ? t("Hold the microphone to talk") : t("Hold {keys} to talk", { keys: describe(bindings["voice.hold"], layout) })) : t("Listening");
  const anyPanel = shown || terminalShown || filesShown || picturesShown || conversation;
  // A window sized by hand keeps its size until the windows are arranged
  // differently — one opens or closes — and then the layout places it again.
  // Before it is drawn, so that no frame shows the new arrangement with the
  // old sizes. Not as voice mode opens: the canvas may have been sized in the
  // chat before, and keeps that until the windows change around it here.
  const arrangement = `${place.main}|${place.side}|${canvasOpen}`;
  const arranged = useRef(arrangement);
  useLayoutEffect(() => {
    if (arranged.current === arrangement) return;
    arranged.current = arrangement;
    const canvas = stage.current && workspaceOf(stage.current)?.querySelector<HTMLElement>(".canvas-panel");
    for (const el of [browser.current, terminal.current, filesWindow.current, picturesWindow.current, conversationWindow.current, canvas ?? null]) clearSize(el);
    for (const el of stage.current?.querySelectorAll<HTMLElement>(".voice-extension-window") ?? []) clearSize(el);
  }, [arrangement]);
  // What the orb's place was measured for. Anything else — a window opened or
  // closed, the browser maximized — has no sizes set by hand yet, so the orb
  // is where the layout puts it from the first frame, not where it stood in
  // the arrangement before until it is measured again.
  const placing = `${arrangement}|${maximized}`;
  const presence = placed.for === placing ? placed.at : null;
  // Once a window has been sized by hand, the orb goes where there is room
  // for it: into a gap wide enough between the windows, as it stands with
  // nothing open, or back into its dock when the windows close the gap — and
  // a window that reached down where the dock goes is made to end above it.
  // It follows as an edge is dragged. Set on the element rather than through
  // state, so that a drag does not draw the whole stage again at every move.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const root = workspaceOf(el) ?? el;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const windows = openWindows(root);
        const box = el.getBoundingClientRect();
        const sized = matchMedia(WIDE).matches && !maximized && windows.some(w => w.dataset.sized);
        const strip = sized ? freeStrip(box, windows.map(w => w.getBoundingClientRect())) : null;
        setPlaced({ for: placing, at: strip ? "free" : sized ? "dock" : null });
        // Not the one being dragged: the drag keeps it clear of the dock
        // itself, and lifting it here as well would fight the pointer. Done
        // when it is let go.
        if (sized && !strip && !document.body.classList.contains("is-resizing")) {
          const dock = dockBox(box, dockSize(el));
          for (const w of windows) {
            if (!w.dataset.sized) continue;
            const at = w.getBoundingClientRect();
            // No shorter than it may be — nor than its own styles let it be.
            const least = Math.max(MIN.height, parseFloat(getComputedStyle(w).minHeight) || 0);
            const to = clearOfDock(dock, at, least, w.dataset.sized === "pin", areaFor(w).top);
            if (!to) continue;
            if (to.top !== at.top) w.style.top = `${to.top - ((w.offsetParent as HTMLElement | null)?.getBoundingClientRect().top ?? 0)}px`;
            w.style.height = `${to.height}px`;
          }
        }
        if (!strip) return;
        el.style.setProperty("--free-x", `${Math.round(strip.center - box.left)}px`);
        el.style.setProperty("--free-width", `${Math.round(strip.width)}px`);
      });
    };
    // A window done sliding into place — not every hover and fade on the stage.
    const settled = (e: TransitionEvent) => {
      if (GEOMETRY.has(e.propertyName) && (e.target as Element).matches?.(`${WINDOWS}, .session-canvases.is-open`)) place();
    };
    place();
    document.addEventListener("panel-resize", place);
    root.addEventListener("transitionend", settled);
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("panel-resize", place); root.removeEventListener("transitionend", settled); observer.disconnect(); };
  }, [placing]);
  const drop = (e: DragEvent) => {
    if (e.defaultPrevented || !e.dataTransfer.types.includes("Files")) return;
    // Portaled from inside Chat's form, it would bubble on to the form's own drop.
    e.preventDefault(); e.stopPropagation(); setDropping(false);
    add.current([...e.dataTransfer.files]);
  };
  const panels = Number(shown) + Number(terminalShown) + Number(filesShown) + Number(picturesShown) + Number(conversation) + Number(canvasOpen) + brought.length;
  // Where the orb is, said once for the stage's styles and for the windows
  // being resized (see Orb). In its dock under a maximized browser, or when
  // the windows sized by hand leave no gap wide enough; in the gap when they
  // do. Otherwise, on a wide screen, beside a single window — the canvas too
  // — and in its dock under two; on a phone, in its dock under any window of
  // the stage's own. With nothing open it stands in the middle.
  const stageWindows = browsing || sideWindow;
  const orb: Orb | undefined = maximized || presence === "dock" ? "dock" : presence === "free" ? "free" : panels === 1 && wide ? "beside" : stageWindows ? "dock" : undefined;
  // is-docked: the compact chrome that goes with a window open — the dock's
  // styles, and the pictures and cards out of the windows' way — over which
  // the orb standing on its own has its own.
  return <section ref={stage} className={`voice-stage ${browsing ? 'is-browsing' : ''} ${sideWindow ? 'is-terminal' : ''} ${stageWindows || orb === "dock" ? 'is-docked' : ''} ${dropping ? 'is-dropping' : ''}`} aria-label={t("Voice conversation")} data-panels={panels} data-orb={orb} data-mode={mode}
    onDragOver={e => { if (e.defaultPrevented || !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropping(true); }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
    onDrop={drop}>
    <header className="voice-stage-header">
      <span className="voice-stage-session">{title}</span>
      <div className="voice-utilities">
        {!conversation && <button type="button" onClick={() => { setConversation(true); onCue("focus"); }} title={`${t("Conversation")}${hint("voice.conversation")}`} aria-label={t("Show the conversation")}><LuMessageSquareText /></button>}
        <button type="button" onClick={onCanvasToggle} title={`${t("Session canvases")}${hint("voice.canvas")}`} aria-label={t("Session canvases")} aria-expanded={canvasOpen}><LuFileText /></button>
        {!filesShown && <button type="button" onClick={openFiles} title={`${t("Show files")}${hint("voice.files")}`} aria-label={t("Show files")}><LuFolderOpen /></button>}
        {pictures.length > 0 && !picturesShown && <button type="button" onClick={openPictures} title={`${t("Show pictures")}${hint("voice.pictures")}`} aria-label={t("Show pictures")}><LuImage /></button>}
        {(browserAvailable || loaded) && !shown && <button type="button" onClick={open} title={`${t("Show browser")}${hint("voice.browser")}`} aria-label={t("Show browser")}><LuGlobe /></button>}
        {!terminalShown && <button type="button" aria-label={t("Show terminal")} title={`${t("Show terminal")}${hint("voice.terminal")}`} onClick={openTerminal}><LuTerminal /></button>}
        {windowEntries.filter((entry) => !broughtOpen.includes(entry.key)).map((entry) => (
          <button key={entry.key} type="button" aria-label={t("Show {panel}", { panel: entry.title })} title={entry.title} onClick={() => { setBroughtOpen((open) => [...open, entry.key]); onCue("focus"); }}>
            {entry.icon ? <entry.icon /> : <LuPuzzle />}
          </button>
        ))}
        <button ref={settingsToggle} type="button" data-voice-settings-toggle onClick={() => setSettings(v => !v)} title={`${t("Voice settings")}${hint("voice.settings")}`} aria-label={t("Voice settings")} aria-expanded={settings}><LuSlidersHorizontal /></button>
      </div>
      {settings && <VoiceSettings anchor={settingsToggle} sounds={sounds} onSounds={onSounds} rate={rate} onRate={onRate} steer={steer} onSteer={onSteer} ptt={ptt} onPtt={onPtt} onClose={() => setSettings(false)} />}
    </header>
    {attachments.length > 0 && <div className="voice-attachments" role="group" aria-label={t("Pictures for your next message")}>
      <div>{attachments.map(a => <figure key={a.id}>
        <img src={a.data} alt={a.name} />
        <button type="button" aria-label={t("Remove {name}", { name: a.name })} title={t("Remove")} onClick={() => onRemovePicture(a.id)}><LuX /></button>
      </figure>)}</div>
      <span>{t("Sent with what you say next")}</span>
    </div>}
    {dropping && <div className="voice-drop-hint" aria-hidden="true"><LuImagePlus />{t("Drop pictures to send them with what you say next")}</div>}
    <input ref={picker} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) onAddPictures(files); }} />
    <section ref={browser} className={`voice-browser-window ${shown ? 'is-open' : ''} ${maximized ? 'is-maximized' : ''}`} aria-label={t("Live browser")} aria-hidden={!shown}>
      <header><span><i />{t("Live browser")}</span><div>
        {maximized
          ? <button type="button" aria-label={t("Restore browser size")} title={t("Restore size (Esc)")} onClick={() => setBrowserMax(false)}><LuMinimize2 /></button>
          : <button type="button" aria-label={t("Maximize browser")} title={t("Maximize")} onClick={() => setBrowserMax(true)}><LuMaximize2 /></button>}
        <button type="button" aria-label={t("Minimize browser")} title={t("Minimize browser")} onClick={minimize}><LuMinus /></button>
      </div></header>
      {loaded && <iframe onLoad={e => frameKeys(e.currentTarget)} src="/browser-ui/" title={t("The agent's browser")} allow="clipboard-read; clipboard-write; fullscreen" />}
      <ResizeHandles target={browser} />
    </section>
    <section ref={terminal} className={`voice-terminal-window ${terminalShown ? 'is-open' : ''}`} aria-label={t("Live terminal")} aria-hidden={!terminalShown}>
      <header><span><LuTerminal />{t("Terminal")}</span><div><button type="button" aria-label={t("Minimize terminal")} title={t("Minimize terminal")} onClick={() => { setTerminalShown(false); end.current?.focus({ preventScroll: true }); }}><LuMinus /></button></div></header>
      {terminalUsed && <VoiceTerminal events={toolEvents} />}
      <ResizeHandles target={terminal} />
    </section>
    <section ref={filesWindow} className={`voice-files-window ${filesMain ? 'as-main' : 'as-side'} ${filesShown ? 'is-open' : ''}`} aria-label={t("Files")} aria-hidden={!filesShown}>
      <header><span><LuFolderOpen />{t("Files")}</span><div><button type="button" aria-label={t("Minimize files")} title={t("Minimize files")} onClick={() => { setFilesShown(false); end.current?.focus({ preventScroll: true }); }}><LuMinus /></button></div></header>
      {filesUsed && <FilesPanel key={sessionId} sessionId={sessionId} folder={folder} activity={fileActivity} since={filesSince} />}
      <ResizeHandles target={filesWindow} />
    </section>
    <section ref={picturesWindow} className={`voice-files-window voice-pictures-window ${picturesMain ? 'as-main' : 'as-side'} ${picturesShown ? 'is-open' : ''}`} aria-label={t("Pictures")} aria-hidden={!picturesShown}>
      <header><span><LuImage />{t("Pictures")}</span><div><button type="button" aria-label={t("Minimize pictures")} title={t("Minimize pictures")} onClick={() => { setPicturesShown(false); end.current?.focus({ preventScroll: true }); }}><LuMinus /></button></div></header>
      {picturesShown && <VoicePictures sessionId={sessionId} pictures={pictures} index={Math.min(pictureIndex, pictures.length - 1)} onIndex={setPictureIndex} />}
      <ResizeHandles target={picturesWindow} />
    </section>
    <section ref={conversationWindow} className={`voice-files-window voice-conversation-window ${conversationMain ? 'as-main' : 'as-side'} ${conversation ? 'is-open' : ''}`} aria-label={t("Conversation")} aria-hidden={!conversation}>
      <header><span><LuMessageSquareText />{t("Conversation")}</span><div><button type="button" aria-label={t("Close the conversation")} title={t("Close")} onClick={() => { setConversation(false); end.current?.focus({ preventScroll: true }); }}><LuMinus /></button></div></header>
      {conversation && <VoiceConversation sessionId={sessionId} items={items} />}
      <ResizeHandles target={conversationWindow} />
    </section>
    {brought.map((entry) => (
      <BroughtWindow key={entry.key} entry={entry} main={place.main === `x:${entry.key}`} chat={chat} channel={channelFor(sessionId, entry.extension)} panels={panelsFor(entry.extension)}
        onClose={() => { closeBrought(entry.key); end.current?.focus({ preventScroll: true }); }} />
    ))}
    <VoiceToolActivity events={toolEvents} sessionId={sessionId} folder={folder} onOpen={openCall} />
    <div className="voice-presence">
      {/* With push-to-talk on, the orb can be held as well as the microphone button: it is the big target on a phone. */}
      <div className={`voice-avatar ${ptt ? "is-holdable" : ""}`} {...(ptt && !starting ? holdHandlers : {})}><VoiceOrb mode={mode} levels={levels} look={orbStyle} /></div>
      <div className="voice-dock-center">
        {workPhase && (workPhase.label === 'processing the prompt' || workPhase.label === 'compacting the conversation') ? <ActivityProgress phase={workPhase} /> : <>
        <div className="voice-status" role="status"><span />{phase === 'Compacting context' ? t('Compacting context') : thought && anyPanel ? t("Thinking") : status}</div>
        {anyPanel && thought && phase !== 'Compacting context' && <div ref={thoughtViewport} className="voice-thought-stream" role="group" aria-label={t("Live model thinking")}>{thought.slice(-1200)}</div>}
        </>}
      </div>
      {!anyPanel && transcript && (input || holding || phase === "Transcribing") && <p className="voice-live-transcript" role="group" aria-label={t("Live transcription")}>{transcript}</p>}

      <div className="voice-stage-controls">
        {ptt
          ? <button type="button" className={`voice-stage-action voice-hold ${holding ? "is-holding" : ""}`} title={`${t("Hold to talk")}${touch ? "" : hint("voice.hold")}`} aria-label={t("Hold to talk")} aria-pressed={holding} disabled={starting}
              {...holdHandlers}><LuMic /></button>
          : <button type="button" className={`voice-stage-action ${muted ? "is-muted" : ""}`} title={`${muted ? t('Unmute microphone') : t('Mute microphone')}${hint('voice.mute')}`} aria-label={muted ? t("Unmute microphone") : t("Mute microphone")} aria-pressed={muted} disabled={starting} onClick={onMute}><LuMicOff className={muted ? '' : 'hidden'} /><LuMic className={muted ? 'hidden' : ''} /></button>}
        <button type="button" className={`voice-stage-action ${attachments.length ? "has-pictures" : ""}`} title={`${t("Add a picture")}${hint("voice.picture")}`} aria-label={t("Add a picture")} disabled={starting} onClick={() => picker.current?.click()}><LuImagePlus />{attachments.length > 0 && <i>{attachments.length}</i>}</button>
        <button type="button" className="voice-stage-action" title={`${t("Repeat the last reply")}${hint("voice.repeat")}`} aria-label={t("Repeat the last reply")} disabled={starting || !canRepeat || speaking} onClick={onRepeat}><LuRotateCcw /></button>
        {running && <button type="button" className="voice-stage-action voice-stop" title={`${t("Stop what the agent is doing")}${hint("voice.stop")}`} aria-label={t("Stop the agent")} onClick={onStop}><LuSquare /></button>}
        <button ref={end} type="button" className="voice-stage-action voice-end" title={`${t("End voice mode")}${hint("voice.toggle")}${running || !bindings["voice.stop"] ? "" : ` ${t("or {keys}", { keys: describe(bindings["voice.stop"], layout) })}`}`} aria-label={t("End voice mode")} onClick={onEnd}><LuX /></button>
      </div>
    </div>
    {(error || browserError) && <p role="alert" className="voice-stage-error">{error || browserError}</p>}
  </section>;
}
