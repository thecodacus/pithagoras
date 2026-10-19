# Building an extension

An extension is an ordinary pi package that also brings something to the
portal: a panel beside a conversation, a page in the sidebar, routes of its
own on the server, tools for the agent that share what those routes know, a
theme. It is installed, switched and removed like any other package
([Extensions](/guide/extensions)), and it is loaded as it is: nothing of it is
compiled into the portal.

This page takes you from an empty folder to a working extension, then lists
everything the portal hands one. The snippets are taken from a complete
example, `tests/fixtures/extensions/notes`: it is not shipped, and the portal's
tests check the framework with it.

## The three halves

A package can have any of these. Each is optional.

| Half | Named in `package.json` | Runs | Lives | For |
| --- | --- | --- | --- | --- |
| pi extension | `pi.extensions` | Inside a chat's pi | One per chat, while the chat's agent is up | Tools, commands, what is kept with the conversation |
| Browser half | `pithagoras.client` | In the portal's page | While the page is open | Everything drawn |
| Server half | `pithagoras.server` | In the portal's own process | Once, for all chats | Routes, processes, what must be there when no chat is running |

Which one a piece of work belongs in follows from when it has to be there. A
chat left alone for twenty minutes has its agent let go, and where pi runs in a
container (`EXECUTOR=container`) it is not in the portal's process at all. So
listing a folder's files, a terminal's shell, or a page that shows every chat's
notes belongs in the server half. A tool the agent calls belongs in pi, either
in the package's pi extension or [added by the server half](#tools-that-share-the-server-half-s-state).

## Your first extension

Three files. No build step.

```
hello/
├── package.json
└── web/
    ├── client.js
    └── client.css
```

```json
{
  "name": "hello",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {},
  "pithagoras": { "client": "./web/client.js", "style": "./web/client.css" }
}
```

```js
// web/client.js
export default function (portal) {
  const { React } = portal;
  const h = React.createElement;

  function Hello({ chat }) {
    // What the agent has run in its shell, read from the chat as the page has it.
    const runs = portal.chats.use(chat.id, (feed) => feed.items.filter((item) => item.kind === "tool" && item.name === "bash"));
    return h("div", { className: "hello" },
      h("p", null, `${runs.length} commands run in ${chat.title}`),
      runs.map((run) => h("pre", { key: run.id }, `$ ${run.args.command}\n${run.output ?? ""}`)));
  }

  portal.slots.register("chat.panel", { id: "hello", title: "Hello", component: Hello });
}
```

```css
/* web/client.css */
.hello { padding: 12px; color: rgb(var(--fg)); font-size: 13px; }
.hello pre { border: 1px solid rgb(var(--line)); border-radius: 8px; padding: 8px; }
```

Install it in **Settings → Extensions → Discover → Install by name** by its path
(`/absolute/path/to/hello`). A **Hello** button appears in every chat's header.
Open it, ask the agent to run something, and the command and its output appear
in your panel as they happen.

While you work on it:

| You changed | To see it |
| --- | --- |
| The browser half | Reload the page |
| The server half's module | Switch the package off and on in Settings → Extensions |
| Another file the server half imports | Restart the portal |
| The pi extension | `/reload` in the chat |

## The package

```json
{
  "name": "my-extension",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] },
  "pithagoras": {
    "client": "./web/client.js",
    "style": "./web/client.css",
    "server": "./server.js",
    "themes": [{ "id": "dusk", "name": "Dusk", "dark": { "accent": "#ff79c6" } }]
  }
}
```

- **`name`** is what everything goes by: the entries it registers, its
  messages, its addresses (`/api/x/<name>/…`, `/x/<name>/<page>`). An npm name,
  with or without a scope.
- **`pi`** is what the package brings pi: its extensions, skills, prompts and
  themes, as any pi package names them. A Pithagoras extension is a pi package,
  installed with `pi install`, so it always has the key, empty when it brings
  pi nothing (`"pi": {}`). Without the key and without pi's own folders
  (`extensions/`, `skills/`, `prompts/`, `themes/`), pi takes the package's
  folder for an extension, cannot load it, and does not start.
- **`client`** is a JavaScript module for the browser. The folder it is in is
  the package's web folder: the portal serves that folder, and nothing else of
  the package, to whoever is signed in. So the module has a folder of its own;
  one at the package's root is not loaded. Pictures and further modules in the
  folder are fetched relative to it (`new URL("./logo.svg", import.meta.url)`),
  and a heavy part can be loaded when first needed with `import("./big.js")`.
- **`style`**, in the same folder, is a stylesheet loaded with it.
- **`server`** is a JavaScript module for Node, anywhere in the package.
- **`themes`** are [colours in place of the portal's own](#themes), with no
  code at all.

Both modules are loaded as they are: plain JavaScript, or the output of your
own build.

## The browser half

Its default export is called once, with the portal. It may return a function,
called when the extension is taken out of the page; what it registered goes
with it either way.

| `portal.` | |
| --- | --- |
| `React` | The portal's own React. Components are made with it, so that their hooks work |
| `slots.register(slot, entry)` | Puts an entry into a [slot](#slots). Returns what takes it out |
| `chats.use(chatId, pick?)` | A hook: [the chat as the page has it](#the-chat-s-events) |
| `chats.on(chatId, handler)` | The same outside a component |
| `chats.create({ title?, workspace? })` | A new chat, as New chat makes one, in a folder and under a name if you say them. Not opened: `navigate("/s/" + chat.id)` does that |
| `chats.files.pictureUrl`, `videoUrl`, `fileUrl`, `upload` | [The portal's routes for a chat's folder](#the-portal-s-routes-for-a-chat), as calls and not as addresses to build |
| `chats.files.inside`, `below`, `latestActivity`, `ofCall`, `pictures` | [What the portal knows about paths in a chat's folder](#the-portal-s-routes-for-a-chat): where a path the agent wrote is, which file it last read or changed, and a Markdown's pictures |
| `chats.background.stop`, `clear`, `output` | The jobs the agent left running: stop one, forget the finished, follow one's output |
| `panels` | [Any panel of the chat on screen](#panels-and-commands), by name |
| `commands` | [What can be asked of an extension by name](#panels-and-commands) |
| `api.json(url, init?)` | A request as the portal's own are made |
| `api.url(path)` | The address of a route of the package's [server half](#the-server-half) |
| `server.on(handler)` | What the server half [says to this page](#telling-the-pages-open-on-a-chat) |
| `server.on(topic, handler)` | What the server half [pushes to a topic](#pages-that-listen-to-a-topic), on any page: one with no chat open too |
| `t(text, vars?)`, `locale` | [Its texts in other languages](#other-languages) |
| `theme` | [Themes](#themes): add one, switch to one, follow the one in effect |
| `ui` | [The portal's building blocks](#looking-like-the-portal) |
| `navigate(path)` | Goes to a page of the portal: `/s/<chat id>`, `/x/<package>/<page id>` |
| `extension`, `version` | The package's name; the version of this interface, `1` |

### Components

A component is a function made with `portal.React`. Without a build that
means `React.createElement`, as above. With a build, write TypeScript and JSX
and import React as usual: see [Writing it in TypeScript](#writing-it-in-typescript).
Either way it is the portal's React, never a second one: two Reacts in one page
do not share hooks.

The portal wraps each component so that it is drawn again only when what it is
handed changes. The chat around it is drawn again with every token of a reply;
your panel is not, unless it [asks for something that changed](#the-chat-s-events).

### Writing it in TypeScript

`@pithagoras/extension-api` is the contract between the portal and an
extension, and what an extension written in TypeScript and JSX is built with:

- its types are what the portal gives (`Portal` for the browser half,
  `ServerPortal` from `@pithagoras/extension-api/server` for the server half),
  and the portal itself is checked against them when it is built;
- `@pithagoras/extension-api/build` bundles `src/client.tsx` into the module
  the portal loads, `web/client.js`, with the stylesheet the code imports beside
  it (`web/client.css`) and each `import()` as a chunk fetched only when it is
  asked for.

```js
// build.mjs
import { buildExtension } from "@pithagoras/extension-api/build";
await buildExtension({ dir: import.meta.dirname });
```

```json
{
  "pi": {},
  "pithagoras": { "client": "./web/client.js", "style": "./web/client.css" },
  "scripts": { "build": "tsc --noEmit && node build.mjs" },
  "devDependencies": { "@pithagoras/extension-api": "*", "esbuild": "*" }
}
```

```tsx
// src/client.tsx
import { useState } from "react";
import type { Portal } from "@pithagoras/extension-api";
import "./client.css";

export default function (portal: Portal) {
  function Counter() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
  }
  portal.slots.register("chat.panel", { id: "counter", title: "Counter", component: Counter });
}
```

The bundle has no React of its own. `react`, `react/jsx-runtime` and
`react-dom` are the portal's: it hands them to every extension before it loads
any extension's module, and the build points those imports there. Any other
package the code imports is bundled into it. What the build makes is not kept
in git: the package is built where it is installed from, or published built.

A part that is large and not always needed goes in a chunk of its own, fetched
when it is first drawn. Load it with `portal.ui.lazy`, not React's `lazy`: a
chunk that cannot be fetched (the extension was updated after the page was
opened) is then said so by `ui.PartFailed` with a way to reload, as the
portal's own parts are.

```tsx
// In the module's default export: the terminal's Shell tab and its emulator.
const Shell = portal.ui.lazy(() => import("./Shell"), "Shell");
// Drawn in Suspense, inside ui.ErrorBoundary with ui.PartFailed as its fallback.
```

The server half can be written in TypeScript as well: `server` names its
module, and the build bundles it into `server.js` beside `package.json`, with
the packages it imports left to be imported where it runs (a native one cannot
be bundled).

```js
await buildExtension({ dir: import.meta.dirname, tailwind: true, server: "src/server.ts" });
```

`extensions/terminal` and `extensions/git` in the repository are extensions
written this way; Git builds its server half and its utilities too.

**Packages.** An extension of your own that has packages (an emulator, a database
driver) names them in its `package.json` and keeps a `package-lock.json`. Two
things see to them, so that no extension carries code for it:

- The build. `buildExtension({ dir, install: true })` first installs what the lock names
  (`npm ci`, without install scripts, from npm's cache where it can, so that a build with
  no network works when everything is there) if it is not in the package's `node_modules`
  or is at another version, and says so. `installPackages({ dir })` does only that, for a
  build of your own (Documents' editor). The image builds every extension this way, then
  installs what each needs to run and no more (`npm ci --omit=dev`).
- The portal. A package pi installed by its folder is left by pi without its packages. When the
  portal is about to start its server half and the packages it runs on (what its lock names,
  without what only the build needs) are missing, it installs them in the background first
  and starts the half when they are there, so a checkout that is run as it is just works. The
  half has the fifteen seconds to start from then. Until then Settings → Extensions says "Its
  packages are being installed", an install that fails says why ("Its packages could not be
  installed: …"), and the next change of what is installed tries again. A package with no
  lock file is not installed from. A server half imports its packages, and does not install
  them.

### Looking like the portal

The page's colours are variables holding the three numbers of a colour, so
`rgb(var(--fg))`, and likewise `--canvas`, `--surface`, `--raised`, `--line`,
`--fg-muted`, `--fg-subtle`, `--fg-faint`, `--accent`, `--accent-fg`, `--ok`,
`--warn`, `--danger`, and `--terminal` with `--terminal-fg` for a terminal's
ground and text. A stylesheet written with them follows the theme, the
portal's own or [one an extension brought](#themes). Give your class names a
prefix of your own: the stylesheet is the page's.

`portal.ui` is what the portal's own pages are made of:

| | |
| --- | --- |
| `Markdown` | Markdown as the conversation draws it |
| `Select`, `Switch`, `SwitchRow`, `Segments`, `Field` | Controls and their labels. `Switch` is for what takes effect at once; a choice in a form that is acted on later ("Amend", "Draft") is a plain `<input type="checkbox">`, which the portal draws in its own look on every page, as it does its own forms' |
| `Menu` | A button that opens a list of choices, drawn over the page, with the keys of a menu (arrows, Home, End, Enter, Escape, which gives the focus back). `<ui.Menu label="Download" items={[{ key: "md", label: "Markdown", href, download: "note.md" }, { key: "x", label: "Other", onSelect }]}>…</ui.Menu>`: its children are what the button holds, `className` styles it, `buttonRef` is a ref to it (to give the focus back), `placement` is `"below"` (above where there is no room) or `"beside"`; a choice is a button (`onSelect`) or a link (`href`, `download`) and may have an `icon` |
| `IconButton`, `TextButton` | A small button with an icon in it, named by its `label`; a labelled button for a bar of small controls (`primary`, `danger`) |
| `PageHeader`, `Stat`, `Section`, `CollapsibleSection` | The card at the top of a page, and sections under it |
| `Empty`, `ErrorBanner`, `WarnBanner`, `LoadFailed` | Nothing to show; something wrong; could not be fetched, with a retry |
| `RowsSkeleton`, `SkeletonGroup` | Placeholders while something loads |
| `ErrorBoundary`, `PartFailed` | A part that fails to draw, failing alone |
| `StatusDot` | A chat's state as a dot |
| `confirm(options)` | A question asked over the page; resolves true for yes |
| `classes` | The look of the portal's fields and buttons as class names: `input`, `inputSmall`, `codeArea`, `button`, `primary`, `primarySmall`, `ghost` |
| `copyText(text)` | Copies, over plain HTTP as well |
| `asksBeforeDeleting()` | Whether the person wants to be asked before something is deleted (Settings → This browser): ask first when it is true |
| `storage.local`, `storage.session` | The browser's storage, which never throws |
| `useFollowBottom`, `useNow`, `tabKeys` | A box that follows its end; the time, each second; arrow keys for a row of tabs |
| `inOverlay(target)` | Whether a press is inside something the portal draws over the page: the list of a `Select` or a `Menu`, the question `confirm` asks. A popover of yours that closes on a press outside it counts these as inside |
| `isEnter(event)`, `isEscape(event)` | Enter that means "done" and Escape that means "never mind", not the ones that pick or dismiss a word of an input method (Japanese, Chinese, Korean). Use them in a key handler instead of `event.key === "Enter"` |

The portal's own utility classes (Tailwind) exist only for what the portal
itself uses, so do not rely on one being there. Style your markup in your own
stylesheet, or have the build make the utilities your code uses: with
`tailwind: true`, `buildExtension` reads `src/` for class names and adds the
utilities they are to `web/client.css`, after your own rules. They are made
with the portal's preset, `@pithagoras/extension-api/tailwind`, so
`bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`, `text-danger`,
`rounded-xl` and `shadow-pop` are the portal's colours, rounding and shadow and
follow the theme. Tailwind's reset of the page is left out: the page has the
portal's. The utilities reach only your own parts: the portal draws each part
you register inside an element marked with your package's name
(`data-extension`, laid out as if it were not there), and the build scopes each
utility to it. The portal's utilities go by the same names, and yours, coming
after them, would otherwise win over its own on every page (a `.flex` over an
`md:hidden`). tailwindcss and postcss are then the extension's to install,
beside esbuild.

## Slots

A slot is a place in the portal with a name. Every entry has an `id`, which
names it among your package's entries in that slot, and a `component`. `order`
puts it before entries with a higher one, or none.

| Slot | Where | Entry | The component is given |
| --- | --- | --- | --- |
| `chat.panel` | Beside the conversation, docked, floated and sized like Files and Git | `title`, `icon?`, `header?`, `actions?`, `useButton?`, `name?` | `chat`, `channel`, `panels`, `close()`, `panel` |
| `chat.header.action` | The chat's header, before the panels' buttons | | `chat`, `channel`, `panels` |
| `chat.tool` | A call of one tool in the conversation, in place of the portal's card | `tool` (its name) | `chat`, `channel`, `panels`, `call`, `card` |
| `chat.tool.action` | On the portal's card of a call, under what it returned, when the card is opened | `tool?` (a name or a pattern; every call without it) | `call`, `cut`, `panels` |
| `chat.composer.above` | Above the message box | | `chat`, `channel`, `panels` |
| `chat.overlay` | Over the chat, placed by you | | `chat`, `channel`, `panels` |
| `chat.background` | Nowhere: there while the chat is on screen, drawing nothing | | `chat`, `channel`, `panels` |
| `voice.window` | A window in voice mode, placed and sized like the portal's own | `title`, `icon?`, `place?`, `maximizable?`, `keepLoaded?`, `useAutoOpen?`, `opensFor?`, `describe?` | `chat`, `channel`, `panels`, `close()`, `opened`, `maximized`, `maximize()`, `restore()` |
| `nav.page` | A page at `/x/<package>/<id>`, with an entry in the sidebar | `title`, `icon?`, `useShown?` | |
| `settings.page` | Your package's page in Settings, above the fields the portal found for it | | |

`chat` is `{ id, title, workspace }`. `channel` reaches
[your pi extension in that chat](#talking-to-your-pi-extension). `panels` is
your own panels there: `isOpen(id)`, `open(id, params?)`, `close(id)`. `icon`
is a component that draws an `<svg>`; the portal sizes it.

A component in a chat is made anew for each chat, so its state is that chat's.

### A panel

Two panels fit beside a conversation. A third closes the one open longest,
whoever brought it.

```js
portal.slots.register("chat.panel", {
  id: "notes",
  title: "Notes",
  icon: NoteIcon,
  component: NotesPanel,
  // In the panel's head, where its title would be: tabs, a count.
  header: NotesTabs,
  // In the panel's head, before its close button.
  actions: NotesActions,
  // A hook, called as the chat's header is drawn: how its button is for this chat.
  useButton: ({ chat }) => {
    const count = useCount(chat.id);
    return { hidden: false, live: false, title: count ? `Notes (${count})` : "Notes" };
  },
});
```

`useButton` may return `hidden` (no button until there is something to open:
the portal's Subagents button is like this), `live` (a dot that says something
in it is running) and `title`.

The body, `header` and `actions` are each handed `panel`, the panel's say over
itself:

| `panel.` | |
| --- | --- |
| `params` | What it was last opened with: `panels.open("notes", { draft })` |
| `state`, `setState(next)` | Shared by the body and what is in the head, and kept while the panel is open: which tab is shown |
| `keep(true)` | It is not the one closed to make room for a third: there is something in it that would be lost |
| `guardClose(fn)` | Asked before it is closed by hand; it stays open if `fn` answers false. `null` to stop asking |
| `open(name, params?)` | Opens another panel from this one, as `portal.panels.open` does, but this one is not the one closed to make room for it: Git opening a file it lists in Files |

```js
// A note being written would be lost.
React.useEffect(() => {
  panel.keep(writing);
  panel.guardClose(writing ? () => portal.ui.confirm({ title: "Discard the note you were writing?", confirmLabel: "Discard", danger: true }) : null);
}, [writing]);
```

### A tool's call

```js
portal.slots.register("chat.tool", { id: "note", tool: "note", component: NoteCall });

function NoteCall({ call, panels, card }) {
  // While it runs, and when it failed, the portal's own card says it best.
  if (call.status !== "done") return card;
  return h("div", { className: "pn-call" }, String(call.input.text), h("button", { onClick: () => panels.open("notes") }, "Open Notes"));
}
```

`call` is `{ name, callId, status, input, output, details, files }`: what the
tool was called with, what it has returned so far as text, its result's
`details`, and the [files it gave](#files-a-tool-gives) once it ended, each
`{ path, kind, title?, from?, url }`. `card` is the portal's own card for the
call, with those files drawn under it, to return as it is or to draw beside
something of your own. A card that leaves `card` out draws the files its own
way, from `url`.

### An action on a call's card

Where the portal's own card is right for a call and you only have something to
add to it ("Open in the terminal"), register an action for the tool. It is
drawn on the card, under what the call returned, once the card is opened, in
the conversation and wherever else the portal draws the card.

```js
portal.slots.register("chat.tool.action", {
  id: "open",
  tool: /^(bash|shell)$/,
  component: ({ call, cut }) =>
    call.callId ? h(portal.ui.ToolLink, { onClick: () => portal.panels.open("my-shell", { callId: call.callId }) }, cut ? "Show all of it" : "Open in My shell") : null,
});
```

`cut` says whether the card shows only the end of the output, and `chat` is
the chat whose conversation the card is in: a card elsewhere, such as in a
subagent's run, has none, for an action that is only about the chat's own
calls. `ui.ToolLink` is the portal's own look for a link on a card. Draw
nothing for a call you have nothing for. The `panels` the component is given are your own, by id;
`portal.panels` reaches any panel by name, as `my-shell` above is reached by
the `name` its `chat.panel` entry gave it.

### A window in voice mode

A `voice.window` has a button in voice mode's toolbar. More fields say how it
behaves beside the portal's own windows:

- `place`: `"side"` or `"middle"`, where it goes when it has the choice, as the
  terminal's window goes to the side and the browser to the middle. Without it,
  it takes whichever place is left, as Files does.
- `useAutoOpen(props)`: a hook, called while voice mode is on in a chat. It
  returns a count, and the window opens each time the count grows: the number
  of commands the agent ran, say, from `portal.chats.use`.
- `opensFor(call, chat)`: whether the card of a call in voice mode opens this
  window when it is tapped. It is asked for the calls the portal's own windows
  are not for: a page's card opens the browser, and a file's or a shell call's,
  which have none of the portal's, the window that says it is for them (Files',
  the terminal's). `chat.workspace` tells a path in the chat's folder from one
  elsewhere.
- `describe(call, chat)`: what the card of such a call says, `{ label, detail? }`,
  in place of the portal's words for a tool it does not know ("Using canvas
  write"): Canvases' cards say "Writing in a document" and its title.
- `maximizable`: its head gets a Maximize button, as the browser's has. The
  window then fills the stage, over the other windows and above the dock,
  until it is restored: by its button, by Escape, by being minimized, or by
  another window opening. Your component is told `maximized`, and can call
  `maximize()` and `restore()` itself.
- `keepLoaded`: once it has opened, it stays while it is minimized, hidden and
  out of reach, so a frame or a stream in it is not loaded again each time it
  opens. Without it, a minimized window is gone until it opens again.

Your component is told `opened`: what it was opened for, the last time it was,
a new object each time. `{ by: "person" }` with its button, `{ by: "work" }`
for what `useAutoOpen` counted, `{ by: "call", call }` for the card of a call
that was tapped, and `{ by: "open", params }` for your own
`windows.open(id, params)` in a shortcut. Files' window shows the file of a
tapped card this way, and the file the agent just changed when that is what
brought it up.

```js
portal.slots.register("voice.window", {
  id: "shell",
  title: "Terminal",
  place: "side",
  useAutoOpen: ({ chat }) => portal.chats.use(chat.id, (feed) => feed.events.filter((e) => e.type === "tool_execution_start" && e.payload.toolName === "deploy").length),
  opensFor: (call) => call.name === "deploy",
  component: Shell,
});
```

Escape pressed in a frame of your window's never reaches the stage: the frame
has the key. If your window can be maximized and shows a page of the same
origin, listen for Escape in the frame and restore the window there:

```js
function Viewer({ maximized, restore }) {
  const latest = React.useRef({ maximized, restore });
  latest.current = { maximized, restore };
  const hear = (frame) =>
    frame.contentWindow.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && latest.current.maximized) latest.current.restore();
    }, true);
  return h("iframe", { src: portal.api.url("/view/"), onLoad: (e) => hear(e.currentTarget) });
}

portal.slots.register("voice.window", { id: "viewer", title: "Viewer", place: "middle", maximizable: true, keepLoaded: true, component: Viewer });
```

### A page

A `nav.page` is at `/x/<package>/<id>`, with an entry in the sidebar. The
entries of every extension are together in one group, **Extensions**, after
the portal's own pages and before **Audit**, which stays last. The group folds
like a folder, is remembered per browser, and is held open while one of its
pages is showing. On the folded sidebar it is one puzzle button, before the
one for Audit, that opens a menu of the pages. With no page, there is neither.
`useShown()` is a hook, called as the sidebar is drawn:
whether the entry is listed now. Use it for a page whose service is not set
up, as the browser's page is not listed before there is a browser. Until it
returns `true` the entry is not listed; the page is at its address either way.

### A part that only listens

`chat.background` is for what must happen while the chat is on screen whether
or not a panel is open: opening your panel when there is something to see.

```js
portal.slots.register("chat.background", { id: "watch", component: ({ chat, panels }) => {
  React.useEffect(() => portal.server.on((chatId, data) => {
    if (chatId === chat.id && data.type === "created") panels.open("canvas", { id: data.id });
  }), [chat.id, panels]);
  return null;
} });
```

## The chat's events

`portal.chats.use(chatId, pick?)` is a hook that gives a component the chat as
the page has it:

| | |
| --- | --- |
| `events` | The chat's own events as they came: pi's (a message as it streams, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `agent_start`, `agent_end`) and the portal's (`portal_*`). Each is `{ seq, type, at, payload }` |
| `items` | The conversation made of them, as the portal draws it: messages, tool calls with their output, notices |
| `calls` | The tool calls that have not ended, oldest first: the ones the model is writing now, and the ones it has written that are running. Each is `{ name, callId, status, input, output?, details? }`, as a `chat.tool` card's `call` is (see [below](#a-call-as-the-model-writes-it)) |
| `call(callId)` | A call of the conversation by its id, ended or not: to follow one from `calls` to how it came out |
| `running` | The agent is at work |
| `status` | How the chat stands: `"idle"`, `"running"`, or stopped by `"error"` or by hand (`"interrupted"`). After those two, a call that has not ended will not |
| `loading` | The conversation is still being fetched |
| `background` | What runs in the chat besides the conversation, asked of the portal while the chat is on screen: `{ supported, jobs, statuses, widgets }`. `jobs` are the commands the agent left running, each `{ key, command, state, startedAt, pids, hasOutput, attached }`; `statuses` and `widgets` are what pi's extensions show in its footer |
| `refreshBackground()` | Asks for `background` again at once: after a job was stopped (`POST /api/sessions/<chat>/background/<key>/stop`) or the finished ones cleared (`…/background/clear`) |

A tool call among `items` is `{ kind: "tool", id, name, callId, status, args,
output, details }`, with `status` going from `"running"` to `"done"` or
`"error"` and `output` growing as the tool reports. That is all a terminal
needs to show what the agent runs:

```js
const shell = (feed) => feed.items.filter((item) => item.kind === "tool" && item.name === "bash");

function AgentTerminal({ chat }) {
  const runs = portal.chats.use(chat.id, shell);
  return runs.map((run) => h("pre", { key: run.id }, `$ ${run.args.command}\n${run.output ?? ""}`));
}
```

::: tip Say what you use
A chat changes with every token of a reply. With `pick`, the component is
drawn again only when what it picked is no longer the same (the same value, or
a list or object of the same values). Without it, with every change. The panel
above is not drawn again while the agent writes its answer, only when a shell
call starts, reports or ends.
:::

Of a long conversation `events` and `items` hold the latest part, and more as
the person scrolls back. `portal.chats.on(chatId, handler)` is the same outside
a component, for a module that keeps something of its own from the chat.

### A call as the model writes it

A call in `calls` has `status: "writing"` while the model is still writing it:
its `input` is its arguments as far as they have come, a string cut where it has
come to, read again a few times a second rather than with each token, so that a
long one costs no more as it grows. It has not run yet, and may never (a call
the chat refuses ends at once). Once the model has written it, it is `"running"`
with all of its arguments, and it leaves `calls` when it ends, with what it
answered in `call(callId)`. A call through the lazy tools' gateway is the call of
the tool it calls.

That is all it takes to show what the agent is writing before the tool runs, as
Documents does (`extensions/docs/web/client.js`): the tool saves when it runs,
and until then the draft is the page's alone.

```js
const writing = (chat) => portal.chats.use(chat, (feed) => feed.calls.filter((call) => call.name === "note_write"));

function NoteDraft({ chat }) {
  return writing(chat.id).map((call) => h("pre", { key: call.callId }, String(call.input.text ?? "")));
}
```

It happens only in a page that has the chat open, from the stream the page has
anyway: nothing of it is done where nobody looks (a channel, a routine).

## Talking to your pi extension

What is drawn in a chat has a `channel` to the package's own pi extension in
that chat. On the pi side it is pi's event bus (`pi.events`), so the extension
needs no dependency on the portal, and outside it nobody is listening.

| Channel | Direction | Payload |
| --- | --- | --- |
| `pithagoras:v1:ui:send` | pi extension → its browser half | `{ extension, data }` |
| `pithagoras:v1:ui:receive` | browser half → pi extension | `{ extension, data }` |

`extension` is the package's name; every extension in a chat shares the bus,
so take only what carries yours. `data` is yours to define, and anything that
is JSON.

```ts
// index.ts
const NAME = "my-extension";

export default function (pi) {
  let notes = [];
  const tell = () => pi.events.emit("pithagoras:v1:ui:send", { extension: NAME, data: { type: "notes", notes } });

  pi.events.on("pithagoras:v1:ui:receive", (message) => {
    if (message?.extension !== NAME) return;
    if (message.data.type === "ready") tell();
  });
}
```

```js
// web/client.js, in a component
React.useEffect(() => {
  const off = channel.on((data) => data.type === "notes" && setNotes(data.notes));
  channel.send({ type: "ready" });
  return off;
}, [channel]);
```

Nothing sent either way is stored, and what the extension sends reaches only
the pages open on the chat just then. So a component asks where things stand
when it is drawn (the `ready` above), and the extension keeps its state where
pi keeps a conversation's: `pi.appendEntry()` for what the model should not
see, a tool result's `details` for what follows the branch.

### Slash commands

A slash command is the pi extension's to register (`pi.registerCommand`), as
in any pi package, and the portal's palette lists it with the rest. When the
command should do something in the page, its handler says so to the browser
half, which is there to hear it whether or not a panel is open:

```ts
// index.ts
pi.registerCommand("notes", {
  description: "Open this chat's notes",
  handler: async () => pi.events.emit("pithagoras:v1:ui:send", { extension: NAME, data: { type: "open" } }),
});
```

```js
// web/client.js
portal.slots.register("chat.background", { id: "commands", component: ({ channel, panels }) => {
  React.useEffect(() => channel.on((data) => data.type === "open" && panels.open("notes")), [channel, panels]);
  return null;
} });
```

`channel.send` starts the chat's agent if it had been let go, so a panel
opened on such a chat reaches its extension after a moment. What an extension
sends on its own clock does not count as use of the chat. `channel.send`
rejects where the chat's agent does not run in the portal's process, which is
every executor but `EXECUTOR=host`; no agent is started there to find that
out. For anything that must work there too, use
the server half.

## The server half

```js
// server.js
export default function (portal) {
  portal.router.get("/notes", (req, res) => res.json({ chats: allNotes() }));
  return () => { /* called when the package goes, or the portal stops */ };
}
```

It is loaded once, into the portal's own process, and stopped and started
again when the package is installed, removed, updated or switched. It runs
with the portal's rights, as the package's pi extension does. It is an ES
module (`"type": "module"` in `package.json`, or a `.mjs` file).

It has fifteen seconds to start and five to stop; one that takes longer is
given up on, with the reason beside the package in Settings → Extensions, and
nothing else waits for it. The module itself is read again each time it is
started. What it imports from its own package is read once for as long as the
portal runs, as Node reads modules: after an update that changes those files,
restart the portal.

| `portal.` | |
| --- | --- |
| `router` | An Express router: the package's routes, at `/api/x/<package>/…`, behind the portal's login |
| `http.json()`, `http.raw()`, `http.text()` | Body parsers, for the routes that want one |
| `http.upgrade(handler)` | WebSocket upgrades under the package's routes |
| `http.endWithLogin(end)` | Ends a long response, such as a stream, when the login it was opened under ends (the password changed, single sign-on was set up anew), so what it showed is not shown to whoever signs in next. Returns what stops the watching, for a response that ended by itself |
| `chats.get(id)`, `chats.list()` | A chat: `{ id, title, workspace, status }` |
| `chats.folder(id)` | The folder the chat's pi works in, on this disk |
| `chats.send(chatId, data)`, `chats.onOpen(fn)` | [Telling the pages open on a chat](#telling-the-pages-open-on-a-chat) |
| `chats.on("started" \| "stopped" \| "deleted", fn)` | A chat's pi started or stopped; the chat was deleted |
| `chats.onEvent(fn)` | Everything a chat's pi says, as it says it |
| `chats.tell(chatId, data)` | To the package's own pi extension in a chat (`pithagoras:v1:ui:receive`) |
| `chats.followUp(chatId, { text, details?, type? })` | [Says something to the chat's agent](#saying-something-to-the-agent) as a message of the package's, starting its pi if it was let go |
| `push(topic, data)`, `onListen(handler)` | [Pages that listen to a topic](#pages-that-listen-to-a-topic): tell them what changed, and decide who may listen |
| `chats.extend(factory)` | [Tools that share this module's state](#tools-that-share-the-server-half-s-state) |
| `chats.offers(chatId, tool)` | How the chat's model is offered a tool now: `"direct"`, `"lazy"` (through the `tools` tool) or nothing (switched off, out of reach, or the chat's pi not running here) |
| `chats.hold(chatId)` | Keeps the chat's pi from being let go for being idle, or reloaded, while work goes on; returns what lets it go |
| `sandbox.run(chatId, argv, options?)`, `sandbox.spawnAs(chatId)`, `sandbox.on()` | [Running things as the chat's agent](#running-things-as-the-chat-s-agent) |
| `sandbox.personEnv()` | The portal's environment for a process the person starts, such as a shell of their own: without the mark the agent's processes carry, so it is not listed as a job the agent left running |
| `files.inside(base, rel)` | A path checked to be inside a folder |
| `files.list`, `read`, `readBytes`, `write`, `rename`, `unsaved`, `remove`, `removeFile`, `renameFile`, `makeFolder`, `folder`, `identity`, `hold`, `upload`, `watch`, `sweepTemp`, `open` | [A chat's folder](#a-chat-s-folder), read and changed with the portal's own checks |
| `git.at(folder)` | [git and gh in a folder](#git-in-a-chat-s-folder), run as the portal runs its own |
| `dataDir()` | [A folder of the package's own in the portal's data folder](#where-it-keeps-things), closed to everyone but the portal |
| `sqlite` | [SQLite](#a-database), the driver the portal's own database runs on: `new portal.sqlite(file)` |
| `provide(factory)`, `extensions.use(name)` | [Building on another extension](#building-on-another-extension): what it gives the extensions that build on it, and what one it builds on gives it |
| `log(text)`, `extension`, `executor`, `version` | A line in the portal's log; the package's name; how pi is run here; `1` |

### Routes

```js
portal.router.get("/chats/:id/files", (req, res) => {
  const folder = portal.chats.folder(req.params.id);
  res.json(portal.files.list(folder, String(req.query.path ?? "")));
});
// A body is read only where a route asks for it.
portal.router.post("/chats/:id/notes", portal.http.json(), (req, res) => { /* req.body */ });
// A route that takes a file reads the body itself, and streams it to disk with portal.files (not req.pipe into a path built
// from the folder and a name: that follows a link the agent left there).
portal.router.post("/chats/:id/upload", async (req, res) => {
  const folder = portal.chats.folder(req.params.id);
  res.json(await portal.files.upload(folder, String(req.query.path ?? ""), String(req.query.name), req));
});
```
A file that arrives in a request is `files.upload`'s: it is written to disk as it
comes, so a big file is never held in memory, and put in place when all of it has,
never over something there (`report.pdf` is followed by `report (2).pdf`). Do not
build its path yourself, see [A chat's folder](#a-chat-s-folder).

Routes are written from the package's own root. From the browser half,
`portal.api.url("/chats/a/files")` is their address and `portal.api.json` asks
as the portal's own requests do: JSON back, an `ApiError` with what was said
for one refused, and a login that has gone told to the page. The rest of a
path reaches your routes as it was written, to be read once: a file called
`what?.md` asked for as `what%3F.md` is `req.params.name === "what?.md"`.

A route can stream as well: write `text/event-stream`, or take an upgrade with
`portal.http.upgrade((req, socket, head) => …)`, which the portal has already
checked for the login and for the page it comes from. An answer held open is
ended when the portal's password changes, as the portal's own streams are.

### Where it keeps things

What a server half keeps for a chat it keeps where the chat's pi works: in the
chat's folder, `portal.chats.folder(id)`. The agent can read what is there, it
moves with the project, and it is gone when the folder is. Give it a folder or
a name of your own, check every path that came from outside with
`portal.files.inside`, and read and change what the agent may have written
there with `portal.files` (see [A chat's folder](#a-chat-s-folder)).

```js
const file = portal.files.inside(portal.chats.folder(chatId), `.my-extension/${chatId}.json`);
```

Several chats can work in one folder, so name what is one chat's by the chat.

What the portal itself must run on, and an agent must not be able to change, is
kept elsewhere: `portal.dataDir()` is a folder of the package's own in the
portal's data folder (`extension-data/<package>`, made when it is first asked
for, mode 0700). With the [sandbox](/guide/sandbox) on, the portal runs as
root and the agents run as users of their own: a git repository or a database
in a chat's folder is one an agent could change (a setting git reads, a file
SQLite opens) under the portal's rights, and one in this folder is not. It is
not part of the project: it is not copied with it and not deleted with it, so a
package that keeps something for a project here also has to know which project
that is (a folder can be moved, or deleted and made again).

```js
const store = path.join(portal.dataDir(), folderId);   // the portal's alone: nobody else can read or change it
```

[Documents](/guide/documents#where-the-history-is-kept) keeps its history there.

#### A database

A package that keeps a database does not bring a driver of its own, with a native
binary to install for the system it runs on: `portal.sqlite` is the one the portal's
own database runs on (better-sqlite3), and a server half opens its files with it.
Calls are synchronous, as that library's are.

```js
import path from "node:path";

const db = new portal.sqlite(path.join(portal.dataDir(), "notes.db"));   // made if it is not there
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
const add = db.transaction((texts) => texts.map((text) => db.prepare("INSERT INTO notes (text) VALUES (?)").run(text).lastInsertRowid));
add(["one", "two"]);
db.prepare("SELECT text FROM notes").pluck().all();   // ["one", "two"]
```

`new portal.sqlite(file, { readonly, fileMustExist, timeout })` is what a package needs
of it; `prepare` (`run`, `get`, `all`, `iterate`, `pluck`), `exec`, `pragma`,
`transaction` (`.immediate` takes the write lock first) and `close` are typed in
`@pithagoras/extension-api/server`. The files are SQLite's own, the same whoever opens
them, so a database made by a package that had a driver of its own is opened as it is.
Keep a database an agent must not change in `portal.dataDir()`, not in a chat's folder
(see above). `@pithagoras/extension-api/testing` gives a test the same driver
(`portalSqlite()`, and `mockPortal` has it).

### A chat's folder

Reading and changing what is in a chat's folder goes through `portal.files`,
not through `fs`. These are the portal's own functions (`workspace-files.ts`),
the ones it uses for uploads and pictures, and [Files](/guide/files) is built
on them. They are given to every server half because doing this by hand is
easy to get wrong in a way that is a hole, not a bug:

- **The agent writes there, links included.** A path a page sends is checked as
  text (no `..`, no way out by an absolute path) and again where every link
  along it really leads. `fs.readFile(path.join(folder, rel))` follows a link
  the agent left, `notes.md → /data/portal.db` say, to wherever it points.
- **A server half has the portal's rights, which can be more than the agent's.**
  With the [sandbox](/guide/sandbox) on, the portal runs as root and the agent
  as a user of its own. A file the agent cannot read, the portal can, and so
  can a server half that is led to it.
- **A check and an open are two steps.** Between them the agent can put a link
  where the file was, or where a folder on the way to it was, and the portal,
  which may be root, would then read, make or remove a file where the link leads.
  A file is opened without following a link in its last place (`O_NOFOLLOW`), and
  what is sent is read from what was opened, never by opening the path again. The
  folder it is in is held open too, walked down from the chat's folder one part at
  a time and never through a link, and the file is read, made and put in place in
  that folder, whatever happens to the path meanwhile. That holds on Linux, where a
  held folder can be named as `/proc/self/fd/<n>` (and a folder the portal may
  search but not read still works: it is walked through with `O_PATH`, and only
  its sync is left out); where there is no `/proc`
  (macOS) a folder on the way can still be swapped between the check and the
  call, and so the portal gives nothing it makes away there (below). A pipe left
  there does not hold the server, and a device is not read.
- **The agent can rename things.** With the [sandbox](/guide/sandbox) on, a folder or file the agent may not
  enter is root's alone (`root:root`, mode 0700 or 0600). The agent writes in its chat's folder, and a rename
  there needs only the right to write in that folder, so it can rename that folder to the name of one your half
  reads as root on its behalf (`documents`), or move that file into it, and your half would hand it what it could
  not read itself. Where your half keeps something under a name the agent can choose, pass `likeParent: true`
  (`folder`, `identity`, `list`, `read`, `readBytes`, `open`, `write`, `removeFile`, `renameFile`, `sweepTemp`): the folder, and the
  file in it, must be something the agent could use itself. That is told as the kernel would tell it for the user
  and the groups the sandbox runs the agent as (its own and the sandbox group), from the owner, group and mode of
  the folder as it is held: the owner's bits if the agent's user owns it, else the group's if the group is one of
  the agent's, else everyone's. Who owns it says nothing (a project is root's too). What is read from a folder (`folder`, `list`, `read`, `readBytes`, `open`) needs
  the agent to read and search it, what is changed in it (`write`, `removeFile`, `renameFile`, `sweepTemp`) to
  write in it and search it, a folder that is held to (`identity`) both, and a file that is read (or replaced) to be
  readable by it. Otherwise the call is refused (`invalid`). It is checked on the folder as it is held, so it
  cannot be swapped in between. With the sandbox off the agent is the portal's own user, and nothing is refused.
- **A save is put in place whole.** It is written beside the file and renamed
  over it, so a full disk leaves the file as it was, not empty. It keeps the
  file's mode and its owner, so a file the portal saved as root is still the
  agent's to change. With `expected`, the time the file was read at, a file
  the agent changed since is refused (`conflict`) rather than written over. A
  file with a second name (a hard link, which may be outside) is left alone.
- **A delete or a rename changes the link, not what it leads to**, never the
  folder itself, and a folder holding git work that exists nowhere else (changes
  not committed, commits no remote has, stashes) is refused (`unsaved`, with
  what it holds) unless `discard` says so. `unsaved(base, rel)` asks first, for
  a question that names it. A folder is taken away with all in it through
  descriptors: each folder below the one it is in is opened without following a
  link and emptied through its own descriptor, never found again by its path,
  which `rm` does and which follows a folder the agent swapped for a link while
  the walk was under way (as root, into whatever the link leads to). A folder
  that is swapped under the walk stops it (`failed`) and leaves the rest; one
  nested more than 512 deep is not taken away here. A rename and a listing are
  done in the folder as it is held, too.
- **A rename never puts a file over another.** `rename` makes the new name a
  second name of the file or the link (a hard link) and then takes the old one
  away: the system refuses the link in the call itself if something has the new
  name (`exists`, whatever the agent made there since the look), where a plain
  `rename` puts the file over it; a name swapped for something else between the
  look and the call is `conflict`, and nothing is renamed. A crash between the
  two halves leaves one file with two names, never none. If the old name cannot
  be taken away, the new one is given up again, but never when it is the thing's
  only name (a folder took the old name just before): nothing is deleted for
  that, and the rename stands. A new name that the file system does not tell from
  the old one (only capitals, or the form of a letter, differ: macOS, Windows, a
  casefold folder) is the old name itself, so it is `exists`. A folder cannot be
  linked: it is renamed after a look at the new name, which leaves a short gap
  for an empty folder made there in between, as does a file system without hard
  links (or `protected_hardlinks` for a file that is not the portal's own).
- **A file of your own that you delete or rename can go by `removeFile` and
  `renameFile`.** They are `remove` and `rename` for one plain file and nothing
  else: a link or a folder is `invalid`, where `remove` takes the link or all of
  the folder, and `alone` also refuses a file with a second name. Both are done
  by the same code, in the folder as it is held, not by its path. `direct` is an
  option of all four, as of `open`; `likeParent` too, for a server half that
  works in a folder an agent can rename things into: the folder `base` must be
  one the agent could write in (see above), and one the sandbox closed to it is refused.
  `expect: { dev, ino }` is an option of all four as well: the folder the entry is
  in must be that one, by its device and inode (what `stat` says of the folder, or
  `files.identity`, as numbers, text or bigint), or the call is `conflict` and
  touches nothing. A half that deletes or renames in a folder it decided on earlier
  keeps the identity of that folder and passes it: the check is made on the
  descriptor of the folder the call works in, so another folder swapped onto the
  path meanwhile (one the agent may not write in, which the portal, as root, could)
  is never changed.
- **A save lasts.** After the rename the folder is synced too, so a crash
  right after leaves the new file, not the old one. An upload and a file the
  portal makes are synced the same way.
- **Limits:** a file over 1 MB is not read or saved as text, and a folder with
  more than 2,000 entries is listed in part (`truncated`), cut before each is
  looked at, so a huge folder does not hold the thread every chat is served on.

`base` is a folder from `chats.folder`, `rel` the path the page sent. A refusal
throws an error with a `code`: `invalid`, `missing`, `conflict`, `exists`,
`too_large`, `failed` or `unsaved`. Answer it by that code rather than by its
sentence:

```js
const STATUS = { invalid: 400, missing: 404, conflict: 409, exists: 409, too_large: 413, failed: 500, unsaved: 409 };
portal.router.put("/chats/:id/file", portal.http.json(), (req, res) => {
  try {
    const folder = portal.chats.folder(req.params.id);
    res.json(portal.files.write(folder, String(req.query.path), req.body.content, { expected: req.body.mtime }));
  } catch (e) {
    if (e.code in STATUS) res.status(STATUS[e.code]).json({ error: e.message, code: e.code });
    else res.status(500).json({ error: "Could not save it" });
  }
});
```

**Which folder it is.** A store a package keeps for a folder needs to tell "the same
folder, moved" from "another folder at the old path". `files.identity(base, rel)`
is the folder's device and inode as text (`{ dev, ino }`), read from the folder as
it is held, so that it is the folder the checks were made on and not what its path
leads to by then. Two folders never have the same pair at once, a folder that is moved
keeps it and one that is deleted and made again does not; a number can be given to the next
folder made, so it says that a folder is the one it was while it exists, not for ever
(compare something of its contents too, as Documents does).

What reads a whole folder, such as an archive, holds it: `files.hold(base, rel)`
opens the folder without following a link in any place on the way, and a child
process is given the descriptor, not a path (`files.folder` gives a checked path,
and a child started with it reads whatever a link put there since leads to). A
download is sent from the descriptor `files.open` gives. Every folder on the way
needs read permission for the portal. Files' server half
(`extensions/files/src/server.ts`) is a complete example, its archive:

```js
const held = portal.files.hold(folder, "box");   // refuses what `folder` refuses
try {
  // The child has the descriptor as its stdio number 3 and names the folder by it.
  spawn("tar", ["-czf", "-", "-C", held.inChild(3), "."], { stdio: ["ignore", "pipe", "pipe", ...(held.fd === undefined ? [] : [held.fd])] });
} finally {
  held.close();   // the child has its own copy by now
}
```

**Bytes, and telling a file changed.** `read` gives text, and says "binary"
for a file with null bytes. For a file that is not text, or must come back
exactly as it was, `readBytes` gives a `Buffer`, and `write` takes one (a file
is still at most 1 MB). Both, and `open`, tell `change` and `mtime` as they
were when the file was opened; `write` answers with those of the file it wrote.
`change` is a text to keep and compare for equality, nothing more: it differs
when the file was written in place (its times) and when another file was put
there by a rename (its inode), so a page of notes can tell "unchanged" from
"changed" without reading the file. `head` reads only the start of a file
(`head: 0` none at all, for its `change`), and `open` keeps a descriptor that
reads the file as it was opened, whatever is put in its place after.

```js
const stamp = portal.files.readBytes(folder, "notes.md", { head: 0 }).change;   // no bytes read
if (stamp !== saved.change) {
  const { bytes, change } = portal.files.readBytes(folder, "notes.md");
}
```

For a file that is to be exactly what its name says, `direct` and `alone` are
options of `open` and `readBytes` (`direct` of `write` and `folder` too).
`direct` refuses a name that a link led somewhere else (even to another file in
the folder, which `inside` follows without a word), or that is a way, not a
name; a half that keeps its files in a folder of its own name in the chat's
folder asks `folder(base, "documents", { direct: true })` and is told when that
is a link. `alone` refuses a file with a second name. A refusal is `invalid`.

**What the portal makes is the agent's to edit.** A file that `write` makes
(not one it replaces), a folder that `makeFolder` makes and a file that is
uploaded have the mode, the owner and the group of the folder they are made in
(a file 0644, and group-writable where the folder is), and a folder is given
that through itself, never by its path, so that a link put in its place by the
agent meanwhile gets nothing. A new folder is made closed to everyone but the portal
and is given its mode and owner only if it is still the one that was made: `mkdir`
and the open of the new folder are two calls by its name, and an agent that writes
in the folder can swap another folder of it onto that name in between, so one that
holds anything, or is on another file system, is left alone and the name is
`exists`. The owner and the mode are the held folder's own,
read from its descriptor, and a file or a folder is given away only once it is
known to be in the chat's folder (Linux), so that a folder the agent swapped for
a link cannot make the portal, as root, hand the agent a file anywhere else. With
the sandbox on, the portal is root and the agent another user: what the portal made as
root would not be the agent's to change otherwise. Where the portal may not give
a file away (it is not root and the folder is someone else's), it stays its own,
in the group it can: it is group-writable only if that group is the folder's. A
portal on a system without `/proc` gives nothing away.

**Which folder it is.** A half that holds to a folder (Documents deletes and renames only in the folder it
holds to) needs to tell it from another that was put at the same path. `files.identity(base, rel)` is the folder's
device and inode as text (`{ dev, ino }`), read from the folder as it is held, so that it is the folder the checks
were made on and not what its path leads to by then. Two folders never have the same pair at once, a folder that
is moved keeps it and one that is deleted and made again does not; a number can be given to the next folder
made, so it says that a folder is the one it was while it exists, not for ever. It takes `direct` and
`likeParent`: a folder the agent could not use is not given an identity, so a half that holds to what it is
given never holds to one the sandbox closed to the agent. Pass the identity as `expect` to `removeFile` and
`renameFile`.

**Temporary files.** A save writes `.<name>.<12 hex>.tmp` beside the file until
it is renamed. One that was cut off stays. `sweepTemp(base, rel)` removes those
older than a minute (`olderThanMs` to change that) and says which: a save of
the portal's or of another half that is under way has such a file too, and the
age is what keeps it. Do not match the names and remove them yourself.

A refusal for the system's own reasons is `failed`, and says which on the error:
`e.errno` is `ENOSPC`, `EACCES`, `EROFS` and so on, and `e.cause` the error
itself, for a server half that words a full disk differently from a missing right.

[Documents](/guide/documents) is built on these: its files are read with
`readBytes`, written with `write` (`create` for a new document, `direct`) and
told changed by `change`; its folder is found with `folder`, made with
`makeFolder` and listed with `list`; its leftovers are swept with `sweepTemp`; a
document is deleted with `removeFile` and renamed with `renameFile`
(`direct`, `alone`, `likeParent`, and `expect` for the documents folder it keeps the identity of, which it
takes with `identity`).

**Watching a chat's folder** is `files.watch(base, rel, onChange)`. A watch reads
nothing and changes nothing, but it should watch the folder that was meant: the
folder is held and the watch is set on it, so a link put in its place does not
lead the watch somewhere else. It only tells that something in the folder may have
changed, once the burst of changes is over (`debounceMs`, 100 by default), and a half
that then looks does so through `portal.files`. When the folder is removed,
renamed or replaced the watch ends by itself after `onChange({ gone: true })`:
watch the folder that is there now (`watch.current()` says whether the folder at
its place is still the one watched). A system that cannot watch (too many
watches, a file system that has none) is `failed`, with its code in `errno`, and
what to fall back on, looking at the folder every so often, is the extension's own.

```js
const watch = portal.files.watch(folder, "documents", ({ gone }) => {
  if (gone) return startAgain();
  portal.push("documents-changed", portal.files.list(folder, "documents").entries.length);
}, { direct: true });
```

### Telling the pages open on a chat

```js
// server.js
portal.chats.onOpen((chatId) => ({ type: "count", count: read(chatId).length }));   // to a page as it opens the chat
portal.chats.send(chatId, { type: "count", count: notes.length });                  // to every page open on it, now
```

```js
// web/client.js, as the module is called
const counts = new Map();
portal.server.on((chatId, data) => {
  if (data.type === "count") counts.set(chatId, data.count);
});
```

It rides the chat's own event stream, so it costs no connection, and nothing
of it is stored. `onOpen` is what makes it hold together: each time a page
connects to a chat, the first time or after its connection dropped, it is told
where things stand, then each change. Listen for it as your module is called,
as above, and keep what you hear in the module: the page's stream opens before
the extensions are loaded, and what came for yours meanwhile is handed over, in
order, once it has been called. A component that only starts listening when it
is drawn has missed what came before. A module that comes into the page while
a chat is already open (the package was just installed, switched on or
updated) is told what `onOpen` says for that chat then. What is said must be
JSON: something that cannot be written as it is left out, with a line in the
portal's log.

### Pages that listen to a topic

`chats.send` reaches the pages that have a chat open. A page that is not on a chat
(your own page in the sidebar, a list of everything the package has) has none to
ride, so it listens to a **topic** of your package's:

```js
// server.js
portal.onListen(async (topic, page) => {
  const match = /^note\/(\d+)$/.exec(topic);
  if (topic !== "all" && !(match && notes.has(Number(match[1])))) return false;   // not something it has: refused, and heard of nothing
  page.send(topic === "all" ? { count: notes.size } : notes.get(Number(match[1])));   // where things stand, first
  return () => { /* the page stopped listening: undo what was started for it */ };
});
portal.push("all", { count: notes.size });          // to every page that listens to "all", now
```

```js
// web/client.js
const off = portal.server.on("all", (data) => setCount(data.count));   // from now on; off() stops
```

All the pages of the portal share one connection for every extension's topics, which the
portal opens when something listens and opens again, after a wait that grows, when it drops. A
topic is a name of at most 200 characters, with no control characters, and it is your package's
own: another package's page does not hear it, and a page cannot make one up under another
package's name. What is pushed must be JSON, and nothing is stored: a page that was not listening
misses it.

- **Who may listen is yours to say.** `onListen` is called for each page that asks, with the topic as the page
  wrote it. Check that it names something the package has (a folder a chat works in now, a document
  that is there) and return `false` to refuse; throwing refuses too, and a handler that takes over ten seconds
  is refused. The portal has one login, so every page that is signed in is the same person, and with no
  `onListen` any page may listen to any topic of the package's. Make the topic carry what it is about, and
  check it, so that a page cannot listen to what it could not otherwise see.
- **A page hears where things stand first.** `page.send(data)` tells the one page that began to listen,
  and it hears that before anything pushed after. What is pushed while your handler is still working
  reaches the page after it has answered, and not at all if it refuses, so tell the state and not an event
  that may repeat it. After a dropped connection the page listens again and is told where things stand again.
- **What you started for a page is yours to stop.** A function `onListen` returns is called once when the page stops listening:
  it left (`server.on` returned function), its tab closed, its login ended, or your server half stopped. Count
  the listeners of a folder there, and look at the folder only while one listens.
- **Several handlers of one topic in a page share one listening.** The first begins it and hears where
  things stand; one that comes while others listen hears what comes after, so ask for where things stand
  yourself (a request) when you start. A handler that comes as the last one stopped, in the same tick (an effect
  that runs again), is the first again: the page asks anew and is told where things stand.
- **Your server half stopping** (the package is updated, or switched off and on) lets go of every page that listened:
  each is told the topic was lost and asks again until your half is running, when `onListen` decides again.
- The connection is behind the login and ended when the password changes, like the portal's other streams.

Documents listens in two kinds of topic (`folders`, the list; `doc/<folder>/<document>`, one document) and
refuses a document of a folder that no chat works in.

### Saying something to the agent

```js
await portal.chats.followUp(chatId, { text: "The person asked you in a comment…", details: { thread }, type: "ping" });
```

The text goes into the conversation as a message of your package's, which the person reads as a notice and the
model as a message of its own, after the turn that is going on or, when the agent is idle, at once: a turn starts.
The chat's pi is started if it was let go. It resolves `true` as soon as the message is handed to pi (neither the run
it starts nor pi's answer is waited for: a message pi then refuses shows as a `portal_failed` event of the chat, which
`chats.onEvent` hears), `false` where pi does not run in the portal's own process (`portal.executor` is not `"host"`), and
rejects where the chat is gone. `details` is kept with the message for your own tools and cards; `type` names the
kind when you have several. Only a server half can say it: a page cannot make the agent say anything through your
package (`chats.tell` carries what a page says to your *pi extension*, which should not trust it as the agent's words).

### The portal's routes for a chat

A page of yours that shows or sends what is in a chat's folder does not build an address for the portal's own
routes, which the message box and the conversation use too: `portal.chats.files.pictureUrl(chatId, path, version?)`
is the address of a picture to draw (and `videoUrl`, `fileUrl` for a clip and for a file to save), `upload(chatId, dir, file)`
sends a file into the folder (a taken name gets a number), and `portal.chats.background.stop(chatId, key)`,
`clear(chatId)` and `output(chatId, key, from?)` stop a job the agent left running, forget the finished and follow one's output.
Browsing and changing the folder is your own server half's, through `portal.files`.

What the portal knows about paths in the folder is offered too, so that a page does not copy it:

- `portal.chats.files.inside(folder, given)` turns a path as the agent wrote it (relative to its folder, or absolute) into one
  relative to `folder`, and says `undefined` for one somewhere else or the folder itself. `below(dir, where)` is the same for two
  paths you have. Both go by the text of the paths (`..` is followed, links are not), so they decide what to show, never what is allowed:
  the server half checks that.
- `latestActivity(events, folder)` is the file the agent most recently read or changed in the chat's folder, from `ChatFeed.events`:
  `{ seq, path, tool }`, or `null`. A read counts when it starts, a write or an edit when it ends (one that failed does not). `seq`
  is the event, so a newer one means "look again" even at the same file. `ofCall(call, folder)` is the file one call reads or changes.
- `pictures(markdown, folder, url, base?)` turns the pictures an agent wrote as paths in the folder (`![chart](plots/chart.png)`)
  into the addresses `url(path)` gives, which is what makes them draw: the Markdown renderer blocks a relative image. A web
  picture, a `data:` URL and a path outside the folder are left as they are. `base` is the folder the Markdown lies in.

### Tools that share the server half's state

A tool the agent calls is registered in the chat's pi. Made in the server
half, it holds what the server half holds:

```js
const canvases = new Map();

portal.chats.extend((pi, chat) => {
  pi.registerTool({
    name: "canvas_create",
    label: "Create a canvas",
    description: "…",
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    async execute(_id, params) {
      const canvas = create(chat.id, params.title);          // the same store the routes read
      portal.chats.send(chat.id, { type: "created", id: canvas.id });
      return { content: [{ type: "text", text: `Created ${canvas.id}` }], details: { id: canvas.id } };
    },
  });
});
```

The factory is pi's own extension API, called for every chat as its pi loads.
Its tools are listed under Settings → Tools in a group named after your
package, the same group as your package's pi extension's, and that group is
what a lazy mark or a name given to it holds to. A chat whose pi was running
when your package was installed has them after its next reload.
A server half is plain Node, though: what it imports is its own package's
dependencies, not what pi lends its extensions. So a tool's parameters are
written as a JSON schema, as above, unless the package depends on `typebox`
itself.
It is there only where pi runs in the portal's process (`portal.executor` is
`"host"`). `portal.chats.onEvent((chatId, event) => …)` hears everything a
chat's pi says, a tool call's arguments as they stream included, and what the
package's own pi extension sends its browser half arrives there as
`{ type: "portal_extension_ui", extension, data }`.

To follow a call of your tool as the model writes its arguments (Canvases
shows a document being written), ask `portal.chats.offers(chatId, tool)` how
the tool is offered first: a call by a name it is not offered under is refused
and never runs, so its text is nobody's. A call of a lazy tool comes as a call
of the `tools` tool, with yours in its arguments.

What the model is to be told of a tool goes in its description, or in pi's
`promptGuidelines`, in every turn while the tool is on. What only a spoken
turn needs (a long report goes in a document, and only a line of it is said)
goes in `voiceGuidelines`, which the portal adds to its voice rule while the
tool is on, once however many tools have the same line:

```js
pi.registerTool({ name: "canvas_write", /* … */ voiceGuidelines: ["Write the full report in a canvas and give only a brief spoken summary."] });
```

A tool that does something a person should choose to allow (Docker's tools
run containers on the portal's machine) is registered with
`offByDefault: true`. The first time the portal sees it, it is switched off by
default in Settings → Tools, and it is off in every chat, from the first
message of the first chat that has it, until somebody switches it on there or
by default. After that it is a default like any other: one switched on by
default stays on. It works for a tool of any package's pi extension too, in a
chat whose pi runs in the portal's own process (the host executor, where
`chats.extend` works); a chat run in a container of its own does not read it.

```js
pi.registerTool({ name: "docker_run", /* … */ offByDefault: true });
```

### Files a tool gives

A tool says it gave the person a file the same way whoever made it, the
portal or an extension, in a pi extension or a server half: its result's
`details` has `files`, each a path in the chat's folder, with a title if it
has one and the files it was made from (`from`) if it is a changed copy.

```js
return {
  content: [{ type: "text", text: "Plotted the sales: plots/sales.png" }],
  details: { files: [{ path: "plots/sales.png", title: "Sales by month" }] },
};
```

Everything else a tool answers is text. When the call ends, the portal looks
at each file's bytes, not its name: a PNG, JPEG, GIF or WebP is a picture, a
WebM or MP4 a clip, and any other file in the folder a file to save. One that
is not there, is outside the folder or is reached through a link out of it is
left out. What it found is on the end of the call, and everything goes by it:

- The chat draws them under the call's card: a picture, which opens in the
  [viewer](/guide/sessions#looking-at-a-picture), a clip in its player, and
  any other file as a link that saves it.
- The viewer steps through the pictures with the rest of the chat's, and one
  made `from` a picture shown before is tied to it.
- Voice mode's **Pictures** window shows the pictures.
- A [channel](/channels/writing-a-channel) sends pictures and clips on as they
  are given, and names any other file in the reply.

A picture in the agent's own words is not a file a call gave: one it writes in
Markdown loads only from the portal (a clip of the chat's, written the same
way, plays), and one from anywhere else is not fetched, so that a page the
agent read cannot have the browser send something somewhere else.

### Running things as the chat's agent

With the [sandbox](/guide/sandbox) on, each agent runs as a user of its own.
A server half runs as the portal. For what it does on a chat's behalf:

```js
const { code, stdout, stderr } = await portal.sandbox.run(chatId, ["git", "status", "--short"]);
// Or start a process yourself, as the chat's agent: `argv` goes before your command.
const { argv, env } = portal.sandbox.spawnAs(chatId);
const [command, ...args] = [...argv, "bash", "-il"];
const shell = spawn(command, args, { env, cwd: portal.chats.folder(chatId) });
```

`run` starts in the chat's folder and never throws for a command that fails.
With the sandbox off both are the portal's own user, and `argv` is empty.

### git in a chat's folder

A chat's folder is one its agent can write, and so is a repository in it: its
config can name a program for git to run (a filter, an fsmonitor hook, a
signature's gpg) that would run as the portal. `portal.git.at(folder)` runs
git as the portal runs its own: no prompt, editor or pager, no colour, and,
for a step that only reads, none of those programs and no index lock for the
agent's own `git add` to find held. A step that writes is git as someone would
type it in the folder, hooks and filters included. Two writes to one
repository at once trip over its lock, so queue your own (the Git extension
runs one at a time per repository).

```js
const repo = portal.git.at(portal.chats.folder(chatId));
const { stdout } = await repo.run(["status", "--porcelain=v2", "-z"]);
await repo.run(["commit", "-F", "-"], { input: message, writes: true });
const { stdout: pulls } = await repo.gh(["pr", "list", "--json", "number,title"]);
```

A step that fails rejects with an `Error` that has a `status`: 409 with git's
own words, 504 for one stopped for taking too long, 501 where git or gh is not
installed. `ok` lists exit codes that are answers rather than failures,
`timeout` and `max` bound a step (20 seconds for reading and three minutes for
writing; 16 MB of output). What reading turns off is looked up once for each
handle: make one for each request rather than keeping it.

### The host's processes

An extension that runs a shell or a job of its own finds, and ends, what that
started through `portal.proc` (Linux's `/proc`): `portal.proc.stat(pid)` is the
fields of `/proc/<pid>/stat` after the command's name (`[0]` the state, `[1]`
the parent, `[3]` the session), or `undefined` where there is no such process,
and `portal.proc.signalSession(session, signal)` signals every process of a
session and resolves with which they were. It reads `/proc` a batch at a time,
so a busy host does not hold up the portal's other work while it does.

### Building on another extension

An extension can give others something to build on, as a library does: a
Docker extension that runs containers, say, for the extensions that need one.
The one that gives it says what it gives with `portal.provide`, and those that
build on it name it in their package.json and ask for it with
`portal.extensions.use`.

```js
// pithagoras-docker: what each extension that builds on it gets, its own, by its name.
portal.provide((consumer) => dockerFor(consumer.name));
```

```json
{
  "name": "pithagoras-browser",
  "pithagoras": {
    "server": "./server.js",
    "requires": { "pithagoras-docker": "^1.0.0" }
  }
}
```

```js
// pithagoras-browser
const docker = portal.extensions.use("pithagoras-docker");
await docker.images.ensure("lscr.io/linuxserver/chromium:latest");
await docker.containers.create("pithagoras-browser", { Image: "lscr.io/linuxserver/chromium:latest" });
await docker.containers.start("pithagoras-browser");
```

[Docker for extensions](/guide/docker) is the one the portal ships.

- **`requires`**: the extensions it cannot work without, each with the versions
  it takes (a semver range). Without one of them, or with one in a version it
  does not take, it does not start, and Settings → Extensions says why ("It
  needs pithagoras-docker (^1.0.0), which is not installed, or is switched
  off"). Nothing is installed for it: the person installs what it needs.
- **`optional`**: the ones it uses when they are there. It starts without them,
  and `use` gives nothing then, or while one is there in a version it does not
  take.
- **Order.** An extension starts after all it builds on, and is stopped before
  them. When one it builds on is started anew (updated, switched off and on,
  installed or removed, for an optional one), so is it, after it: it never
  holds on to what a provider that is gone gave it. One that is not affected is
  left running.
- **Each its own.** The function given to `provide` is called once for each
  extension that asks, with its name, and what it returns is that one's alone:
  a provider keeps apart what each does with it. `use` gives the same thing each
  time it is asked.
- **What can go wrong** is said where the person looks: a provider that fails
  to start keeps those that require it from starting ("whose server half could
  not start"), and extensions that build on one another in a circle start none
  of them.
- `use` may only name an extension in `requires` or `optional`: the portal
  starts and restarts an extension by what it says it builds on.

This is for server halves. A provider's routes are its own, as any extension's
are: a page asks its own server half, which asks the provider.

## Panels and commands

`portal.panels` is the panels of the chat on screen, any of them, by name:
`isOpen(name)`, `open(name, params?)`, `close(name)`, which asks what the panel
asks before it is closed by hand (`guardClose`). `has(name)` says whether
there is a panel by that name at all, the portal's or an installed
extension's, and `useHas(name)` is the same as a hook, drawn again when an
extension comes or goes: Git offers "Open in Files" only where there is a
Files, which may be switched off or replaced. An extension's panel is
`<package>/<id>`, and also the `name` it gave itself, if any: that is how one
extension's panel takes the place of another's that went by the name. The
portal's own names are the portal's while those panels are its own. Of two
extensions that name a panel alike, the one first in the slot's order has the
name: a lower `order` first, then the one whose extension comes first in the
list of installed extensions. The portal's own are:

| Name | `open` takes |
| --- | --- |
| `agents` | `{ id }`: a subagent to show |
| `browser` | |

Extensions a fresh portal installs go by names too. Files is `files` and takes
`{ path }`, a file in the chat's folder to show. The terminal is `terminal`
and takes `{ callId }`, a command of the agent's to bring into view, or
`{ job }`, a background job to follow. Git is `git`, and Canvases `canvas`;
neither takes anything.

The `title` of a panel, a voice window or a page is drawn in the page's
language as your own `t` would say it: give its German in `locale.add`, and
mark it with a `msg()` of your own so that your texts' check finds it.

A command is something an extension says it can be asked to do, for another
extension or the portal to ask by name. Start the name with your package's.
Should two extensions say the same name, the one first in the list of installed
extensions answers to it, and the other does once that one is gone.

```js
portal.commands.register("my-files.reveal", (path) => portal.panels.open("my-files/files", { path }));
// Elsewhere, in another extension:
if (portal.commands.has("my-files.reveal")) portal.commands.run("my-files.reveal", "src/index.ts");
```

### What the portal asks of extensions

Where the portal has a click that belongs to an app, it runs a command by a
name any extension can register, and offers the click only while one does:

| Command | Given | Asked when |
| --- | --- | --- |
| `jobs.show` | `{ chat, job }`: the chat's id and the job's key | A job in the running tray above the message box is clicked |

While none does, a job in the tray is listed and opens nothing. The terminal
extension registers it, and shows the job on its Background tab.

## Keyboard shortcuts

A shortcut of your extension's is listed in Settings → Shortcuts with the
portal's own, under your package's name, and changed or reset there the same
way. There are two scopes. `"voice"` works while voice mode is on, except while
someone is typing. `"app"` works anywhere in the portal, on any page, whether or
not a chat is open; while someone types in a field a key alone is the field's, and one
with Ctrl, Alt or the Windows/Command key in it is the shortcut's. It is not run while a dialog is
open or for AltGr (Windows reports it as Ctrl+Alt, and some layouts type a character
with it). It is heard after the page's own parts: one that handled the key has it. They
are listed under "Anywhere in the portal".

```js
portal.shortcuts.register({
  id: "shell",
  label: "Show or hide the terminal",
  scope: "voice",
  default: { code: "KeyT" },
  run: ({ chat, windows }) => (windows.isOpen("shell") ? windows.close("shell") : windows.open("shell")),
});
```

`default` is a physical key (`KeyboardEvent.code`) with `ctrl`, `alt`, `shift`
or `meta`, or null for none. A key the portal or an extension before
yours in the list of installed extensions has already is not taken from it: your shortcut has none until someone
chooses one. A voice shortcut's `run` is given the chat on screen and your own voice windows by
their ids. It returns false when it had nothing to do, and the key goes on to
whatever else wants it. The label is translated as your other texts are
([Other languages](#other-languages)).

An `"app"` shortcut is given the key event and where it was pressed, so that it can
act only where it is meant to: an editor's save, run for the editor that has the focus.
When `run` does not return false the browser's own meaning of the key is taken, so
Ctrl+S does not also offer to save the page. Use the key of the platform for the default
(Command on a Mac, Ctrl elsewhere).

```js
const editors = new Set();   // the editors that are open, each with its element
portal.shortcuts.register({
  id: "save",
  label: "Save the document",
  scope: "app",
  default: { code: "KeyS", ...(/Mac/.test(navigator.platform) ? { meta: true } : { ctrl: true }) },
  run: ({ target }) => {
    const editor = [...editors].find((e) => e.element.contains(target));
    if (!editor) return false;   // not in one of ours: Ctrl+S is the browser's
    editor.save();
  },
});
```

## Other languages

English is what your code says, as it is for the portal. Add what each text is
in another language, and ask for a text with `portal.t`:

```js
portal.locale.add("de", { Notes: "Notizen", "Pin a note…": "Notiz anheften…", "{n} notes": "{n} Notizen" });

function Panel() {
  portal.locale.use();   // drawn again when the language changes
  return h("h3", null, portal.t("{n} notes", { n: 3 }));
}
```

A text you did not add falls back to the portal's own where it has it
("Loading…", "Remove"), and to what you wrote otherwise.

For a count, `portal.tp(n, one, other)` writes `{n}` the language's way and
picks the form; a language gives its forms under the English plural. Where
one English word means two things, `portal.tc(text, context)` tells them
apart, keyed as `text` and `context` with `\u0004` between them. And
`portal.tx(text, parts)` puts something drawn (a `<kbd>`, a link) where the
text has `{name}`:

```js
portal.locale.add("de", {
  "{n} commits": { one: "{n} Commit", other: "{n} Commits" },
  "Open\u0004state": "Offen",
  "Press {key} to send": "Mit {key} senden",
});
portal.tp(count, "{n} commit", "{n} commits");
portal.tc("Open", "state");
portal.tx("Press {key} to send", { key: h("kbd", null, "Enter") });
```

`portal.format.number(n)`, `.date(d)`, `.dateTime(d)` and `.time(d)` write
numbers and times as the page's language does. `.bytes(n)` writes a size
("1.5 MB"), and `.since(then, { dateAfterDays?, dateFormat? })` how long ago ("5m ago"):
of a date, a time in ms, or a timestamp the server wrote as text (UTC, with or without a zone marker), and the date
itself once it is more than `dateAfterDays` days ago.

## Themes

A theme is a set of colours in place of the portal's own, for dark, for light,
or for both. A package can be nothing else: name them in `package.json`, and
there is no code to write.

```json
{
  "name": "my-theme",
  "keywords": ["pi-package"],
  "pi": {},
  "pithagoras": {
    "themes": [
      {
        "id": "dusk",
        "name": "Dusk",
        "dark":  { "canvas": "#1b1626", "surface": "#241e33", "fg": "#f4f0fa", "accent": "#ff79c6", "terminal": "#15111e" },
        "light": { "canvas": "#faf7ff", "accent": "#a83282" }
      }
    ]
  }
}
```

Each colour goes by the portal's name for what it is for, and is written as
`"#rrggbb"` or as three numbers (`"27 22 38"`):

| | |
| --- | --- |
| `canvas`, `surface`, `raised` | The page; what sits on it; what sits on that |
| `line` | Borders and rules |
| `fg`, `fg-muted`, `fg-subtle`, `fg-faint` | Text, and its three quieter tones |
| `accent`, `accent-fg` | What is chosen or pressed, and text on it |
| `ok`, `warn`, `danger` | Done; careful; wrong |
| `terminal`, `terminal-fg` | A terminal's ground and its text. Dark in either mode unless a theme says otherwise |

What a theme does not say stays the portal's, so a theme can be one colour.
Keep text readable on what it sits on: the portal's own tones are each 4.5:1 or
better on every surface.

Installed, the theme is offered in **Settings → This browser → Appearance →
Colours**, beside Light, Dark and Match the system. The choice is kept in the
browser with its colours, so on the next load it is painted before the app and
long before any extension is loaded: there is no flash of the portal's own
colours first. When the package is removed or switched off, the portal's own
are back.

The browser half can do the same in code, and can be a theme changer: a
control of its own that switches the portal between themes, its own or any
other package's.

| `portal.theme.` | |
| --- | --- |
| `register({ id, name, dark?, light? })` | Adds a theme, like one named in `package.json` |
| `list()` | The themes there are: `{ id, name, extension }`, with `id` as `<package>/<id>` |
| `current()` | The theme in effect, or `null` for the portal's own colours |
| `set(id)` | Switches to a theme, or to the portal's own with `null` |
| `use()` | A hook: `{ mode, theme }`, light or dark and the theme in effect |

```js
portal.slots.register("chat.header.action", { id: "theme", component: () => {
  const { theme } = portal.theme.use();
  return h("button", { onClick: () => portal.theme.set(theme ? null : "my-theme/dusk") }, theme ? "Portal colours" : "Dusk");
} });
```

`extensions/themes` in the repository is the example of an extension that is
only themes: seven of them (Forest, Ocean, Rose, Amber, Mono, Dusk and Warm),
each a whole theme in the one `package.json`.

## What is loaded, and when

The portal loads the browser half, the server half and the themes of every
package that is installed in the portal and switched on. Installing, removing, updating or
switching one takes effect in the open page and in the server, without a
reload or a restart.

Of two installed packages that go by one name, the first is the one, whole.

The browser halves are loaded at the same time, so which one comes into the
page first is not something to rely on. Wherever the portal has to choose
between extensions (the order of their entries in a slot, which of two shortcuts
wanting one key has it, whose command answers to a name, the order of their
themes in the picker) it goes by the order of the list of installed extensions,
the same on every load.

A package that a chat's folder brings (`.pi/` in a project) never has either
half loaded. The agent can write that folder, and what it put there would run
in the page of everyone who opens the portal, or in the portal itself.

::: warning Both halves are trusted like the rest of the package
A browser half runs in the portal's own page, with the login of whoever is
looking, and can do what that person can. A server half runs in the portal's
process. That is no more than the package's pi extension can already do, but
it is one more reason to install packages you trust.
:::

A half that fails to load is left out, with the reason beside the package in
Settings → Extensions, and for a browser half on its page's address and in the
browser's console. A browser half has fifteen seconds to be fetched and
called, and the others do not wait for one that takes longer. It is tried
again the next time a package changes, and the themes its `package.json` names
are there to choose all the while. A component that fails to draw takes down its own panel or
page, and a server half's handler that throws is answered as an error; the
rest of the portal goes on.

### The extensions a portal starts with

The extensions in the portal's own `extensions/` folder are packages like any
other. `extensions/defaults.json` names those a portal starts with: each is
installed once, as Discover installs one, and is an installed package from then
on, switched off or removed the same way. One removed stays removed, and one
already installed under its name, from anywhere, is left as it is, so your own
can take its place. A portal that is updated installs what the list adds, once.

Nothing in the portal's own code imports them, and none of them imports the
portal's code: `npm run check:boundaries` holds that line, and CI runs it.
What they need of the portal they get the way your extension does, through
the `portal` they are given.

Each keeps its tests beside its code, in `test/`, so removing its folder takes
them with it, and the image leaves them out:

- `test/*.test.mts`: unit and server tests, run by the portal's `npm test`;
- `test/browser/*.spec.mts`: browser specs, run by Playwright with the
  portal's own;
- `test/browser/<page>.page.tsx`: a page of its own for those specs, served by
  the portal's dev server at `/tests/extension.html?page=<folder>/<page>`.

A test may reach into the portal's code and its test helpers
(`tests/helpers.mts`, `tests/browser/portal-mock.ts`); the extension's own code
may not. A browser spec says what the portal has installed, which is nothing
unless it does: `test.use({ installed: ['extensions/git'] })`, by folder from
the repository's root. The portal's own specs never install one of these: where
they need an extension's panel or window, they install a stand-in,
`tests/fixtures/extensions/console`, so that any extension that comes with the
portal can be removed without a spec of the portal's failing.

### Testing a server half

`@pithagoras/extension-api/testing` gives a test a portal to call a server half with, so that its routes, tools and
pushes are tried without the portal's own code in the test:

```js
import { mockPortal, scratch } from "@pithagoras/extension-api/testing";
import serverHalf from "../server.js";

const mock = await mockPortal({ extension: "my-notes", chats: { a: scratch() } });   // chat "a" works in a new folder
await mock.start(serverHalf);                 // your default export, called with the mock's portal
const web = await mock.serve();               // its routes, on a port of their own
const { status, body } = await web.call("GET", "/chats/a/notes");
const page = mock.page();                     // a page that listens to topics
await page.listen("notes");
await mock.stop();
```

What your half relies on for its safety is the portal's own, not made up: `portal.files`, `portal.proc`,
`portal.sqlite` and the hub that carries `portal.push` to the pages. What happens with the agent is faked in the smallest
way an extension needs: a chat's pi (`mock.pi(chat)`) keeps the tools and messages it is given, `chats.followUp` answers as
the portal's does (it resolves `true` once the message is handed to pi, `false` when `executor` is not `"host"`, and a pi that
refuses the message shows as a `portal_failed` event, which `chats.onEvent` hears), and the options `tell`, `followUp` and
`sendThrows` steer what a chat's pi answers.

It stands on the portal's source, so it needs a checkout of the portal: `mockPortal()` finds `core/server` beside the
package, and says so when it is not there. That is where the extensions that come with the portal are. An extension
developed on its own, with the package from npm, cannot use it, and tests its server half with a mock of its own.

## Keeping it fast

- Say what you use of the chat: `portal.chats.use(chat.id, pick)`.
- Keep what the server half tells you in the module, not in a component, and
  have components read it from there.
- Load what is heavy when it is first needed: `import("./editor.js")` from
  your web folder.
- A status your pi extension refreshes on a timer does not keep the chat's
  agent up, and neither does what it sends its browser half. Hold the agent
  only while work is going on, with `portal.chats.hold`.

## What the portal's own apps use

The terminal, Git, Files and Canvases are extensions (`extensions/terminal`,
`extensions/git`, `extensions/files`, `extensions/canvas`). This is what each
of them takes from the portal, and what gives the same to an extension:

| The portal's app uses | An extension has |
| --- | --- |
| Routes that work with no agent running: listing, saving, renaming, deleting, downloads | `portal.router`, `chats.folder`, and [`portal.files`](#a-chat-s-folder) for the folder itself |
| Uploads and pictures | The portal's own routes for them (`/api/sessions/:id/upload`, `/picture`), which its message box and conversation use too |
| A shell and its stream, ended with the login it was opened under; cleanup when a chat goes | The server half, `http.upgrade` or a stream route, `http.endWithLogin`, `sandbox.personEnv`, `chats.on("deleted")` |
| What the agent read, wrote and ran, as it happens | `portal.chats.use(chat.id, pick)` |
| Tools that write to what the pages show (canvases, pictures) | `chats.extend`, `chats.send`, `chats.onOpen`, `chats.onEvent` |
| Tabs and a count in a panel's head, a fullscreen button | `header`, `actions`, `panel.state` |
| A button only when there is something to open, with a dot while it runs | `useButton` |
| "Discard your changes?", and staying open when a third panel opens | `panel.guardClose`, `panel.keep` |
| One panel asking another to show a file, and staying open beside it | `panel.open("files", { path })`, `portal.commands` |
| "Open in Files" only where there is a Files | `portal.panels.useHas("files")` |
| A window in voice mode that shows the file of the card that was tapped | `opened` given to its `voice.window`, `opensFor(call, chat)` |
| Its name in the page's language | `title` with `msg()`, and `locale.add` |
| git and gh in a chat's folder, safely, with a write at a time | `portal.git.at(folder)` |
| Find and end the processes of a shell or a job you started | `portal.proc` |
| What changed in the history it shows, counted and dated in the page's language | `portal.tp`, `portal.tc`, `portal.tx`, `portal.format` |
| Its components styled with the portal's utilities | `buildExtension` with `tailwind: true` |
| A card of its own for its tool in the conversation | `chat.tool` |
| A window over the chat; chips above the message box | `chat.overlay`, `chat.composer.above` |
| Opening itself when the agent makes something | `chat.background` |
| A window in voice mode, at the side, opening itself when the agent runs a command and when its card is tapped | `voice.window` with `place`, `useAutoOpen`, `opensFor` |
| A document written live as the model writes the call, only for a call that will run | `chats.onEvent`, `chats.offers` |
| A document drawn as the model writes the call, before the tool runs and saves it | `calls` and `call(callId)` in `portal.chats.use` |
| Its tools' cards in voice mode saying what they do, and its tools telling a spoken turn to keep it short | `describe` on its `voice.window`; `voiceGuidelines` on its tools |
| "Delete this document?" only for someone who wants to be asked | `ui.asksBeforeDeleting()` |
| "Open in the agent terminal" on the card of a shell call | `chat.tool.action` |
| A key in voice mode (T for the terminal); a key anywhere in the portal (Ctrl+S in an editor) | `portal.shortcuts.register` with scope `"voice"` or `"app"` |
| Being opened by name from anywhere (`terminal`) | `name` on its `chat.panel` |
| The running tray's jobs opening its Jobs tab, and the jobs themselves | The `jobs.show` command; `background` in `portal.chats.use` |
| An emulator fetched only when its tab is opened | `ui.lazy` |
| A page in the sidebar; a page in Settings | `nav.page`, `settings.page` |
| A window in voice mode that can fill the stage, with a page in it that is not loaded again each time | `maximizable`, `keepLoaded` and `restore()` on its `voice.window` |
| A page in the sidebar only once its service is set up | `useShown` on its `nav.page` |
| A slash command | `pi.registerCommand` in the pi extension, and the channel for what it does in the page |
| The colours of everything | [A theme](#themes) |

## The example

`tests/fixtures/extensions/notes` uses most of this in three small files:

- `index.ts`, the pi extension: a `note` tool, and the notes kept with the
  conversation.
- `web/client.js`, the browser half: a panel with tabs in its head that asks
  before discarding a note being written, a header button that pins the
  agent's last reply, its own card for a call of `note`, a window in voice
  mode, a page of every chat's notes, a command, and its texts in German.
- `server.js`, the server half: a copy of each chat's notes in the chat's
  folder, a route that answers for all chats, and the count each page is told.

It is the portal's test extension and is not shipped: copy it to start your
own, and install your copy by its path. What the portal ships is in
`extensions/`, under **Settings → Extensions → Discover → Comes with
Pithagoras**: `extensions/themes` is an extension
that is only themes, and `extensions/docs` is a large one: a page in the
sidebar, fed by its server half's routes, a stream that tells the page of
changes, an editor built into the page, and tools for the agent that share the
server half's store ([Documents](/guide/documents), whose last section says how
it is built). Its texts are in German through `portal.locale.add`, and the
portal's tests hold it to every text it shows.

`extensions/terminal`, the [terminal](/guide/terminal) a fresh portal installs,
is the one written in TypeScript and JSX:

- `src/client.tsx` registers a panel by the name `terminal` with tabs in its
  head and a dot on them while something runs, a window in voice mode that
  asks for the side and opens on each command, an action on a shell call's
  card, a voice shortcut, and the `jobs.show` command.
- `src/AgentTerminal.tsx` and `src/Jobs.tsx` read the chat with
  `portal.chats.use`; `src/Shell.tsx` is the emulator, in a chunk of its own
  loaded with `ui.lazy`.
- `server.js` is its shell: routes, a stream ended with the login, and a
  stopper that ends every shell as the portal stops.
- `src/de.ts` is its German, which the portal's tests hold to every text it
  shows.

`extensions/git`, the [Git](/guide/git) panel, is a larger one:

- `src/client.tsx` registers a panel by the name `git`, with its tabs and the
  count of changed files in its head (`panel.state`), and opens a file in
  Files with `panel.open`. It looks again when the agent wrote a file or its
  turn ended, from `portal.chats.use`.
- `src/panel/` is the panel, styled with Tailwind utilities its build makes
  into its own stylesheet.
- `src/server.ts` is its routes, keyed by chat, and `src/git.ts` what each
  runs, through `portal.git.at`.
