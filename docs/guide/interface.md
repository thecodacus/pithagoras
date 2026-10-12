# The interface

What the portal does in the browser, apart from the chat itself. Everything on
this page is kept **in this browser** — the theme, the animations, the language,
the confirmations, the shortcuts — so a phone and a laptop can differ without one
changing the other. The exception is the tools switched off by default, which
the server keeps.

## Install it as an app

The portal is a progressive web app. Chrome, Edge and Safari offer **Install**
(or **Add to Home Screen**) in the address bar or share menu, and it then opens
in its own window with no browser chrome. The app's title bar follows the
portal's theme, and its icon offers **Sessions** and **Projects** as shortcuts.

Browsers install an app only over **HTTPS or on `localhost`**. Behind
Tailscale, `tailscale serve` gives the portal a certificate; over plain
`http://` on a LAN address the browser will not offer it.

When the server is out of reach — restarting, or the phone is off the VPN — the
installed app still opens, from the last page the server gave, and says the
server cannot be reached, as a tab does. Nothing the agent does is cached: the
API and the agent's browser view always go to the server. A deploy shows up on
the next load rather than the one after.

When the portal does not answer as the page loads — it is restarting during an
upgrade, say — the page says **Cannot reach the portal** and asks again by
itself, with a **Try again** button for impatience. It does not fall back to the
password form: your login is still good, and only a portal that says you are not
signed in shows that.

## Theme

**Settings → This browser → Theme** is light, dark or **System**, the default,
which follows the machine and changes with it — at sunset, on a desktop that
flips.

In both themes even the quietest text — hints, timestamps, placeholders — keeps a
contrast of at least 4.5:1 against what it is drawn on, and the keyboard focus is
a 2px outline in the full accent colour, round fields, checkboxes, dropdowns and
buttons alike.

## Animations

The portal has always moved a little: panels slide in, menus unroll, a working
chat's mark breathes. On top of that sits a layer of larger flourishes, **on by
default**:

- **Opening the portal.** Its mark lights up and two doors part on it. About a
  second, and only when you open the portal — not when you reload the page.
- **Chats.** Opening or switching to one lets the conversation you leave drift
  away and the last messages of the next swing in one after another, with its
  name sliding in. A chat that was deleted dissolves.
- **Messages.** What you send rises from the send button's corner as the arrow on
  it flies off; what the agent answers and runs rises in; something that went
  wrong shakes once.
- **Deleting.** A chat's row, in the sidebar and on **Sessions**, flashes red and
  breaks apart while the rows below close the gap; a deleted message and the
  reply to it do the same in the conversation. A new chat's row slides in, and a
  chat that moves up the list, or is pinned, slides to its new place.
- **Panels.** They come in from the side they are docked at with a bounce, drop
  away when closed, and a panel carried to another place flies there from where
  you let go of it.
- **Dialogs, menus and lists.** A dialog swings up out of the page and sinks
  when it closes, and so does the picture viewer; a menu unrolls from its button, its lines one after another;
  a drop-down list does the same.
- **Settings.** The side navigation comes in line by line, the page you pick
  slides in, and a switch's knob bounces.
- **The Browser page.** Its screen switches on like an old tube.
- **Voice mode.** The orb comes up out of a swell of light, and the windows that
  open on its stage overshoot into place.
- **Pictures being made.** While the agent has a picture made or changed, a soft
  light drifts over the frame that holds its place and a sheen passes; the
  picture then fades in over it. See [Sessions](/guide/sessions#pictures-the-agent-makes).

None of it waits for you or takes a click away: what is leaving is a picture of
what was there, laid over the page, while the page itself is already as it
will be. Nothing moves on a keystroke or as the agent's words stream in.

**Settings → This browser → Animations** switches all of this off. It is kept in
this browser, like the theme, so a phone and a laptop can differ. Off, the portal
is as it was before the flourishes were added.

If your system asks for **reduced motion** (the *prefers-reduced-motion* setting),
the flourishes do not play, whatever the switch says, and the portal's own
quieter motion steps aside as well. The switch says so while that is the case.

## Language

English and German. See [Settings → Language](/guide/settings#language).

## Phone and narrow windows

On a phone the sidebar's rail gives way to a compact layout with larger
touch targets. The same pages and settings are there; nothing is left out.
The navigation opens as a drawer over the page; Esc closes it, and a window
widened past the phone layout closes it too.

On a wide screen the chat's panels — the browser, the terminal, Files, Git,
canvases — dock beside the conversation, each on its own side. See
[Files](/guide/files#panels) and [Session canvases](/guide/canvases).

## Confirmations

Deleting a session, a project, a routine and the like asks first, and so does removing an MCP server or an extension. **Settings →
This browser → Confirmations → Ask before deleting** turns the question off.
It is kept per browser deliberately: a phone that trips over a delete button is
not made safer by the laptop having turned the question off.

Closing a dialog with something typed in that is not saved yet — a skill you
rewrote, a provider (its key, its models and their windows), project, MCP server
or channel you are setting up, a person's notes, a project's instructions, a
pasted config, pi's `settings.json` under Advanced, an extension's setting, an
add-on's form (voice, a voice you are adding, image generation, memory), the
avatar — asks **Discard your changes?** first, whether you press Esc, click
beside the dialog or use its close button. That question is always asked:
nothing else holds a copy of a draft. A field that says it is saved when you
leave it, such as the default context window, is saved by every one of those
ways out, Esc included. A dialog's own **Cancel** button is an answer already,
and closes it without asking.

## Notifications

See [Settings](/guide/settings#defaults). They need HTTPS or
`localhost`.

## Tools

Every tool an extension, an MCP server or pi itself offers can be switched off,
in two places:

- **Settings → Tools** sets what **every** conversation starts with. A tool
  switched off there is not offered to the model at all; the extension stays
  installed and its slash commands keep working. Tools are listed once a
  conversation has run, because that is when pi builds the list of what its
  extensions registered. The portal's own `generate_image` and `edit_image` are the exception:
  they are listed as soon as image generation or editing is switched on. A group
  can be switched off as a whole, and each package can be given a name of your own — *Rename* — for the list. The
  portal's picture tools (`show_image`, `generate_image` and `edit_image`) share
  one group, **Images**, in every tool list; an extension's tool of one of those
  names stays in the group of its extension.
- **Projects → Tools** on a project's row sets what every chat in that project starts
  with, against the portal-wide default; see [Projects](/guide/projects#tools).
- **Tools** on an agent's page sets what every chat in its home and every run it does on
  its own starts with ([Agents](/guide/agents#tools)), and **Tools** on a routine's page
  what every run of it starts with ([Routines](/guide/routines#tools)).
- The **tools** control of a chat switches them for that chat only, from its
  next message. It is there before the first message too, so a tool can be
  kept away from a chat from the start.

A deployment that cannot switch tools (`EXECUTOR=container`) says so in place of
the list. A portal that did not answer is not taken for that: the list says it
could not be read and offers **Try again**, and a switch the portal did not save
snaps back with the reason beside it.

Both are safety tools as much as convenience: a browser or shell tool that a
chat has no business with is simply not there to be talked into. An MCP server is a
group like any other, switched whole or tool by tool; a tool switched off is not
reachable through the adapter's `mcp` tool either, and one the MCP configuration
leaves out is not listed at all; see
[MCP servers](/guide/mcp#what-the-tool-lists-show).

## One server per data directory

Two portals on the same data would each mark the other's running chats as
interrupted. The server therefore holds a socket inside its data directory
(`portal.sock`), and a second one started on the same data exits with a
message instead of failing on the port. A socket left behind by a server that
ended is replaced. This includes a server the agent starts from a chat with
another `PORT`.

## Keyboard shortcuts

**Settings → Shortcuts** lists them, and the voice-mode ones can be changed —
see [Settings](/guide/settings#shortcuts).

Dialogs, an extension's question and the phone's navigation drawer take the
keyboard when they open: focus moves into them, Tab goes round them instead of
into the page behind, and Esc (or closing them) puts focus back where it was.

## With a screen reader

Every button, field and slider has a name that is spoken: the icon-only ones
carry their action ("Pin First chat", "Rename First chat"), and the name stays
when a hover tip would have blanked the `title`. A button that opens a list
says so and whether it is open (the context pill, the model and effort
buttons), and a field that a tab or a list belongs to points at it.

- **A run that ends** is announced once, with the start of its last reply, or
  "The run has finished." where it said nothing. The reply is not read out
  word by word while it is written.
- **The command list** (type the command character in the message box) is the
  box's own: the arrow keys move through it and the command they are on is
  what is read out.
- **What went wrong** is announced when it appears: a refused pin, rename or
  delete (in the sidebar and on [Sessions](/guide/sessions)), a wrong password,
  a failed load, a message under a field. An error that is a banner has a
  Dismiss button, and goes away by itself once the next try works.
- **Where you are:** the sidebar's navigation is named and marks the page that
  is open; the Memory graph is a group of notes, each one a button.
- **A diff** is a table with named columns, and a line that was added or removed
  says so in words as well as with its sign.
- **The terminal** is readable: its screen is also drawn as text for a screen
  reader, and its input has a name in the language of the page.
