/**
 * The portal's look as a Tailwind preset: its colours by what each is for
 * (`bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`, `text-danger`),
 * each the portal's own CSS variable, so a theme the person chose paints them
 * too; its rounding and its shadow for what floats. The portal's own
 * stylesheet is made with it, and an extension's can be: `buildExtension`
 * with `tailwind: true` makes the utilities the extension's code uses into
 * its own stylesheet.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

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
      borderRadius: { xl: "0.75rem", "2xl": "1rem" },
      boxShadow: {
        pop: "0 10px 30px -12px rgb(0 0 0 / 0.35), 0 2px 8px -4px rgb(0 0 0 / 0.2)",
      },
    },
  },
};
