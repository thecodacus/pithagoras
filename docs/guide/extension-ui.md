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
| `panels` | [Any panel of the chat on screen](#panels-and-commands), by name |
| `commands` | [What can be asked of an extension by name](#panels-and-commands) |
| `api.json(url, init?)` | A request as the portal's own are made |
| `api.url(path)` | The address of a route of the package's [server half](#the-server-half) |
| `server.on(handler)` | What the server half [says to this page](#telling-the-pages-open-on-a-chat) |
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
| `Select`, `Switch`, `SwitchRow`, `Segments`, `Field` | Controls and their labels |
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
entries of every extension are together in one group, **Extensions**, below
the portal's own pages: it folds like a folder, is remembered per browser, and
is held open while one of its pages is showing. On the folded sidebar the group
is one puzzle button that opens a menu of the pages. With no page, there is
neither. `useShown()` is a hook, called as the sidebar is drawn:
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
| `chats.extend(factory)` | [Tools that share this module's state](#tools-that-share-the-server-half-s-state) |
| `chats.offers(chatId, tool)` | How the chat's model is offered a tool now: `"direct"`, `"lazy"` (through the `tools` tool) or nothing (switched off, out of reach, or the chat's pi not running here) |
| `chats.hold(chatId)` | Keeps the chat's pi from being let go for being idle, or reloaded, while work goes on; returns what lets it go |
| `sandbox.run(chatId, argv, options?)`, `sandbox.spawnAs(chatId)`, `sandbox.on()` | [Running things as the chat's agent](#running-things-as-the-chat-s-agent) |
| `sandbox.personEnv()` | The portal's environment for a process the person starts, such as a shell of their own: without the mark the agent's processes carry, so it is not listed as a job the agent left running |
| `files.inside(base, rel)` | A path checked to be inside a folder |
| `files.list`, `read`, `write`, `rename`, `unsaved`, `remove`, `makeFolder`, `folder`, `open` | [A chat's folder](#a-chat-s-folder), read and changed with the portal's own checks |
| `git.at(folder)` | [git and gh in a folder](#git-in-a-chat-s-folder), run as the portal runs its own |
| `dataDir()` | [A folder of the package's own in the portal's data folder](#where-it-keeps-things), closed to everyone but the portal |
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
// So a route can take a file as it comes, of any size.
portal.router.post("/chats/:id/upload", (req, res) => req.pipe(createWriteStream(target)).on("finish", () => res.json({ ok: true })));
```

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
  where the file was. A file is opened without following a link in its last
  place (`O_NOFOLLOW`), and what is sent is read from what was opened, never by
  opening the path again. A pipe left there does not hold the server, and a
  device is not read.
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
  a question that names it.
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

What reads a whole folder, such as an archive, takes it from `files.folder`,
checked; a download is sent from the descriptor `files.open` gives. Files'
server half (`extensions/files/src/server.ts`) is a complete example.

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
name: a lower `order` first, then the one loaded first. The portal's own are:

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
way. Voice-mode shortcuts work while voice mode is on, except while someone is
typing.

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
or `meta`, or null for none. A key the portal or an extension loaded before
yours has already is not taken from it: your shortcut has none until someone
chooses one. `run` is given the chat on screen and your own voice windows by
their ids. It returns false when it had nothing to do, and the key goes on to
whatever else wants it. The label is translated as your other texts are
([Other languages](#other-languages)).

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
numbers and times as the page's language does.

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

`extensions/theme-dusk` and `extensions/theme-warm` in the repository are each
a whole theme in one `package.json`.

## What is loaded, and when

The portal loads the browser half, the server half and the themes of every
package that is installed in the portal and switched on. Installing, removing, updating or
switching one takes effect in the open page and in the server, without a
reload or a restart.

Of two installed packages that go by one name, the first is the one, whole.

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
| A key in voice mode (T for the terminal) | `portal.shortcuts.register` |
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
Pithagoras**: `extensions/theme-dusk` and `extensions/theme-warm` are extensions
that are only a theme, and `extensions/docs` is a large one: a page in the
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
