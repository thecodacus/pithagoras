import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown } from "react-icons/lu";
import { useDismiss } from "./use-dismiss";
import { placePopover } from "./popover-place";
import { portal, t } from "../portal";

/** Colours to choose with one click; any other is typed as a hex code. */
const PRESETS = ["#ff5fc8", "#ff2fd6", "#ff4d6d", "#fbbf24", "#a3e635", "#34d399", "#22d3ee", "#a78bfa", "#f5f5f7"];
const SIZE = { width: 232, height: 160 };

/**
 * A colour, chosen in a popover of the portal's own: swatches and a hex code.
 * Not the browser's picker, which opens where the browser likes and ran off
 * the edge of the window from the end of a toolbar. Drawn at the body like the
 * Select's list, shifted or flipped to stay inside the window at every width.
 */
export function ColourPicker({ value, onChange, label }: { value: string; onChange: (colour: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(value);
  const [place, setPlace] = useState<ReturnType<typeof placePopover> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useDismiss(open, [card, button], () => setOpen(false), button);
  useEffect(() => setTyped(value), [value, open]);

  const position = () => {
    const b = button.current?.getBoundingClientRect();
    if (b) setPlace(placePopover(b, SIZE, { width: document.documentElement.clientWidth, height: window.innerHeight }));
  };
  useLayoutEffect(() => {
    if (!open) return;
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);

  const valid = /^#[0-9a-f]{6}$/i.test(typed.trim());
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`ui-select ui-select-sm ${open ? "is-open" : ""}`}
      >
        <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: value, boxShadow: `0 0 8px ${value}` }} />
        <LuChevronDown className="ui-select-chevron" aria-hidden />
      </button>
      {open &&
        place &&
        createPortal(
          // The extension's own look reaches only what is drawn inside an element of the extension's.
          <div data-extension={portal.extension} style={{ display: "contents" }}>
            <div
              ref={card}
              role="dialog"
              aria-label={label}
              // Part of whatever popover the picker is in, though drawn at the body: see useDismiss.
              data-popover-layer
              className={`${place.above ? "float-in" : "float-in-down"} fixed z-[200] rounded-xl border border-line bg-surface p-3 shadow-pop`}
              style={{ left: place.left, top: place.top, width: place.width }}
            >
              <div className="grid grid-cols-9 gap-1">
                {PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onChange(c)}
                    aria-label={c}
                    aria-pressed={value === c}
                    className="flex aspect-square items-center justify-center rounded-full border border-line transition hover:scale-110"
                    style={{ background: c, boxShadow: value === c ? `0 0 0 2px rgb(var(--accent))` : undefined }}
                  >
                    {value === c && <LuCheck className="h-3 w-3 text-black/70" aria-hidden />}
                  </button>
                ))}
              </div>
              <label className="mt-3 block text-sm text-fg-muted">
                {t("Hex code")}
                <input
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    if (/^#[0-9a-f]{6}$/i.test(e.target.value.trim())) onChange(e.target.value.trim().toLowerCase());
                  }}
                  spellCheck={false}
                  maxLength={7}
                  aria-invalid={!valid}
                  className={`mt-1 w-full rounded-lg border bg-raised/60 px-2 py-1 font-mono text-sm text-fg outline-none ${valid ? "border-line focus:border-accent/60" : "border-warn/60"}`}
                />
              </label>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
