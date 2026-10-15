import type { ComponentProps, ReactNode } from "react";
import type { Portal, SelectOption, Ui } from "@pithagoras/extension-api";

/** The portal the extension was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);
/** A text to be translated where it is shown, marked here as one: a shortcut's label. */
export const msg = <T extends string>(text: T): T => text;

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
}) {
  const Own = portal.ui.Select as (props: unknown) => ReactNode;
  return <Own {...props} />;
}
export function Markdown(props: ComponentProps<Ui["Markdown"]>) {
  const Own = portal.ui.Markdown;
  return <Own {...props} />;
}
