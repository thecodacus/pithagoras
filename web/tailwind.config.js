/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
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
