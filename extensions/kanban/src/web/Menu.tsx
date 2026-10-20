import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { portal } from "../portal";

/**
 * A button that opens a menu of what can be done: a card's or a column's actions, the board's. The menu is put over
 * the page, by the button, so that a column that scrolls does not cut it off. Arrow keys go through it, Escape closes it
 * and gives the keyboard back to the button, and so does a click beside it.
 */

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ComponentType<{ "aria-hidden"?: boolean; className?: string }>;
  danger?: boolean;
  disabled?: boolean;
}

/** A line between groups of items. */
export const SEPARATOR = "separator" as const;

export function Menu({ label, items, children, className, buttonRef }: { label: string; items: (MenuItem | typeof SEPARATOR)[]; children: ReactNode; className?: string; buttonRef?: (el: HTMLButtonElement | null) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const close = (focus = true) => {
    setOpen(false);
    setAt(null);
    if (focus) button.current?.focus();
  };
  const entries = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

  /** Placed by its button, inside the window: below it and ending where it ends, or above it where there is no room below. */
  const place = () => {
    if (!button.current || !menu.current) return;
    const by = button.current.getBoundingClientRect();
    const box = menu.current.getBoundingClientRect();
    const below = by.bottom + 4 + box.height <= window.innerHeight - 8;
    const top = below ? by.bottom + 4 : Math.max(8, by.top - 4 - box.height);
    const left = Math.min(Math.max(8, by.right - box.width), window.innerWidth - box.width - 8);
    setAt((was) => (was?.top === top && was.left === left ? was : { top, left }));
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);
  // Once it is where it is shown (a hidden element takes no focus), the keyboard is on its first item.
  const placed = at !== null;
  useEffect(() => {
    if (open && placed) entries()[0]?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const target = e.target as Node;
      if (menu.current?.contains(target) || button.current?.contains(target)) return;
      close(false);
    };
    // What it is by moved (the column scrolled, the window changed): it goes with its button.
    const moved = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) place();
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = entries();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      all[(n + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") close(false);
  };

  return (
    <>
      <button
        ref={(el) => {
          button.current = el;
          buttonRef?.(el);
        }}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={className}
        onClick={() => (open ? close() : setOpen(true))}
        // A press here is not the start of a card's drag.
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div data-extension={portal.extension} style={{ display: "contents" }}>
            <div
              ref={menu}
              role="menu"
              aria-label={label}
              onKeyDown={onKey}
              className="kb-menu fixed z-50 min-w-[11rem] max-w-[18rem] rounded-xl border border-line bg-surface p-1 shadow-pop"
              style={at ? { top: at.top, left: at.left } : { top: 0, left: 0, visibility: "hidden" }}
            >
              {items.map((item, i) =>
                item === SEPARATOR ? (
                  <div key={`s${i}`} role="separator" className="my-1 h-px bg-line" />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                      close();
                      item.onSelect();
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition disabled:opacity-40 ${item.danger ? "text-danger hover:bg-danger/10 focus-visible:bg-danger/10" : "text-fg hover:bg-fg/5 focus-visible:bg-fg/5"} outline-none`}
                  >
                    {item.icon && <item.icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />}
                    <span className="min-w-0 truncate">{item.label}</span>
                  </button>
                ),
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
