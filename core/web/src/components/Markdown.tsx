import { memo, useMemo, type ComponentProps } from "react";
import { Streamdown, type DiagramPlugin, type ExtraProps, type StreamdownProps } from "streamdown";
import { t, useLanguage } from "../i18n";

/**
 * The host of a picture the portal does not load, or null for one it may.
 *
 * What a reply, a note or a page the agent fetched shows is not the user's to
 * trust: a picture it names is fetched by the browser the moment it is drawn,
 * from whoever's server the address points at, with whatever the address
 * carries. So only the portal's own pictures load (and a `data:` one, which
 * is its own bytes); any other is a label saying where it would have come from.
 */
export function foreignPictureHost(src: string, page: string): string | null {
  let url: URL;
  try {
    url = new URL(src, page);
  } catch {
    return "?";
  }
  if (url.protocol === "data:") return /^data:image\//i.test(src) ? null : "?";
  // A blob: address carries the origin that made it, and has no host of its own.
  if (url.origin === new URL(page).origin) return null;
  try {
    return new URL(url.origin).host || "?";
  } catch {
    return "?";
  }
}

function SafePicture({ node: _node, src, alt, ...rest }: ComponentProps<"img"> & ExtraProps) {
  useLanguage();
  if (typeof src !== "string" || !src) return null;
  const host = foreignPictureHost(src, window.location.href);
  if (host === null) return <img src={src} alt={alt} loading="lazy" className="max-w-full rounded-lg" {...rest} />;
  return (
    <span className="inline-block max-w-full truncate rounded bg-raised px-2 py-0.5 align-bottom text-xs text-fg-subtle" title={alt || undefined}>
      {t("Picture from {host} not loaded", { host })}
    </span>
  );
}

/**
 * What no markdown of the portal may lose: a `<picture>` takes its picture from
 * a `<source>` before it looks at the `<img>` inside, so the guard on the
 * `<img>` alone would be walked around.
 */
const GUARDS = { img: SafePicture, source: () => null };

/** Streamdown compares what it is passed by identity: one object for every reply, not one per render. */
const ANIMATED = { animation: "blurIn", duration: 240, sep: "word" } as const;

export type MarkdownProps = Omit<StreamdownProps, "animated" | "plugins" | "shikiTheme" | "children"> & {
  children: string;
  /** A reply being written: its new words fade in. */
  animated?: boolean;
  /** The diagram renderer, once it is fetched: a fence says `mermaid` and nothing draws it before. */
  diagram?: DiagramPlugin | null;
};

/**
 * Every markdown the portal draws: a reply, a note, a pull request, a
 * subagent's report. One place for what they have in common — the pictures
 * that may load (see `foreignPictureHost`) and Streamdown's own props, which it
 * memoises by identity and so must not be made anew with each draw. Its code
 * theme is its default, which is also the one the portal wants.
 */
export const Markdown = memo(function Markdown({ animated, diagram, components, ...props }: MarkdownProps) {
  const plugins = useMemo(() => (diagram ? { mermaid: diagram } : undefined), [diagram]);
  const own = useMemo(() => (components ? { ...components, ...GUARDS } : GUARDS), [components]);
  return <Streamdown {...props} animated={animated ? ANIMATED : undefined} plugins={plugins} components={own} />;
});
