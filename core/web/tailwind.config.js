/** @type {import('tailwindcss').Config} */
import portal from "@pithagoras/extension-api/tailwind";

const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  // The portal's colours, rounding and shadow, which an extension's stylesheet is made with too.
  presets: [portal],
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
      },
    },
  },
  plugins: [],
};
