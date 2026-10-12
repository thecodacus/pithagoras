# Extensions that draw in the portal

A pi package can bring an interface of its own to the portal: a panel beside a
conversation, a control in a chat's header, a page in the sidebar. It is still
an ordinary pi package, installed and switched like any other
([Extensions](/guide/extensions)), and outside the portal it works as it always
did.

Such a package has two halves:

| Half | Runs | Does |
| --- | --- | --- |
| The pi extension | Inside pi, one per chat | Tools, commands, events, the state it keeps with the conversation |
| The browser half | Inside the portal's page | Draws, in the portal's **slots** |

## The package

`package.json` names the browser half under a key of the portal's own, beside
what pi reads:

```json
{
  "name": "my-extension",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] },
  "pithagoras": { "client": "./web/client.js", "style": "./web/client.css" }
}
```

```
my-extension/
├── package.json
├── index.ts          the pi extension
└── web/
    ├── client.js     the browser half
    └── client.css    its stylesheet (optional)
```

`client` is a JavaScript module. The folder it is in is the package's web
folder: the portal serves that folder, and nothing else of the package, to
whoever is signed in. So the module has a folder of its own; one at the
package's root is not loaded. `style`, in the same folder, is loaded with it.
Pictures and further modules in the folder are fetched by addresses relative
to the module (`new URL("./logo.svg", import.meta.url)`).

The module is loaded as it is, so it is what a browser runs: plain JavaScript,
or the output of your own build.

## The browser half

Its default export is called once, with the portal:

```js
export default function (portal) {
  const { React } = portal;
  const h = React.createElement;

  function Notes({ chat, channel }) {
    const [notes, setNotes] = React.useState([]);
    React.useEffect(() => {
      const off = channel.on((data) => data.type === "notes" && setNotes(data.notes));
      channel.send({ type: "ready" });
      return off;
    }, [channel]);
    return h("ul", null, notes.map((note) => h("li", { key: note.id }, note.text)));
  }

  portal.slots.register("chat.panel", { id: "notes", title: "Notes", component: Notes });
}
```

| `portal.` | |
| --- | --- |
| `React` | The portal's own React. Components drawn in a slot are made with it, so that their hooks work. With a build, point its JSX at `portal.React.createElement` |
| `slots.register(slot, entry)` | Puts an entry into a slot. Returns a function that takes it out again |
| `navigate(path)` | Goes to a page of the portal: `/s/<chat id>`, `/x/<package>/<page id>` |
| `extension` | The package's name |
| `version` | Of this interface: `1` |

The function may return another, which is called when the extension is taken
out of the page. What it registered goes with it either way.

## Slots

A slot is a place in the portal with a name. Every entry needs an `id`, which
names it among your package's entries in that slot, and a `component`. `order`
puts it before entries with a higher one, or none.

| Slot | Where | Entry | The component is given |
| --- | --- | --- | --- |
| `chat.panel` | Beside the conversation. Its button is in the chat's header, and it docks, floats and resizes like Files and Git | `title`, `icon?` | `chat`, `channel`, `close()` |
| `chat.header.action` | In the chat's header, before the panels' buttons | | `chat`, `channel`, `panels` |
| `nav.page` | A page at `/x/<package>/<id>`, with an entry in the sidebar | `title`, `icon?` | |

`chat` is `{ id, title, workspace }`. `panels` is your package's own panels in
that chat: `isOpen(id)`, `open(id)`, `close(id)`. `icon` is a component that
draws an `<svg>`.

A component in a chat is made anew for each chat, so its state is that chat's.
Two panels fit beside a conversation: a third closes the one open longest,
whoever brought it.

The page's colours are variables holding the three numbers of a colour:
`rgb(var(--fg))`, and likewise `--canvas`, `--surface`, `--raised`, `--line`,
`--fg-muted`, `--fg-subtle`, `--fg-faint`, `--accent`, `--accent-fg`, `--ok`,
`--warn` and `--danger`. A stylesheet written with them follows the theme.
Give your class names a prefix of your own: the stylesheet is the page's.

## Talking to the pi extension

What is drawn in a chat has a `channel` to the package's own pi extension in
that chat. On the pi side it is pi's event bus (`pi.events`), so the extension
needs no dependency on the portal, and outside it nobody is listening.

| Channel | Direction | Payload |
| --- | --- | --- |
| `pithagoras:v1:ui:send` | extension → its browser half | `{ extension, data }` |
| `pithagoras:v1:ui:receive` | browser half → extension | `{ extension, data }` |

`extension` is the package's name; every extension in a chat shares the bus,
so take only what carries yours. `data` is yours to define, and anything that
is JSON.

```ts
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

Nothing sent either way is stored, and what the extension sends reaches only
the pages open on the chat just then. So a component asks where things stand
when it is drawn (the `ready` above), and the extension keeps its state where
pi keeps a conversation's: `pi.appendEntry()` for what the model should not
see, a tool result's `details` for what follows the branch.

A chat left alone for a while has its agent let go
([When a chat's agent is let go](/guide/extensions#when-a-chat-s-agent-is-let-go)).
`channel.send` starts it again, so a panel opened on such a chat reaches its
extension after a moment. What an extension sends on its own clock does not
count as use of the chat. `channel.send` rejects where the chat's agent does
not run its extensions inside the portal, which is every executor but
`EXECUTOR=host`.

A page outside a chat has no pi extension to ask. It can call the portal's own
[API](/reference/api), with the login of whoever is looking.

## What is loaded, and when

The portal loads the browser half of every package that is installed in the
portal and switched on. Installing, removing, updating or switching one in
Settings takes effect in the open page, without a reload.

A package that a chat's folder brings (`.pi/` in a project) never has its
browser half loaded. The agent can write that folder, and what it put there
would run in the page of everyone who opens the portal.

::: warning A browser half is trusted like the rest of the package
It runs in the portal's own page, with the login of whoever is looking, and
can do what that person can. That is no more than the package's pi extension
can already do on the server, but it is one more reason to install packages
you trust.
:::

An extension that fails to load is left out, with the reason beside it in
Settings → Extensions, on its page's address and in the browser's console. A
component that fails to draw takes down its own panel or page, and the rest of
the portal stays.

## The example

`extensions/notes` in this repository is a complete one: a `note` tool the
agent pins notes with, a Notes panel that lists them and takes your own, a
header button that pins the agent's last reply, and a page. Its browser half is
plain JavaScript with nothing to build. Install it from Settings → Extensions
by its path (in the image, `/app/extensions/notes`).

Voice mode draws its own windows and does not show extensions' panels yet.
