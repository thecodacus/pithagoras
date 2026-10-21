import type { ComponentProps, MouseEvent, ReactNode } from "react";
import type { ConfirmOptions, Portal, SelectOption, Ui } from "@pithagoras/extension-api";

/** The portal the extension was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);
export const tp = (n: number, one: string, other: string, vars?: Record<string, string | number>) => portal.tp(n, one, other, vars);
export const tx = (text: string, vars: Record<string, ReactNode>) => portal.tx(text, vars);
/** A text to be translated where it is shown, marked here as one: a title the portal draws, a label kept in a table. */
export const msg = <T extends string>(text: T): T => text;
export const formatDateTime = (d: Date | number | string, options?: Intl.DateTimeFormatOptions) => portal.format.dateTime(d, options);

/** A question with two answers, asked over the page: resolves true for yes. */
export const confirmDialog = (options: ConfirmOptions) => portal.ui.confirm(options);
/** The browser's storage, which never throws. */
export const local = {
  get: (key: string) => portal.ui.storage.local.get(key),
  set: (key: string, value: string) => portal.ui.storage.local.set(key, value),
};

/** A request the server refused, with what it said besides the message: the portal's own kind. */
export const isApiError = (e: unknown): e is InstanceType<Portal["api"]["ApiError"]> => e instanceof portal.api.ApiError;

/** Where this extension's own pages are: the Memory page, and its page in Settings. */
export const memoryPage = () => `/x/${portal.extension}/memory`;
export const settingsPage = () => `/settings/x/${portal.extension}`;

/**
 * A link to a page of the portal: an address like any other, which opens in a
 * new tab or window when asked to, and in this one goes there through the
 * portal's own router, without loading the page again.
 */
export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    // A middle click, or one with a key held, is the browser's: a new tab, a new window, a download.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    portal.navigate(to);
  };
  return (
    <a href={to} onClick={go} className={className}>
      {children}
    </a>
  );
}

// The portal's own components whose props say what they hold, drawn as components of the extension's.
export function Select<T extends string | number = string>(props: {
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
  const Own = portal.ui.Select as (props: unknown) => ReactNode;
  return <Own {...props} />;
}
export function Markdown(props: ComponentProps<Ui["Markdown"]>) {
  const Own = portal.ui.Markdown;
  return <Own {...props} />;
}
