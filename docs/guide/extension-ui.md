# Building an extension

An extension is an ordinary pi package that also brings something to the
portal: a panel beside a conversation, a page in the sidebar, routes of its
own on the server, tools for the agent that share what those routes know, a
theme. It is installed, switched and removed like any other package
([Extensions](/guide/extensions)), and it is loaded as it is: nothing of it is
compiled into the portal.

This page takes you from an empty folder to a working extension, then lists
everything the portal hands one. `extensions/notes` in the repository is the
complete example the snippets here are taken from.

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
means `React.createElement`, as above. With a build of your own, write JSX and
point it at the portal's React instead of bundling a second one: mark `react`
as external and have your bundler alias it to a small module that hands out
what `portal.React` holds. Two Reacts in one page do not share hooks.

The portal wraps each component so that it is drawn again only when what it is
handed changes. The chat around it is drawn again with every token of a reply;
your panel is not, unless it [asks for something that changed](#the-chat-s-events).

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
| `storage.local`, `storage.session` | The browser's storage, which never throws |
| `useFollowBottom`, `useNow`, `tabKeys` | A box that follows its end; the time, each second; arrow keys for a row of tabs |

The portal's utility classes (Tailwind) exist only for what the portal itself
uses, so do not rely on one being there: style your own markup in your own
stylesheet.

## Slots

A slot is a place in the portal with a name. Every entry has an `id`, which
names it among your package's entries in that slot, and a `component`. `order`
puts it before entries with a higher one, or none.

| Slot | Where | Entry | The component is given |
| --- | --- | --- | --- |
| `chat.panel` | Beside the conversation, docked, floated and sized like Files and Git | `title`, `icon?`, `header?`, `actions?`, `useButton?` | `chat`, `channel`, `panels`, `close()`, `panel` |
| `chat.header.action` | The chat's header, before the panels' buttons | | `chat`, `channel`, `panels` |
| `chat.tool` | A call of one tool in the conversation, in place of the portal's card | `tool` (its name) | `chat`, `channel`, `panels`, `call`, `card` |
| `chat.composer.above` | Above the message box | | `chat`, `channel`, `panels` |
| `chat.overlay` | Over the chat, placed by you | | `chat`, `channel`, `panels` |
| `chat.background` | Nowhere: there while the chat is on screen, drawing nothing | | `chat`, `channel`, `panels` |
| `voice.window` | A window in voice mode, placed and sized like the portal's own | `title`, `icon?` | `chat`, `channel`, `panels`, `close()` |
| `nav.page` | A page at `/x/<package>/<id>`, with an entry in the sidebar | `title`, `icon?` | |
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

`call` is `{ name, callId, status, input, output, details }`: what the tool
was called with, what it has returned so far as text, and its result's
`details`. `card` is the portal's own card for the call, to return as it is or
to draw beside something of your own.

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
| `running` | The agent is at work |
| `loading` | The conversation is still being fetched |

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
| `chats.get(id)`, `chats.list()` | A chat: `{ id, title, workspace, status }` |
| `chats.folder(id)` | The folder the chat's pi works in, on this disk |
| `chats.send(chatId, data)`, `chats.onOpen(fn)` | [Telling the pages open on a chat](#telling-the-pages-open-on-a-chat) |
| `chats.on("started" \| "stopped" \| "deleted", fn)` | A chat's pi started or stopped; the chat was deleted |
| `chats.onEvent(fn)` | Everything a chat's pi says, as it says it |
| `chats.tell(chatId, data)` | To the package's own pi extension in a chat (`pithagoras:v1:ui:receive`) |
| `chats.extend(factory)` | [Tools that share this module's state](#tools-that-share-the-server-half-s-state) |
| `chats.hold(chatId)` | Keeps the chat's pi from being let go for being idle, or reloaded, while work goes on; returns what lets it go |
| `sandbox.run(chatId, argv, options?)`, `sandbox.spawnAs(chatId)`, `sandbox.on()` | [Running things as the chat's agent](#running-things-as-the-chat-s-agent) |
| `files.inside(base, rel)` | A path checked to be inside a folder |
| `dataDir()` | [A folder of the package's own in the portal's data folder](#where-it-keeps-things), closed to everyone but the portal |
| `log(text)`, `extension`, `executor`, `version` | A line in the portal's log; the package's name; how pi is run here; `1` |

### Routes

```js
portal.router.get("/chats/:id/files", (req, res) => {
  const folder = portal.chats.folder(req.params.id);
  const dir = portal.files.inside(folder, String(req.query.path ?? "."));
  res.json({ entries: readdirSync(dir) });
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
a name of your own, and check every path that came from outside with
`portal.files.inside`.

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
A server half is plain Node, though: what it imports is its own package's
dependencies, not what pi lends its extensions. So a tool's parameters are
written as a JSON schema, as above, unless the package depends on `typebox`
itself.
It is there only where pi runs in the portal's process (`portal.executor` is
`"host"`). `portal.chats.onEvent((chatId, event) => …)` hears everything a
chat's pi says, a tool call's arguments as they stream included, and what the
package's own pi extension sends its browser half arrives there as
`{ type: "portal_extension_ui", extension, data }`.

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

## Panels and commands

`portal.panels` is the panels of the chat on screen, any of them, by name:
`isOpen(name)`, `open(name, params?)`, `close(name)`. An extension's panel is
`<package>/<id>`. The portal's own are:

| Name | `open` takes |
| --- | --- |
| `files` | `{ path }`: a file to show |
| `terminal` | `{ callId }`: a shell call to scroll to |
| `agents` | `{ id }`: a subagent to show |
| `git`, `browser`, `canvas` | |

A command is something an extension says it can be asked to do, for another
extension or the portal to ask by name. Start the name with your package's.

```js
portal.commands.register("my-files.reveal", (path) => portal.panels.open("my-files/files", { path }));
// Elsewhere, in another extension:
if (portal.commands.has("my-files.reveal")) portal.commands.run("my-files.reveal", "src/index.ts");
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

## Themes

A theme is a set of colours in place of the portal's own, for dark, for light,
or for both. A package can be nothing else: name them in `package.json`, and
there is no code to write.

```json
{
  "name": "my-theme",
  "keywords": ["pi-package"],
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

The portal's Files, Terminal, Git and Canvases are written into it today. This
is what each of them takes from the portal, and what gives the same to an
extension:

| The portal's app uses | An extension has |
| --- | --- |
| Routes that work with no agent running: listing, saving, uploads, downloads | `portal.router`, `chats.folder`, `files.inside` |
| A shell and its stream; cleanup when a chat goes | The server half, `http.upgrade` or a stream route, `chats.on("deleted")` |
| What the agent read, wrote and ran, as it happens | `portal.chats.use(chat.id, pick)` |
| Tools that write to what the pages show (canvases, pictures) | `chats.extend`, `chats.send`, `chats.onOpen`, `chats.onEvent` |
| Tabs and a count in a panel's head, a fullscreen button | `header`, `actions`, `panel.state` |
| A button only when there is something to open, with a dot while it runs | `useButton` |
| "Discard your changes?", and staying open when a third panel opens | `panel.guardClose`, `panel.keep` |
| One panel asking another to show a file | `portal.panels.open("files", { path })`, `portal.commands` |
| A card of its own for its tool in the conversation | `chat.tool` |
| A window over the chat; chips above the message box | `chat.overlay`, `chat.composer.above` |
| Opening itself when the agent makes something | `chat.background` |
| A window in voice mode | `voice.window` |
| A page in the sidebar; a page in Settings | `nav.page`, `settings.page` |
| A slash command | `pi.registerCommand` in the pi extension, and the channel for what it does in the page |
| The colours of everything | [A theme](#themes) |

## The example

`extensions/notes` in the repository uses most of this in three small files:

- `index.ts`, the pi extension: a `note` tool, and the notes kept with the
  conversation.
- `web/client.js`, the browser half: a panel with tabs in its head that asks
  before discarding a note being written, a header button that pins the
  agent's last reply, its own card for a call of `note`, a window in voice
  mode, a page of every chat's notes, a command, and its texts in German.
- `server.js`, the server half: a copy of each chat's notes in the chat's
  folder, a route that answers for all chats, and the count each page is told.

Install it from **Settings → Extensions → Discover**, where it is listed under
**Comes with Pithagoras**. `extensions/theme-dusk` and `extensions/theme-warm`
beside it are extensions that are only a theme, and are listed there too.
`extensions/docs` is a larger one that is still being built: a page in the
sidebar, fed by its server half's routes ([Documents](/guide/documents)).
