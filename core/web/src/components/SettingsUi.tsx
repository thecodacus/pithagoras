import { Children, cloneElement, forwardRef, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { LuChevronRight, LuCircleAlert, LuX } from "react-icons/lu";
import { t } from "../i18n";
import { EFFORT_LEVELS, effortLabel } from "../effort";
import { Select } from "./Select";

/**
 * The pieces every Settings page is built from, so the pages look like one
 * dialog rather than ten: a titled section, a quiet empty state, a switch,
 * and the three kinds of field and button.
 */

export function Section({ title, hint, action, children }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    // Named so Settings' search can scroll to it.
    <section className="settings-section mb-7" data-setting={title}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/**
 * A section that opens and closes: its heading and one line under it are a button, `controls` stay in view
 * whether it is open or not (the switches a person comes for) above the heading, and the rest is `children`,
 * directly under the heading, kept drawn but hidden while it is closed so that what was typed in it is not lost.
 * The line is the `hint` while it is open and the `summary` while it is closed. `whileClosed` is shown under the
 * heading only while it is closed, for what `children` says when it is open. `locked` keeps it open, for a
 * section with something unsaved in it.
 *
 * A search that names the section, or a group in it, opens it: it is told with a `settings-reveal` event on the element it found, which bubbles.
 */
export function CollapsibleSection({
  title,
  hint,
  summary,
  open,
  onToggle,
  locked = false,
  controls,
  whileClosed,
  children,
}: {
  title: string;
  hint: ReactNode;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  locked?: boolean;
  controls?: ReactNode;
  whileClosed?: ReactNode;
  children: ReactNode;
}) {
  const body = useId();
  const root = useRef<HTMLElement>(null);
  const reveal = useRef(onToggle);
  reveal.current = () => {
    if (!open) onToggle();
  };
  useEffect(() => {
    const el = root.current;
    const show = () => reveal.current();
    el?.addEventListener("settings-reveal", show);
    return () => el?.removeEventListener("settings-reveal", show);
  }, []);
  return (
    // Named so Settings' search can scroll to it, and so that it is a region of its own: both models have fields of the same names.
    <section ref={root} aria-label={title} className="settings-section mb-7" data-setting={title}>
      {/* The switches first and the heading under them, one above the other at every width, so that what opens is directly under its heading. */}
      {controls && <div className="mb-3 space-y-3">{controls}</div>}
      <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          aria-disabled={locked || undefined}
          title={locked ? t("Save or discard the changes first.") : undefined}
          onClick={() => !locked && onToggle()}
          className="flex w-full items-start gap-1.5 rounded-lg text-left uppercase tracking-wider transition hover:text-fg"
        >
          <LuChevronRight aria-hidden className={`mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1">
            <span className="block">{title}</span>
            <span className="mt-0.5 block text-xs font-normal normal-case tracking-normal text-fg-subtle">{open ? hint : summary}</span>
          </span>
        </button>
      </h3>
      {!open && whileClosed && <div className="mt-3">{whileClosed}</div>}
      <div id={body} hidden={!open} className="mt-3 space-y-3">
        {children}
      </div>
    </section>
  );
}

/** A group inside a section that opens and closes by itself (a native disclosure): a title, one line under it, and the rest when opened. A search that names it opens it, as it does a section. */
export function DetailsGroup({ title, summary, defaultOpen = false, children }: { title: string; summary: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const root = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = root.current;
    const show = () => {
      if (el) el.open = true;
    };
    el?.addEventListener("settings-reveal", show);
    return () => el?.removeEventListener("settings-reveal", show);
  }, []);
  return (
    <details ref={root} open={defaultOpen} data-setting={title} className="rounded-xl border border-line bg-raised/40">
      {/* The chevron that turns is the page's own for every disclosure (index.css). */}
      <summary className="flex items-center px-3 py-2 text-xs">
        <span className="min-w-0 truncate text-fg-muted" title={title}>{title}</span>
        <span className="ml-auto min-w-0 truncate pl-2 text-fg-faint">{summary}</span>
      </summary>
      <div className="space-y-3 border-t border-line p-3">{children}</div>
    </details>
  );
}

/**
 * A list as a grid where the Settings dialog has room for it (see Modal): two abreast on a laptop, three on a screen
 * wide enough that the dialog is. `gridCls2` stops at two, for a list inside a section that is itself one of two columns.
 */
export const gridCls2 = "grid gap-2 xl:grid-cols-2 [&>*]:min-w-0";
export const gridCls = `${gridCls2} min-[2200px]:grid-cols-3`;

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-3 py-8 text-center text-sm text-fg-subtle">
      {children}
    </div>
  );
}

/**
 * Something that went wrong, said where a person can see it, and as an alert so
 * that a screen reader says it too. With `onClose` it can be put away by hand;
 * whoever owns the message also takes it back when it stops being true — the
 * next poll that works, the next thing asked — so it never outlives its cause.
 */
export const ErrorBanner = forwardRef<HTMLDivElement, { children: ReactNode; onClose?: () => void; className?: string }>(function ErrorBanner({ children, onClose, className = "" }, ref) {
  return (
    <div ref={ref} role="alert" className={`flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger ${className}`}>
      <LuCircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label={t("Dismiss")} title={t("Dismiss")} className="shrink-0 rounded p-0.5 hover:bg-danger/10">
          <LuX aria-hidden className="h-4 w-4" />
        </button>
      )}
    </div>
  );
});

/**
 * Something that worked but not quite as asked, said where the person sees it: the warning's colours, as a status
 * rather than an alert, since nothing failed. Put away by hand, and by whoever owns it when something new is asked.
 */
export function WarnBanner({ children, onClose, className = "" }: { children: ReactNode; onClose?: () => void; className?: string }) {
  return (
    <div role="status" className={`flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn ${className}`}>
      <LuCircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label={t("Dismiss")} title={t("Dismiss")} className="shrink-0 rounded p-0.5 hover:bg-warn/10">
          <LuX aria-hidden className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/**
 * What a page shows when its first read failed. Without it the page keeps its
 * skeleton, or draws "Nobody yet" as fact; both read as "wait" or "empty" and
 * neither says there is something to try again. The button is held while the
 * second try is on its way, so that one that fails again is seen to have run.
 */
export function LoadFailed({ error, onRetry }: { error: string | Error; onRetry: () => unknown }) {
  const [busy, setBusy] = useState(false);
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => void (here.current = false);
  }, []);
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/10 px-3 py-3 text-sm text-danger">
      <LuCircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{t("Could not load this: {error}", { error: typeof error === "string" ? error : error.message })}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onRetry()).finally(() => here.current && setBusy(false));
        }}
        className="shrink-0 rounded px-1.5 underline underline-offset-2 hover:text-fg disabled:opacity-40"
      >
        {t("Try again")}
      </button>
    </div>
  );
}

/** A labelled field, with what it does underneath. */
export function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  // A Select is a button, and so is each choice of a Segments: inside a label, a
  // click anywhere on the label (the hint too) is passed on to the first button,
  // which opens the list or picks the first choice, and names the control twice.
  // A field around one is a div instead, and the Select is named by its own
  // aria-label, or by the field's when it has none.
  const isSelect = (c: ReactNode): c is ReactElement<{ "aria-label"?: string }> => isValidElement(c) && c.type === Select;
  const isButtons = (c: ReactNode) => isSelect(c) || (isValidElement(c) && c.type === Segments);
  if (Children.toArray(children).some(isButtons)) {
    return (
      <div className={`block ${className}`}>
        <span className="text-xs text-fg-muted">{label}</span>
        <div className="mt-1">{Children.map(children, (c) => (isSelect(c) && !c.props["aria-label"] ? cloneElement(c, { "aria-label": label }) : c))}</div>
        {hint && <span className="mt-1 block text-[11px] text-fg-faint">{hint}</span>}
      </div>
    );
  }
  return (
    <label className={`block ${className}`}>
      <span className="text-xs text-fg-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-fg-faint">{hint}</span>}
    </label>
  );
}

/**
 * The track and knob of a switch, drawn alone for a row that is the switch
 * itself — a label and its hint beside it, the whole row one button with
 * `role="switch"` and `aria-checked`. The track has to be a direct child of that
 * button: the knob's motion in motion.css is keyed on `[role="switch"] > span`.
 */
export function SwitchTrack({ on, tone = "accent" }: { on: boolean; tone?: "accent" | "warn" }) {
  return (
    <span className={`relative block h-5 w-9 shrink-0 rounded-full transition-colors ${on ? (tone === "warn" ? "bg-warn" : "bg-accent") : "bg-fg/15"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${on ? "left-[1.125rem]" : "left-0.5"}`} />
    </span>
  );
}

/** On or off, said with a switch rather than a checkbox: it takes effect at once. */
export function Switch({
  on,
  onChange,
  label,
  disabled,
  title,
  className = "",
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** What it switches, for a screen reader: the state is `aria-checked`, so it is not in the name. */
  label: string;
  disabled?: boolean;
  /** What a hover says, where that is more than the label. */
  title?: string;
  className?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title} disabled={disabled} onClick={() => onChange(!on)} className={`shrink-0 disabled:opacity-40 ${className}`}>
      <SwitchTrack on={on} />
    </button>
  );
}

/**
 * A setting that is a switch: what it is on the left, the switch on the right. The switch is named by `label`, or by
 * the title where that is text: a label says what the switch is about where the title alone would be one of several alike.
 */
export function SwitchRow({ title, detail, on, onChange, disabled, note, label }: { title: ReactNode; detail?: ReactNode; on: boolean; onChange: (on: boolean) => void; disabled?: boolean; note?: ReactNode; label?: string }) {
  return (
    <div className={`flex items-start gap-3 rounded-xl border border-line bg-raised/40 p-3 ${disabled ? "opacity-60" : ""}`}>
      <div className="min-w-0 flex-1 text-sm text-fg [overflow-wrap:anywhere]">
        {title}
        {detail && <span className="mt-0.5 block text-xs text-fg-faint">{detail}</span>}
        {note && <span className="mt-1 block text-xs text-warn">{note}</span>}
      </div>
      <Switch on={on} onChange={onChange} disabled={disabled} label={label ?? (typeof title === "string" ? title : t("Switch"))} />
    </div>
  );
}

const fieldLook = "rounded-lg border border-line bg-raised/60 outline-none transition placeholder:text-fg-faint focus:border-accent/60";
const buttonShape = "inline-flex items-center gap-1.5 rounded-lg transition disabled:opacity-40";

/*
 * Each size is its own constant. Adding `py-1.5` or `w-32` to one of these in a
 * class list does nothing: Tailwind writes `py-2` and `w-full` later in its stylesheet,
 * and of two classes for one property the later rule wins, not the later class. A size
 * that is wanted is here, or it is written `!w-32` where a width is meant.
 */
export const inputCls = `w-full px-3 py-2 text-sm ${fieldLook}`;
/** A field that sits in a row with other things. */
export const inputSmCls = `w-full px-3 py-1.5 text-sm ${fieldLook}`;
/** A field for code or configuration, which is read as text and not as a sentence. */
export const codeAreaCls = `w-full px-3 py-2 font-mono text-xs leading-relaxed ${fieldLook}`;
export const btnCls = `${buttonShape} bg-fg/5 px-3 py-2 text-sm text-fg hover:bg-fg/10`;
export const primaryCls = `${buttonShape} bg-accent/12 px-3 py-2 text-sm text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20`;
/** The main button of a dialog or a bar, shorter than the one on a page. */
export const primarySmCls = `${buttonShape} bg-accent/12 px-3 py-1.5 text-sm text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20`;
export const ghostCls = `${buttonShape} px-2.5 py-1.5 text-xs text-fg-muted hover:bg-fg/5 hover:text-fg`;

/** What a choice looks like, whether it holds or not; `cell` is for a grid, `md` for a row of larger buttons. */
export function choiceCls(on: boolean, size: "sm" | "cell" | "md" = "sm") {
  const fit = { sm: "px-2.5 py-1 text-xs", cell: "px-2 py-1.5 text-xs", md: "px-3 py-2 text-sm" }[size];
  return `rounded-lg transition ${fit} ${on ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25" : "bg-fg/5 text-fg-muted hover:bg-fg/10"}`;
}

/**
 * A row of choices of which exactly one holds, as radio buttons: the picked one
 * is `aria-checked`, so a screen reader says which it is and not only the colour.
 * `label` names the group; `showLabel` draws it in front of the choices too.
 */
export function Segments<T extends string>({
  label,
  value,
  options,
  onChange,
  showLabel,
  size,
  className = "flex flex-wrap items-center gap-1",
}: {
  label: string;
  value: T;
  /** `label` is English text for `t()`, so a list kept at module level follows the language. */
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  showLabel?: boolean;
  size?: "sm" | "cell" | "md";
  /** How the row is laid out. */
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={className}>
      {showLabel && <span className="mr-1 text-[11px] text-fg-subtle">{label}</span>}
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)} className={choiceCls(value === o.id, size)}>
          {t(o.label)}
        </button>
      ))}
    </div>
  );
}

/**
 * How hard a model thinks, as a row of levels. `inherited` is the level that
 * applies when none is picked; clicking the picked one again hands it back.
 */
export function EffortPicker({ value, inherited, onChange, label }: { value: string; inherited?: string; onChange: (level: string) => void; label?: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label ?? t("Effort")}>
      {EFFORT_LEVELS.map((lvl) => {
        const on = value === lvl;
        const fallback = !value && inherited === lvl;
        return (
          <button
            key={lvl}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(on ? "" : lvl)}
            className={`rounded-lg px-2.5 py-1 text-xs transition first-letter:uppercase ${
              on
                ? "bg-warn/12 text-warn ring-1 ring-inset ring-warn/30"
                : fallback
                  ? "bg-fg/5 text-fg ring-1 ring-inset ring-fg/15"
                  : "bg-fg/5 text-fg-muted hover:bg-fg/10"
            }`}
          >
            {effortLabel(lvl)}
          </button>
        );
      })}
    </div>
  );
}
