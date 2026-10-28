# The agent's browser

**Browser** (`extensions/browser`, the package `pithagoras-browser`) is a real
browser for the agent, with a profile that stays signed in. You log into it
once by hand; every run after that finds the accounts already there.
**No password ever passes through the model.** It gives the agent its browser
tools, a page to watch and set up the browser, the browser beside a chat and in
voice mode, and runs the browser in a container through
[Docker for extensions](/guide/docker), which it requires.

Optional. Nothing here is installed, pulled or shown unless you ask for it:
neither Browser nor Docker is installed by default. Like any other extension,
Browser is switched off or removed in Settings → Extensions (see
[Removing Browser](#removing-browser)). A portal that had the browser before it
was an extension handed what it kept over to it: see
[Upgrading](/guide/upgrading#browser-is-an-extension).

## Installing it

1. **Settings → Extensions → Discover → Comes with Pithagoras → Browser →
   Install.** It requires Docker, and the question before the install says so:
   on yes Docker is installed first, then Browser
   ([Installing what it requires](/guide/extension-ui#installing-what-it-requires)).
   Docker is needed even where the portal cannot reach a Docker socket: Browser
   does not start without it, and then runs the machine's own Chrome.
2. **Settings → Extension settings → Browser** (`/settings/x/pithagoras-browser`)
   → **Install**. Nothing to edit, nothing to redeploy. Set a password when
   asked — this holds live sessions for the agent's accounts, and **Suggest
   one** makes one.

Three ways it can run, chosen for you rather than configured, each time it is
asked:

| | When | What you get |
| --- | --- | --- |
| **Container** | Docker reaches its socket (see [Giving the portal Docker](/guide/docker#giving-the-portal-docker)) | Its own container, pulled on install. Costs nothing until you install it. |
| **Local Chrome** | it cannot | The Chrome or Chromium already on the machine, with a profile in Browser's folder. Nothing downloaded. |
| **External** | `BROWSER_EXTERNAL=true` | A browser you run yourself. The portal only looks at it and drives it; it is started, stopped and removed where it runs. |

The local path is mostly the portal run from source. It goes headless when there
is no display, and says so — sign-in pages refuse headless browsers often
enough to matter.

Install is the same on Browser's page in Settings and on the Browser page, and
the button waits while it runs, so a second click cannot start a second download.
The image is a few GB; its progress is shown on both pages, and what went wrong
if the download fails. Once it is installed the agent is connected to it, and
when it is removed the agent is disconnected, whichever page you used.

**Remove** takes the container away and keeps the profile, so installing again
finds the logins still there.

### The Browser page

**Browser** is in the sidebar's **Extensions** group, at
`/x/pithagoras-browser/browser`, while a browser runs, while the agent has its
tools, or while a routine's runs are given them otherwise than the default. It
says whether the browser answers and which tabs are open, opens the browser in
the page, has the cursor's switch, says where the browser may go and who may
drive it, and warns about what needs doing: a browser nobody can drive, tools
for a browser that is not running, a browser without a password, and one
installed before its own port was kept to this machine.

The page only says the browser is not answering when its container is up and
does not answer: stop it and start it again, and what it wrote is in
Settings → Docker. A browser you stopped, one that is not installed, and the
machine's own Chrome are not broken. One run elsewhere (`BROWSER_EXTERNAL=true`)
that does not answer is said to be started where it runs.

### The container, its storage and ports

| Item | Value |
| --- | --- |
| Image | `lscr.io/linuxserver/chromium:latest` |
| Container | `pithagoras-browser` |
| Profile volume | `pithagoras_browser-profile` (override: `BROWSER_VOLUME`) |
| Network | Host |
| Shared memory | 1 GiB |
| Chromium security option | `seccomp=unconfined` |
| HTTP / HTTPS | `3010` / `3011`, on `127.0.0.1` only (`BROWSER_BIND`) |
| Debugging port | `9222`, on `127.0.0.1` only |

Both are Browser's in Docker: made with its name on them, and listed under
`pithagoras-browser` in Settings → Docker, where the container can be stopped,
started and removed, and the volume deleted. A
container or a profile volume of those names made by an earlier version of the
portal is taken over by Browser each time it starts, and never made anew: the
container goes on as it is. The container uses Docker's `unless-stopped` restart
policy, so it comes back after a reboot.

Avoid port conflicts. The web page of the browser is reached through the portal,
or from the host itself; see [the browser's own port](#the-browser-s-own-port)
for other machines.

Environment variables on the portal adjust it; a value Browser keeps (the
password set on its page in Settings, or one sent to its `/config`) wins over
the variable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_USER` / `BROWSER_PASSWORD` | `agent` / — | Login for the browser web UI |
| `BROWSER_PORT` / `BROWSER_HTTPS_PORT` | `3010` / `3011` | Its HTTP and HTTPS ports |
| `BROWSER_BIND` | `127.0.0.1` | The IPv4 address those ports listen on; the portal reaches them on `127.0.0.1` whatever it is. `0.0.0.0` opens them to every machine that can reach this one. The shipped Compose files and the Portainer stack pass it on from `.env`. Applies when the browser is installed, so remove and install it again after changing it |
| `BROWSER_STREAM_PORT` | `8082` | The port the embedded live view reads frames from |
| `BROWSER_HOST` | `127.0.0.1` | Where the portal reaches the browser |
| `BROWSER_CDP_URL` | `http://127.0.0.1:9222` | The debugging endpoint the agent's browser tools use |
| `BROWSER_VOLUME` | `pithagoras_browser-profile` | The profile volume |
| `BROWSER_EXTERNAL` | — | `true` for a browser you run yourself |
| `BROWSER_BINARY` | — | Without a Docker socket — typically the portal run from source — Browser starts a Chrome or Chromium already on the machine, and this names its binary; the profile is kept in Browser's folder, `extension-data/pithagoras-browser/profile` in the data folder |

### Its controls

| Action | Result |
| --- | --- |
| **Stop** | Stops the browser container; keeps its profile and logins. |
| **Start it** | Starts the installed container with that profile. |
| **Remove** | Deletes the container; keeps the profile volume. |
| **Install** after removal | Makes the container again and reuses a retained profile. |

With `BROWSER_EXTERNAL=true` these belong to your own deployment: Browser refuses
to install, start, stop or remove it.

### A newer image

Installing reuses an image that is already there. To fetch a newer one, pull it,
then **Remove** and **Install** on Browser's page in Settings:

```sh
docker pull lscr.io/linuxserver/chromium:latest
```

### Deleting the profile

::: danger Delete saved logins permanently
**Remove** keeps the profile. To erase the browser's logins, remove the browser
first, then delete the volume under `pithagoras-browser` in **Settings → Docker**,
or on the Docker host (with your `BROWSER_VOLUME` if it is another):

```sh
# Destructive: deletes the browser profile and saved logins.
docker volume rm pithagoras_browser-profile
```
:::

`DELETE /api/x/pithagoras-browser/install?profile=forget` removes the container
and the volume in one go; the pages offer no button for it.

### Removing Browser

Switched off or removed in Settings → Extensions, Browser's page, its page in
Settings, the browser beside a chat and in voice mode, and the agent's browser
tools go. The browser itself does not: its container keeps running (`unless-stopped`),
signed in, with its debugging port on this machine's loopback, and stays
listed under `pithagoras-browser` in **Settings → Docker**, where it can be
stopped or removed. Browser's folder in the data folder (`extension-data/pithagoras-browser`:
its settings, the password among them, and a local Chrome's profile) stays
for when it is back.

## Logging in

**Browser → Open browser** in the portal. That is a full Chromium in a web page:
sign into whatever the agent should have, then close the tab. The profile lives on
its own volume and survives restarts.

### Embedded, or in a tab

Browser serves the browser's UI through the portal at
`/api/x/pithagoras-browser/ui/`, so **Open browser** shows it inline with a
fullscreen button, using the portal's own certificate and credential. No second
password, no second certificate. The page and its websocket sit behind the
portal's login like everything else: without the login they answer 401, and a
websocket opened from another site is refused. Behind a reverse proxy that
rewrites the `Host` header, have it send the host the visitor asked for as
`X-Forwarded-Host`: the page's origin is compared with that as well. The frame
switches on like a screen when it opens, while the portal's
[animations](/guide/interface#animations) play.

That needs the portal itself on HTTPS. The VNC client gates on
`isSecureContext`, and a frame only counts as secure when **every page above it**
does — so an HTTPS frame inside an HTTP portal fails exactly as plain HTTP
would. Without TLS the page says so and offers a tab instead.

Give the portal a certificate:

```
PORTAL_TLS_DIR=/etc/pithagoras/certs
PORTAL_TLS_CERT=/certs/portal.crt
PORTAL_TLS_KEY=/certs/portal.key
```

A self-signed pair is enough:

```bash
mkdir -p /etc/pithagoras/certs && cd /etc/pithagoras/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout portal.key -out portal.crt -subj "/CN=pithagoras"
```

On a tailnet, `tailscale cert <machine>.<tailnet>.ts.net` gives a real one and
no warnings at all.

### The browser's own port

The browser's web page is also served by its container, on ports `3010` (HTTP) and
`3011` (HTTPS), with its own login and a self-signed certificate. It listens on
**this machine only** (`127.0.0.1`): the container shares the host's network, so
anything it listens on is the host's own address, and the one password in front of
it should not be what stands between a browser holding the agent's logins and
everyone on the network. The portal's `/api/x/pithagoras-browser/ui/` above is the
way in from other machines, behind the portal's login.

From the host itself, `https://127.0.0.1:3011` with `BROWSER_USER` and
`BROWSER_PASSWORD` works. From another machine, forward the port over SSH and open
it on your own side:

```bash
ssh -L 3011:127.0.0.1:3011 <host>
# then open https://127.0.0.1:3011
```

If the portal is on plain HTTP it cannot embed the browser, and there is no direct
link from its page either; give it a certificate as above, or open the port yourself
by setting `BROWSER_BIND` on the portal (see [above](#the-container-its-storage-and-ports)) to
`0.0.0.0`, or to the one address of this machine that you want it on; the portal
itself keeps reaching it on `127.0.0.1` either way. Then the page links to
`https://<host>:3011` again. That is every machine that can reach the address, and
your password only, so use a long one and a firewall. With the shipped Compose files
or the Portainer stack, put `BROWSER_BIND=0.0.0.0` in `.env` (they pass it on to the
portal), recreate the stack, and remove and install the browser again.

A browser installed by an earlier version listens on every interface until it is
removed and installed again (**Remove** keeps the profile and its logins); the
Browser page says so while that is the case.

Give the agent **its own accounts** rather than sharing yours. That is what
makes it a teammate rather than a proxy, and it keeps a colleague's request from
reaching your personal mail.

## Beside a chat and in voice mode

While the browser's container runs, and the portal is on HTTPS, a chat's header
has a **Browser** button: the browser in a panel beside the conversation, black
from edge to edge, with **Fullscreen** in its head. It docks, floats and is
resized as every panel is (see [Files](/guide/files#panels)), and other pages
open it by its name, `browser`.

In [voice mode](/guide/voice) the browser is a window at the side of the
stage, as Files' is, and in the middle when the conversation or the pictures
have the side. It opens each time the agent drives a browser, Browser's tools or a
Playwright MCP's, and says when there is no browser to show or it cannot be
reached. It can fill the stage (**Maximize**, and Escape, also from inside the
page in it, gives the stage back), and it stays loaded while it is minimized.
<kbd>B</kbd> shows and hides it, and can be changed under Settings → Shortcuts.
A browser call's card says what the agent is doing ("Opening a page" and the
site, "Clicking in the browser" and what it clicked), and a tap on it opens the
window.

## Letting the agent drive it

**Browser → Connect the agent** gives every chat Browser's tools, which drive this
browser over its debugging port. Installing the browser connects them, and
removing it disconnects them.

A local model reads every token a tool returns before it can answer, so the
tools never hand it a whole page. A page is what is **on screen**: the viewport
and a margin around it, as text with a ref for each element, and how much more
there is above and below. A long Wikipedia article is about 130,000 tokens as a
whole page and 1,000 to 2,000 as a view.

| Tool | What it does | What it answers with |
| --- | --- | --- |
| `browser_navigate` | Opens a URL | The view |
| `browser_snapshot` | Looks at the page; `mode: "index"` lists only what can be clicked or typed into | The view |
| `browser_click`, `browser_type`, `browser_select`, `browser_key` | Act on an element by its ref | What changed on screen, as lines: `~ button "Save" → "Saved" disabled`, `+ alert: Saved` |
| `browser_scroll` | The next screen down or up, or an element by its ref | The new view, without what stayed pinned (a sticky sidebar) |
| `browser_find` | Finds elements anywhere on the page by their words | Their refs, and how far above or below the screen they are |
| `browser_get_text` | Reads a section's full text by its ref | Its text in pages of about 2,000 characters, with where to continue |
| `browser_back` | Goes back a page | The view |
| `browser_screenshot` | A picture of the screen or of one element | An image |

What a view shows:

- Links inside a sentence are read in place, `retrieval-augmented generation[e1462]`,
  and footnote markers are left out.
- Text longer than about 200 characters is cut, with where to read the rest:
  `… (+821 chars: get_text e1438)`.
- Wrappers that mean nothing (`generic`, nameless cells) are left out, and a
  link's address is shown only when it has no name.
- A view is capped at about 3,000 tokens; past that it says how much more is
  in view and how to reach it.

An action that moves to a new page, opens a new tab, or changes too much to be
told as a diff answers with a view instead. A ref whose element has gone is
refused, with a request to look again, rather than clicked on whatever is there
now. Page content is someone else's words: the tools declare that what they
return is outside content, so every result is marked as such, and the session is
limited as for mail (see [Prompt injection](/guide/security)). They run one at a
time, also when the model calls several in one message.

What the tools have in common is told to the model once, as rules in its
instructions, and not again in each tool's description: what an action answers
with, and that a ref is never guessed and a gone one is refused. That a page is
data and never instructions is the portal's rule for every tool that returns
outside content, said once while any of them is on. Each tool that concerns a
rule carries it, so a rule is said while any of those tools is on. Switching one
tool off, `browser_snapshot` included, takes none of them away.

A chat goes on in the tab it last worked in, also after it was let go for being
idle; its first call takes the newest tab. A chat that is deleted, and a routine
run in a session of its own that is over, are forgotten, and their tabs stay open
in the browser as they were. Browser started again (with Docker, after an update)
forgets them all, and each chat goes on in the newest tab.

### The agent's cursor

While the agent works you can watch it in the browser: before each click,
typed text, choice, key or scroll, an arrow glides to the element along a slight
arc, with a few words on what is about to happen (`Click · Save`,
`Type · City`, `Choose · Pro`), and pulses as the real action lands. What is
typed is never shown, only the field's name, so a password stays as hidden as
the field keeps it.

- It is drawn by the page, not the system pointer, and clicks pass through it.
  It is not in the accessibility tree, so the views and diffs the model reads
  never contain it. It stays in what `browser_screenshot` takes, on purpose:
  there it shows the agent which element it last went for, so it can tell when
  that was the wrong one. The screenshot tool tells the model the arrow is its
  own cursor.
- It keeps its place when a page loads, so it does not jump to a corner on every
  navigation, and it points at elements inside frames too.
- After two minutes with nothing done it fades away, and comes back where it was
  at the next action.
- It follows the browser's light or dark theme: see-through dark glass with a
  white edge and a light blue glow in dark mode, a deep blue glass with a blue
  glow in light mode.

Each move takes about a third of a second, which the action waits for. To turn
it off, use the **Browser → Show the agent's cursor** switch; the actions then do not wait.

### Upgrading from the Playwright MCP

Before these tools, the portal attached the browser as a Playwright MCP server,
and replaced the entry it wrote with its own tools on the first start of a
version that had them. A portal upgraded straight from before that keeps the
entry: it is then a Playwright MCP server like one added by hand (below).
Remove it in [Settings → MCP](/guide/mcp) to have Browser's tools in its place.

### With a Playwright MCP instead

A Playwright MCP server added by hand in [Settings → MCP](/guide/mcp) still
works, and the portal leaves it alone; switch Browser's tools off first (in
Settings → Tools), or the agent holds two sets:

```json
{
  "browser": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", "http://127.0.0.1:9222"]
  }
}
```

`--cdp-endpoint` is the whole trick: it **attaches to the running browser**
instead of launching one. A Playwright MCP server without it starts its own
throwaway Chromium, which is signed into nothing — a way around everything on
this page, its own browser, no profile, no allowlist.

The portal gives the agent two rules for driving a Playwright browser (take a screenshot
before reading the page's text, and leave out `filename` so a screenshot comes back as an
image). They are in a chat's instructions only while a Playwright MCP server is attached
to a running browser: one with a `--cdp-endpoint`, at whatever address, or one called
`browser`. A server that launches a Chromium of its own gets none, and with no server at
all nothing about a browser is added.

## Who may drive it

The browser reaches the agent as Browser's tools, a group named
`pithagoras-browser` in the tools list, so it is switched where every other tool
is: the tools icon beside the composer for one conversation, **Settings → Tools**
for all of them, **Projects → Tools** for the chats of one project, and a
routine's **Tools** on its own page for its runs. Having its tools is having the
browser — a conversation with them all off is not offered them and does not
reach the browser.

**Browser → Who may drive it** says what the default is, and lists the
conversations that have it otherwise, each marked **on** or **off**, and the
routines whose own tools give their runs another answer than the default.

With a Playwright MCP server added by hand instead, its tools are that server's
group, and the same switches apply to them.

Like any other tool, they are **on** unless something says otherwise. A portal
that had the browser before it was an extension keeps who could drive it: the
upgrade wrote it into the tools' switches (see
[Upgrading](/guide/upgrading#browser-is-an-extension)).

::: tip Turning it off everywhere
**Settings → Tools → pithagoras-browser → all off**. That is the one switch; there
is no second one to keep in step with it.
:::

::: tip Not in the prompt until it is wanted
The browser's tools are a large set, and while they are on they sit in the prompt of every chat. They
are not lazy unless you make them so: mark the group **lazy** in **Settings → Tools** and no chat is
offered them one by one. The agent is told it has these tools, and finds and calls them through the
`tools` tool, so a chat that never opens a page carries none of their schemas. A lazy tool is still on
like any other: a call is held to the allowlist and the other rules exactly as a direct one, and a
switch that turns the browser off for a chat turns it off here too. This is for Browser's tools;
a browser attached as an MCP server is lazy or not by that server's own "Register tools directly". See [Lazy tools](/guide/extensions#lazy-tools).
:::

Deliberately **not** gated on who is speaking. The agent has its own accounts and
uses them as itself, including when it is helping a colleague. What balances
that is visibility: every page it opens is recorded in [Audit](/guide/sessions#audit).

::: warning With `EXECUTOR=container`
pi runs inside the container and never tells the portal what it registered, so
there is no tool list to switch and the tools popover says so. Browser's tools
are given only to a chat whose pi runs in the portal's own process, so with
`EXECUTOR=container` no chat has them, and the guard, which runs in the portal's
process, holds nothing there.
:::

## Where it may go

**Settings → Guard → Sites the agent's tools may reach** takes one domain per
line, `*.example.com` for subdomains. An empty list means any site. It is one
list for every tool that says where it goes (Browser's tools say their `url` is)
and for the browser tools an MCP server brings, such as a Playwright MCP server's.
**Browser → Where it may go** says so, and links to it.

::: danger Read this one together with the section above
That default was written when the browser was off until somebody turned it on,
so an empty list blocked nothing that was not already blocked. Browser's tools
are on by default now. An empty allowlist and an untouched tools list means
**every conversation can point the agent's signed-in browser anywhere** — so on
a portal whose browser holds real logins, fill this in, or switch the browser's
tools off by default and turn them on where you want them.
:::

::: warning This is a check, not a wall
It is applied when the agent asks for a URL. A page that redirects itself is not
covered, and neither is a request the agent makes through the debugging protocol
rather than by navigating. Real enforcement is a filtering proxy in front of the
browser, which is not built yet.
:::

## The debugging port

Chromium exposes `127.0.0.1:9222`, and that port is **unauthenticated**. Whoever
reaches it owns every account the browser is signed into.

Host networking is what keeps it to the box: Chromium binds that port to the
loopback address only. Never publish it, never put it behind a reverse proxy, and
treat the profile volume as the secret it is. The browser's web page on `3010` and
`3011` is held to the loopback address as well, by Browser (see
[above](#the-browser-s-own-port)).

### Playwright MCP screenshots

With a Playwright MCP attached, the portal requests inline image data for its screenshots. In the pinned
Playwright version, providing `filename` suppresses the image block, leaving
only a file link. The portal removes that argument from screenshot calls;
Playwright still saves the screenshot under an automatic filename. Capture
options such as target, full-page, scale, and format remain available.

Its snapshot output uses compact notation: `[eN]` or `[fNeN]` is the exact element
reference, an omitted role means `generic`, and `[pointer]` means a pointer
cursor. The tree retains its nodes, text, URLs and state; this formatting does
not impose a depth limit or truncate content.

## Its routes

Browser's page and its page in Settings talk to its server half, under
`/api/x/pithagoras-browser`, behind the portal's login: see
[Browser](/reference/api#browser) in the API reference.

## Troubleshooting

```sh
docker ps -a --filter name=pithagoras-browser
docker logs --tail 100 pithagoras-browser
docker volume inspect pithagoras_browser-profile
```

What the container wrote is also under `pithagoras-browser` in
**Settings → Docker** (**Logs**). Port already allocated: check for an older browser container, or
anything else on `3010`, `3011` or `9222`, and stop it before installing again.
