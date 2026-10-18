import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLeaveRef } from "../motion";
import { useDismiss } from "../use-dismiss";

/** One choice in a `Menu`: a button that does something, or a link (`href`, with `download` to save what it leads to). */
export interface MenuItem {
  /** Tells the choices apart, and what the menu looks at to see that its list changed. */
  key: string;
  label: string;
  icon?: ReactNode;
  /** What a button does when it is chosen. */
  onSelect?: () => void;
  href?: string;
  /** A file name to save the link's target as; "" to take the name it has. */
  download?: string;
  /** For a menu that goes between pages: the one showing. It is marked, and the arrows start there. */
  current?: boolean;
}

type Place = { left?: number; right?: number; top?: number; bottom?: number; maxHeight: number };

/**
 * A button that opens a list of choices, for what does not fit on a bar as one
 * button each: arrows move through it, Enter picks, Escape shuts it and gives the
 * focus back to the button. Drawn at the body, as the Select's list is, because a
 * panel or a sidebar clips what leaves it.
 *
 * The button is the menu's own, and holds `children`; `className` styles it.
 * The list opens under the button (`below`, and above it where the window ends
 * too soon), or beside it (`beside`, level with it, for a button on a rail).
 */
export function Menu({
  label,
  children,
  items,
  className,
  disabled,
  placement = "below",
  buttonRef,
}: {
  /** What the button and the list are called, for a screen reader. */
  label: string;
  children: ReactNode;
  items: MenuItem[];
  className?: string;
  disabled?: boolean;
  placement?: "below" | "beside";
  /** The button, for a caller that gives the focus back to it. */
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuRef = useLeaveRef<HTMLDivElement>("menu", menu);
  const menuId = useId();
  useDismiss(open, [menu, button], () => setOpen(false), button);

  const show = () => {
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    if (placement === "beside") {
      // Level with the button, and hung from its bottom edge instead where the window ends too soon below.
      const room = window.innerHeight - b.top - 8;
      const flip = room < 220 && b.bottom > room;
      setPlace({ left: b.right + 8, ...(flip ? { bottom: window.innerHeight - b.bottom } : { top: b.top }), maxHeight: Math.max(120, flip ? b.bottom - 8 : room) });
    } else {
      // Under the button, from its left edge, or from its right one where the list would leave the window; above it where there is no room below.
      const room = window.innerHeight - b.bottom - 12;
      const flip = room < 220 && b.top > room;
      setPlace({
        ...(b.left + 200 > window.innerWidth ? { right: Math.max(8, window.innerWidth - b.right) } : { left: Math.max(8, b.left) }),
        ...(flip ? { bottom: window.innerHeight - b.top + 4 } : { top: b.bottom + 4 }),
        maxHeight: Math.max(120, flip ? b.top - 12 : room),
      });
    }
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  /** Which entry had the focus last: where it goes if that entry is unlisted. */
  const lastAt = useRef(0);
  const entries = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  // The one showing is where the arrows start, if the menu goes between pages.
  useEffect(() => {
    if (!open) return;
    const at = Math.max(0, items.findIndex((item) => item.current));
    entries()[at]?.focus();
  }, [open]);
  // An entry unlisted under the focus takes it along to body, where the arrows are not heard: it goes to the one
  // now in its place, or to the button if none is left.
  const listed = items.map((item) => item.key).join("\n");
  useEffect(() => {
    if (!open || menu.current?.contains(document.activeElement)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const all = entries();
    if (all.length) all[Math.min(lastAt.current, all.length - 1)].focus();
    else close();
  }, [listed]);

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
    // Away from the menu with the keys is away from it, and on from where the button is, not from the end of the page
    // the menu is drawn at: the focus goes to the button before the Tab is carried out.
    else if (e.key === "Tab") close();
  };

  return (
    <>
      <button
        ref={(el) => {
          button.current = el;
          if (typeof buttonRef === "function") buttonRef(el);
          else if (buttonRef) (buttonRef as { current: HTMLButtonElement | null }).current = el;
        }}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-current={items.some((item) => item.current) ? "page" : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
        className={className}
      >
        {children}
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            onFocus={(e) => (lastAt.current = Math.max(0, entries().indexOf(e.target as HTMLElement)))}
            className={`ui-select-list ${place.bottom !== undefined ? "is-above" : ""}`}
            style={{ ...place, minWidth: 180 }}
          >
            {items.map((item) => {
              const look = "ui-select-option w-full text-left hover:bg-fg/5 hover:text-fg focus:bg-fg/[0.07] focus:text-fg";
              const inside = (
                <>
                  {item.icon && <span className={`shrink-0 ${item.current ? "text-accent" : "text-fg-faint"}`}>{item.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </>
              );
              return item.href !== undefined ? (
                <a key={item.key} role="menuitem" tabIndex={-1} href={item.href} download={item.download} aria-current={item.current ? "page" : undefined} onClick={() => close()} className={look}>
                  {inside}
                </a>
              ) : (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-current={item.current ? "page" : undefined}
                  onClick={() => {
                    close();
                    item.onSelect?.();
                  }}
                  className={look}
                >
                  {inside}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
