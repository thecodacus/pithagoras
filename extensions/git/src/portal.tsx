import type { ComponentProps, ReactNode } from "react";
import type { ConfirmOptions, Portal, SelectOption, Ui } from "@pithagoras/extension-api";

/** The portal the extension was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);
export const tp = (n: number, one: string, other: string, vars?: Record<string, string | number>) => portal.tp(n, one, other, vars);
export const tc = (text: string, context: string, vars?: Record<string, string | number>) => portal.tc(text, context, vars);
export const tx = (text: string, vars: Record<string, ReactNode>) => portal.tx(text, vars);
/** A text to be translated where it is shown, marked here as one: a tab's name, a state's. */
export const msg = <T extends string>(text: T): T => text;
/** What a value is called, from a table of `msg()` texts; one the table does not know is shown as `unknown` makes it. */
export const labelOf = (labels: Readonly<Record<string, string>>, value: string, unknown: (value: string) => string = (v) => v): string =>
  Object.hasOwn(labels, value) ? t(labels[value]) : unknown(value);
/** A hook: the language in effect, drawing the component again when it changes. */
export const useLanguage = () => portal.locale.use();
export const formatDate = (d: Date | number | string, options?: Intl.DateTimeFormatOptions) => portal.format.date(d, options);
export const formatDateTime = (d: Date | number | string, options?: Intl.DateTimeFormatOptions) => portal.format.dateTime(d, options);

/** A question with two answers, asked over the page: resolves true for yes. */
export const confirmDialog = (options: ConfirmOptions) => portal.ui.confirm(options);
export const copyText = (text: string) => portal.ui.copyText(text);
/** The browser's storage, which never throws. */
export const local = {
  get: (key: string) => portal.ui.storage.local.get(key),
  set: (key: string, value: string) => portal.ui.storage.local.set(key, value),
  remove: (key: string) => portal.ui.storage.local.remove(key),
};
export const session = {
  get: (key: string) => portal.ui.storage.session.get(key),
  set: (key: string, value: string) => portal.ui.storage.session.set(key, value),
  remove: (key: string) => portal.ui.storage.session.remove(key),
};

// The portal's own components, drawn as components of the extension's.
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
