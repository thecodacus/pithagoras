import defaultTheme from "tailwindcss/defaultTheme.js";

/**
 * The portal's look as a Tailwind preset: its colours by what each is for
 * (`bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`, `text-danger`),
 * each the portal's own CSS variable, so a theme the person chose paints them
 * too; and beyond colour its type (`font-sans`, `font-mono`, the `text-*`
 * sizes), its rounding, the unit of its padding and gaps, the widths of its
 * layout and its layers (`z-dialog`), each a variable too. The portal's own
 * stylesheet is made with it, and an extension's can be: `buildExtension`
 * with `tailwind: true` makes the utilities the extension's code uses into
 * its own stylesheet.
 *
 * The variables are the portal's (index.css), and its values are the ones
 * Tailwind has always had, so nothing looks different until a theme or the
 * person sets one. Each carries its stock value as the fallback, so a
 * stylesheet made with this preset reads the same in a portal that predates
 * a variable.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;
/** A variable, with the stock value to fall back on. */
const v = (name, stock) => `var(--${name}, ${stock})`;

/**
 * Tailwind's spacing keys as that many of a unit the page sets: `p-4` is four `--pad`s, which is 1rem as the
 * portal ships it, and more or less when the person chooses another density. `px` (a hairline) and `0` stay as
 * they are.
 */
const times = (unit, stock) =>
  Object.fromEntries(
    Object.keys(defaultTheme.spacing)
      .filter((key) => key !== "px" && key !== "0")
      .map((key) => [key, `calc(${v(unit, stock)} * ${Number(key)})`]),
  );

export default {
  theme: {
    extend: {
      colors: {
        // Named for the job, not the colour.
        canvas: token("canvas"),
        surface: token("surface"),
        raised: token("raised"),
        line: token("line"),
        fg: {
          DEFAULT: token("fg"),
          muted: token("fg-muted"),
          subtle: token("fg-subtle"),
          faint: token("fg-faint"),
        },
        accent: {
          DEFAULT: token("accent"),
          fg: token("accent-fg"),
        },
        ok: token("ok"),
        warn: token("warn"),
        danger: token("danger"),
      },
      borderColor: { DEFAULT: token("line") },
      fontFamily: {
        sans: v("font-sans", defaultTheme.fontFamily.sans.join(", ")),
        mono: v("font-mono", defaultTheme.fontFamily.mono.join(", ")),
      },
      // The sizes are steps of one base, `--text-base`, so that the person's text size moves them together. The
      // three smallest have no line height of their own, as the literals they replace had none.
      fontSize: {
        "3xs": v("text-3xs", "0.625rem"),
        "2xs": v("text-2xs", "0.6875rem"),
        "xs-plus": v("text-xs-plus", "0.8125rem"),
        xs: [v("text-xs", "0.75rem"), { lineHeight: v("leading-xs", "1rem") }],
        sm: [v("text-sm", "0.875rem"), { lineHeight: v("leading-sm", "1.25rem") }],
        base: [v("text-base", "1rem"), { lineHeight: v("leading-base", "1.5rem") }],
        lg: [v("text-lg", "1.125rem"), { lineHeight: v("leading-lg", "1.75rem") }],
        xl: [v("text-xl", "1.25rem"), { lineHeight: v("leading-xl", "1.75rem") }],
        "2xl": [v("text-2xl", "1.5rem"), { lineHeight: v("leading-2xl", "2rem") }],
      },
      borderRadius: {
        DEFAULT: v("radius-sm", "0.25rem"),
        md: v("radius-md", "0.375rem"),
        lg: v("radius-lg", "0.5rem"),
        xl: v("radius-xl", "0.75rem"),
        "2xl": v("radius-2xl", "1rem"),
      },
      boxShadow: {
        pop: "0 10px 30px -12px rgb(0 0 0 / 0.35), 0 2px 8px -4px rgb(0 0 0 / 0.2)",
      },
      // Padding and gaps follow `--pad` and `--gap`. Widths, heights, offsets, margins and what `size-*` sets stay
      // as they are: a unit on all of them would grow the icons with the density, and that is zoom, not density.
      padding: times("pad", "0.25rem"),
      gap: times("gap", "0.25rem"),
      space: times("gap", "0.25rem"),
      maxWidth: { chat: v("chat-max", "48rem") },
      width: { nav: v("nav-width", "16rem") },
      zIndex: {
        raised: v("z-raised", "10"),
        panel: v("z-panel", "20"),
        // The panel that was touched last, above the others.
        "panel-top": v("z-panel-top", "21"),
        backdrop: v("z-backdrop", "40"),
        nav: v("z-nav", "50"),
        dialog: v("z-dialog", "50"),
        viewer: v("z-viewer", "55"),
        confirm: v("z-confirm", "60"),
      },
    },
  },
};
