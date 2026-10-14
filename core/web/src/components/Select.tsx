import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown } from "react-icons/lu";

import { useLeaveRef } from "../motion";
import { t } from "../i18n";
interface SelectOption<T extends string | number = string> {
  value: T;
  label: ReactNode;
  /** A second, quieter line under the label. */
  hint?: ReactNode;
  disabled?: boolean;
  /** What typing a letter matches against, when the label is not plain text. */
  text?: string;
}

/**
 * A dropdown drawn by the portal rather than the operating system.
 *
 * The native list ignores the theme — a white box on a dark page — and
 * cannot be styled at all once open. This one keeps what made the native one
 * usable: arrows, Home/End, Enter and Escape, and typing to jump to an option.
 * The list is portaled to the body so a scrolling panel or a dialog's
 * overflow does not clip it, and flips above the button when there is no
 * room below.
 */
export function Select<T extends string | number = string>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className = "",
  size = "md",
  "aria-label": ariaLabel,
  id,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: ReactNode;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; above: boolean; maxHeight: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Shut, the list drops away as a picture of itself (see motion.ts).
  const listRef = useLeaveRef<HTMLDivElement>("menu", list);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = options[selectedIndex];

  const position = () => {
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    const below = window.innerHeight - b.bottom - 12;
    const above = b.top - 12;
    const flip = below < 220 && above > below;
    setPlace({
      left: Math.min(b.left, window.innerWidth - Math.max(b.width, 180) - 8),
      top: flip ? b.top - 6 : b.bottom + 6,
      width: b.width,
      above: flip,
      maxHeight: Math.max(120, Math.min(320, flip ? above : below)),
    });
  };

  const show = () => {
    if (disabled) return;
    position();
    setActive(selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    hide();
  };

  useLayoutEffect(() => {
    if (open) position();
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !button.current?.contains(t)) hide(false);
    };
    // A scroll anywhere but inside the list moves the button out from under it.
    const scrolled = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) position();
    };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("touchstart", away, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("touchstart", away, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir, n = 0; n < options.length; i += dir, n++) {
      const at = (i + options.length) % options.length;
      if (!options[at].disabled) return at;
    }
    return from;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    // Kept here: an Escape that closes the list must not close the dialog around it.
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => step(i, 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => step(i, -1));
        return;
      case "Home":
        e.preventDefault();
        setActive(step(-1, 1));
        return;
      case "End":
        e.preventDefault();
        setActive(step(options.length, -1));
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        return;
      case "Escape":
        e.preventDefault();
        hide();
        return;
      case "Tab":
        hide(false);
        return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = performance.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const match = options.findIndex(
        (o) => !o.disabled && (o.text ?? (typeof o.label === "string" ? o.label : String(o.value))).toLowerCase().startsWith(typed.current.text),
      );
      if (match >= 0) setActive(match);
    }
  };

  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // Focus stays on the button while the list is open: this is how a
        // screen reader hears which option the arrows are on.
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKey}
        className={`ui-select ui-select-${size} ${open ? "is-open" : ""} ${className}`}
      >
        <span className={`ui-select-value ${selected ? "" : "is-placeholder"}`}>{selected ? selected.label : (placeholder ?? t("Choose…"))}</span>
        <LuChevronDown className="ui-select-chevron" aria-hidden />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            // Part of whatever popover the select is in, though drawn at the body: see useDismiss.
            data-popover-layer
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onKey}
            className={`ui-select-list ${place.above ? "is-above" : ""}`}
            style={{
              left: place.left,
              minWidth: place.width,
              maxHeight: place.maxHeight,
              ...(place.above ? { bottom: window.innerHeight - place.top } : { top: place.top }),
            }}
          >
            {options.map((o, i) => (
              <div
                key={String(o.value)}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={`ui-select-option ${i === active ? "is-active" : ""} ${o.disabled ? "is-disabled" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="ui-select-hint">{o.hint}</span>}
                </span>
                {o.value === value && <LuCheck className="ui-select-check" aria-hidden />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
