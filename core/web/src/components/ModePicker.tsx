import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LuCheck, LuChevronDown, LuPlus } from "react-icons/lu";
import { useNavigate } from "react-router-dom";
import type { ChatMode } from "../api";
import { translate } from "../extensions/strings";
import { labelOf, msg, t } from "../i18n";
import { useLeaveRef } from "../motion";
import { useDismiss } from "../use-dismiss";
import { confirmDialog } from "./ConfirmDialog";

/**
 * Chat modes: how a chat works, chosen above the message box before its first message and fixed once it has one.
 * The portal's own are named here in the page's language, with the same English as the server's list
 * (core/server/src/chat-modes.ts); an extension's through its own translations; a mode neither knows is shown as the
 * server names it.
 */
const LABELS: Record<string, string> = {
  standard: msg("Standard mode"),
  code: msg("Code mode"),
};
const DESCRIPTIONS: Record<string, string> = {
  standard: msg("The agent as this chat would have it anyway: the tools that Settings → Tools, its agent and its project switch on."),
  code: msg("The model works through one tool: it writes a short JavaScript script that calls the chat's tools, and is given only what the script puts out."),
};

/** What a mode is called on the page. */
export const modeLabel = (mode: ChatMode): string => (mode.extension ? translate(mode.extension, mode.label) : labelOf(LABELS, mode.id, () => mode.label));
/** The line that says what a mode does. */
export const modeDescription = (mode: ChatMode): string =>
  mode.extension ? translate(mode.extension, mode.description) : labelOf(DESCRIPTIONS, mode.id, () => mode.description);

/**
 * A stored mode that is not offered now (the person deleted it, its extension stopped): named by the part of what the
 * chat stores after the last "/", and said to be not available.
 */
function unavailable(stored: string): { label: string; title: string } {
  const name = stored.slice(stored.lastIndexOf("/") + 1);
  return { label: name, title: t("{mode} is not available now", { mode: name }) };
}

/**
 * The chip above the message box of a chat that has said nothing yet, and its menu of the modes it may be put in, with
 * the way to make one of your own last (Settings → Modes, over the chat). A button with no type submits the form it is
 * in, the message box's: every button here says it is a button, or choosing a mode would send the draft as the first
 * message, which fixes the mode. A mode that asks first (an extension's `confirm`) is shown in the warning colour, and
 * is chosen only after a yes to its text: `confirmed`.
 */
export function ModePicker({
  chat,
  current,
  modes,
  onChoose,
}: {
  chat: string;
  current: string;
  modes: ChatMode[];
  onChoose: (mode: string, confirmed?: boolean) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Shut, the menu drops away as a picture of itself (see motion.ts).
  const menuRef = useLeaveRef<HTMLDivElement>("menu", menu);
  useDismiss(open, [menu, button], () => setOpen(false), button);

  const chosen = modes.find((mode) => mode.id === current);
  const gone = chosen ? undefined : unavailable(current);
  const label = chosen ? modeLabel(chosen) : gone!.label;

  const entries = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? []);
  // Opened, the focus is on the mode the chat has, or on the first.
  useEffect(() => {
    if (!open) return;
    entries()[Math.max(0, modes.findIndex((mode) => mode.id === current))]?.focus();
  }, [open]);

  const onMenuKey = (e: KeyboardEvent) => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (to: number) => {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    // Away from the menu with the keys is on from the chip.
    else if (e.key === "Tab") {
      button.current?.focus();
      setOpen(false);
    }
  };

  // The mode the chat has already is no change: nothing is saved, and no pi is let go for it.
  const choose = async (mode: ChatMode) => {
    setOpen(false);
    button.current?.focus();
    if (mode.id === current) return;
    if (!mode.confirm) return onChoose(mode.id);
    const name = modeLabel(mode);
    const yes = await confirmDialog({
      title: t("Use {mode}?", { mode: name }),
      message: mode.extension ? translate(mode.extension, mode.confirm) : mode.confirm,
      confirmLabel: t("Use {mode}", { mode: name }),
      danger: true,
    });
    if (yes) onChoose(mode.id, true);
  };

  // The menu is placed in the row the chip is drawn in (positioned there), as wide as it needs: not as narrow as the chip.
  return (
    <div className="text-xs">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-label={t("Mode: {mode}", { mode: label })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={gone?.title}
        className={`rounded-lg px-2 py-1 transition ${open ? "bg-fg/10 text-fg" : chosen?.confirm ? "text-warn hover:bg-fg/5" : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"}`}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          <LuChevronDown aria-hidden className="h-3.5 w-3.5" />
        </span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("Modes")}
          onKeyDown={onMenuKey}
          className="composer-menu float-in absolute bottom-full left-0 z-20 mb-2 w-80 max-w-full rounded-xl border border-line bg-surface py-1 shadow-pop"
        >
          <p className="px-3 py-1 text-[11px] text-fg-subtle">{t("How this chat works. It is fixed once the chat has started.")}</p>
          {modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode.id === current}
              tabIndex={-1}
              onClick={() => void choose(mode)}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-fg/5 focus:bg-fg/[0.07] focus:outline-none"
            >
              <span className="min-w-0 flex-1">
                <span className={`block text-sm ${mode.confirm ? "text-warn" : "text-fg"}`}>{modeLabel(mode)}</span>
                <span className="block text-xs text-fg-subtle">{modeDescription(mode)}</span>
              </span>
              {mode.id === current && <LuCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              navigate(`/s/${chat}/settings/modes`);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-fg/5 focus:bg-fg/[0.07] focus:outline-none"
          >
            <LuPlus aria-hidden className="h-3.5 w-3.5" />
            {t("New mode…")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The chat's mode in its header, once it has started: read only, in the warning colour for one that asked first. A
 * stored mode not offered now says so.
 */
export function ModePill({ stored, modes }: { stored: string; modes: ChatMode[] }) {
  const mode = modes.find((one) => one.id === stored);
  const gone = mode ? undefined : unavailable(stored);
  return (
    <span
      title={mode ? modeDescription(mode) : gone!.title}
      className={`max-w-[12rem] truncate rounded-md px-2 py-0.5 text-[11px] max-md:max-w-[6rem] ${mode?.confirm ? "bg-warn/10 text-warn" : "bg-fg/5 text-fg-subtle"}`}
    >
      {mode ? modeLabel(mode) : gone!.label}
    </span>
  );
}
