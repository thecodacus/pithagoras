/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: [
    // Streamdown ships its own utility classes; without this they are purged.
    "./node_modules/streamdown/dist/*.js",
    "../node_modules/streamdown/dist/*.js",
    "./index.html",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Streamdown is written against shadcn's colour names, which this
        // project does not use — so its table overlay, code headers and
        // borders resolved to nothing and rendered transparent. Mapped onto the
        // tokens we do have rather than renaming ours: these exist for
        // somebody else's classes, not to be used in our own.
        background: token("canvas"),
        foreground: token("fg"),
        muted: token("raised"),
        "muted-foreground": token("fg-muted"),
        border: token("line"),
        primary: token("accent"),
        "primary-foreground": token("canvas"),
        // The mermaid block sits on bg-sidebar; without this it is a border
        // around nothing and the diagram floats on the transcript.
        sidebar: token("surface"),
        // Named for the job, not the colour — see index.css.
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
  plugins: [],
};
