# The agent's browser

::: tip Docker installation
See [Docker add-ons](/guide/add-ons) for installation, controls and profile cleanup.
:::

Optional. Nothing here is installed, pulled or shown unless you ask for it.

A real browser, in its own container, with a profile that stays signed in. You
log into it once by hand; every run after that finds the accounts already there.
**No password ever passes through the model.**

## Installing it

**Settings → Add-ons → Browser → Install.** Nothing to edit, nothing to
redeploy. It is not in `docker-compose.yml` and never was for you: a deployment
that never installs it has no image, no container, and no Browser page.

Set a password when asked — this holds live sessions for the agent's accounts,
and there is a button to generate one.

Two ways it can run, chosen for you rather than configured:

| | When | What you get |
| --- | --- | --- |
| **Container** | the portal can reach the Docker socket | Its own container, pulled on install. Costs nothing until you install it. |
| **Local Chrome** | it cannot | The browser already on the machine, same profile directory. Nothing downloaded. |

The local path is mostly the portal run from source. It goes headless when there
is no display, and says so — sign-in pages refuse headless browsers often
enough to matter.

Install is the same on **Settings → Add-ons** and on the Browser page, and the
button waits while it runs, so a second click cannot start a second download. The
image is 4.6 GB; its progress is shown on both pages, and what went wrong if the
download fails. Once it is installed the agent is connected to it, and when it is
removed the agent is disconnected, whichever page you used.

**Remove** takes the container away and keeps the profile, so installing again
finds the logins still there.

The Browser page only says the browser is not answering when its container is up
and does not answer. A browser you stopped, one that is not installed, and the
machine's own Chrome are not broken.

## Logging in

**Browser → Open browser** in the portal. That is a full Chromium in a web page:
sign into whatever the agent should have, then close the tab. The profile lives on
its own volume and survives restarts.

### Embedded, or in a tab

The portal proxies the browser's UI at `/browser-ui`, so **Open browser** shows
it inline with a fullscreen button, using the portal's own certificate and
credential. No second password, no second certificate. The page and its
websocket sit behind the portal's login like everything else: without the login
they answer 401, and a websocket opened from another site is refused. Behind a reverse
proxy that rewrites the `Host` header, have it send the host the visitor asked for
as `X-Forwarded-Host`: the page's origin is compared with that as well. The frame switches on like
a screen when it opens, unless [the animations](/guide/interface#animations) are
off.

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
everyone on the network. The portal's `/browser-ui` above is the way in from other
machines, behind the portal's login.

From the host itself, `https://127.0.0.1:3011` with `BROWSER_USER` and
`BROWSER_PASSWORD` works. From another machine, forward the port over SSH and open
it on your own side:

```bash
ssh -L 3011:127.0.0.1:3011 <host>
# then open https://127.0.0.1:3011
```

If the portal is on plain HTTP it cannot embed the browser, and there is no direct
link from its page either; give it a certificate as above, or open the port yourself
by setting `BROWSER_BIND` on the portal (see [Docker add-ons](/guide/add-ons)) to
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

## Letting the agent drive it

**Browser → Connect the agent** gives every chat the portal's browser tools,
which drive this browser over its debugging port. Disconnecting takes them away
again.

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
now. Page content is someone else's words: every browser result is marked as
such, and the session is limited as for mail (see
[Prompt injection](/guide/security)).

What the tools have in common is told to the model once, as rules in its
instructions, and not again in each tool's description: what an action answers
with, that a ref is never guessed and a gone one is refused, and that a page is
data and never instructions. Each tool that concerns a rule carries it, so a rule
is said while any of those tools is on. Switching one tool off, `browser_snapshot`
included, takes none of them away.

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

Before these tools, the portal attached the browser as a Playwright MCP server.
The first start after the update replaces the entry it wrote with these tools,
once, and carries every switch on it — the default, each project's, each chat's
— so the same chats have the browser. Other MCP servers are not touched.

### With a Playwright MCP instead

A Playwright MCP server added by hand in [Settings → MCP](/guide/mcp) still
works, and the portal leaves it alone; disconnect the built-in tools first, or
the agent holds two sets:

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
image). They are in a chat's instructions only while the built-in tools are not connected
and a Playwright MCP server is attached to this browser: one whose `--cdp-endpoint` is its
address, or one called `browser`. A server that launches a Chromium of its own gets none,
and with no server at all nothing about a browser is added.

## Who may drive it

The browser reaches the agent as the portal's own tools, a group named `browser`
in the tools list, so it is switched where every other tool is: the tools icon
beside the composer for one conversation, **Settings → Tools** for all of them,
and **Projects → Tools** for the chats of one project. Having its tools is having
the browser — a conversation with them all off is not offered them and does not
reach the container. A routine has its own **Browser** switch on its own page,
off by default.

With a Playwright MCP server added by hand instead, which server is the browser
comes from where it connects, not from what it is called: the one whose
`--cdp-endpoint` points at this browser. The same switches then apply to its
tools.

Like any other tool, they are **on** unless something says otherwise.
An installation that had the old per-session switch keeps what it had: the
browser's tools are written into the defaults as off and the conversations that
had been granted it are given it back. So an existing portal wakes up the way it
went to sleep, and a new one starts like any other server.

That happens when the first conversation after the upgrade lists its tools, not
when the portal starts — which of them are the browser's is only known once a
session has registered them. Until then the old switch is what answers, so there
is no moment in between where every conversation has the browser.

::: tip Turning it off everywhere
**Settings → Tools → browser → all off**. That is the one switch; there is no
second one to keep in step with it.
:::

::: tip Not in the prompt until it is wanted
The browser's tools are a large set, and while they are on they sit in the prompt of every chat. They
are not lazy unless you make them so: mark the group **lazy** in **Settings → Tools** and no chat is
offered them one by one. The agent is told it has browser tools, and finds and calls them through the
`tools` tool, so a chat that never opens a page carries none of their schemas. A lazy tool is still on
like any other: a call is held to the allowlist and the other rules exactly as a direct one, and a
switch that turns the browser off for a chat turns it off here too. This is for the portal's own browser tools;
a browser attached as an MCP server is lazy or not by that server's own "Register tools directly". See [Lazy tools](/guide/extensions#lazy-tools).
:::

Deliberately **not** gated on who is speaking. The agent has its own accounts and
uses them as itself, including when it is helping a colleague. What balances
that is visibility: every page it opens is recorded in [Audit](/guide/sessions#audit).

::: warning With `EXECUTOR=container`
pi runs inside the container and never tells the portal what it registered, so
there is no tool list to switch and the tools popover says so. The browser is
granted per session over the API there (`PUT /api/sessions/:id/browser`), which
is what the old switch wrote.
:::

## Where it may go

**Browser → Where it may go** takes one domain per line, `*.example.com` for
subdomains. Empty means no restriction.

::: danger Read this one together with the section above
That default was written when the browser was off until somebody turned it on,
so an empty list blocked nothing that was not already blocked. It is on by
default now. An empty allowlist and an untouched tools list means **every
conversation can point the agent's signed-in browser anywhere** — so on a
portal whose browser holds real logins, fill this in, or switch the browser's
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
`3011` is held to the loopback address as well, by the portal (see
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
