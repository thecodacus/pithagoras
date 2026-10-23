# Creator mode

**Creator mode** (`extensions/creator`, the package `pithagoras-creator`) is a
[chat mode](/guide/sessions#modes) in which the agent writes extensions for the
portal, installs them, and calls their tools in the same chat. It writes an
extension in the chat's folder, installs it with one tool call, and has its new
tools from its next step, without a restart or a `/reload`. Each extension it
installs runs its server half in a process of its own.

Optional. It is not installed by default: install it from **Settings →
Extensions → Discover → Comes with Pithagoras → Creator mode**. It adds the
mode, and a page in **Settings → Extension settings → Creator mode**
(`/settings/x/pithagoras-creator`) that lists what was made.

## Turning it on

Choose **Creator mode** on the mode chip above the message box of a chat that
has said nothing yet. It asks first, in the portal's dialog:

> The agent in this chat will write extensions and install them into the
> portal. It installs without asking you, except after this chat has read
> something that may be a prompt injection. An installed extension runs with the
> portal's own rights, outside the sandbox: it can read and change everything
> the portal can, including Docker where the portal is given it. Its tools are
> offered in every chat and run there without asking you, and its pages run in
> every browser signed in to the portal, with that sign-in. Its server half runs
> in a process of its own, which is ended if it hangs or uses too much memory:
> that keeps the portal running, and does not limit what the code can do. Every
> install is recorded in Settings → Audit, and each extension can be switched
> off or removed in Settings → Extensions.

A yes puts the chat in the mode, and [Audit](/guide/sessions#audit) keeps it as
*Mode chosen*. The mode is shown in the warning colour on the chip, and in the
chat's header once the chat has started. As every mode, it is offered in the
chats you start on the portal's pages and the conversations on an agent's page,
where pi runs in the portal's own process: not to a routine's run, a heartbeat,
a chat that came through a channel, or a colleague's chat. It is fixed once the
chat has said something.

Only a chat in Creator mode has its three tools and its skill. Every other chat
has nothing of it.

## The loop

The chat's agent is given the `extension-creator` skill, which teaches the loop
and the rules of a made extension, with a template in plain JavaScript and the
guide and the API's types to read (`/app/extensions/creator/skill/extension-creator`
in the image):

1. It copies the template into the chat's folder (`extensions/<name>`) and gives
   it a name.
2. It edits it with its own tools: a tool through `portal.chats.extend`, routes,
   a card for its tool's calls, a page.
3. It calls **`extension_install`** with the folder. A copy of the folder is
   taken, checked and installed, and the answer says whether its server half
   runs, or why not.
4. From its next step the chat has the new tools (where a subagent of the chat
   works in the background, once the run ends). Every other chat has them too,
   from its next load.
5. After a change it installs again: each install loads every half again, at
   its new revision. **`extension_status`** says where an extension stands: its
   server half's state, the crash it is held off for, what the chat could not
   load of it, its page's last failure, and its latest log lines.
   **`extension_remove`** uninstalls one it made, and deletes its copy.

What `extension_install` and `extension_status` hand back of a made extension
(its failure, its crash, its lines) is the extension's own words, which may
carry what it fetched: both tools declare it as outside content, so it is
wrapped as data and checked for a [prompt injection](/guide/security).

## Where the copy lives, and why a copy

The agent's folder is the agent's to change, at any time, and so is a project's
folder for every agent that works in it. Installing that folder by its path
would let any of them change code that runs with the portal's rights, with no
install and no ask. So the install takes a copy, and the portal installs the
copy:

- **Read as the chat's agent.** With the [sandbox](/guide/sandbox) on, what the
  agent may not read refuses the install, with its name. A link in the folder is
  left out and named in the answer (`left`), never followed; so are npm's
  `node_modules/.bin` links. Install packages with npm, which copies them, not
  pnpm, which links them.
- **Checked.** A package name without a scope; `"pi": {}`, with no
  `pi.extensions` and no folder `extensions/` at its top (pi would run either in
  every chat's pi, in the portal's process, where the extension's own process
  does not reach); a server half and a browser half where the portal looks for
  them, the browser half in a folder of its own. The portal then refuses a name
  that one of its own extensions has, or that another installed package has.
- **At most** 64 MB, 10,000 files, 32 folders deep, and 2,000 entries in a
  folder.
- **Where:** `extension-data/pithagoras-creator/made/<name>/` in the portal's data
  folder, which is the portal's alone (mode 0700): the sandbox keeps the agents
  out of it. Each file of the copy is new, so each install is a new revision of
  every half. The copy is put in place whole, by a rename, after it is checked.
  The copy it replaces is kept aside until the install is done: an install the
  portal refuses puts it back, so what is installed is what was recorded last.
- **The digest**, a sha256 of the copy's files, is in the answer, in Audit and on
  Creator's page: it names exactly what was installed.

Installing the same folder again replaces the copy at the same path. Two Creator
chats that install the same name go one after the other: the later one's copy is
the one installed.

## Its own process

Every package installed from an extension's data folder runs its server half in
a process of its own ([A server half in a process of its own](/guide/extension-ui#a-server-half-in-a-process-of-its-own)).
A loop that never yields for 10 seconds, a heap over 512 MB, memory over 1 GB on
Linux, a native crash or an exit end that process, as the half's crash, and the
portal and its chats go on. A tool call that was running answers at once with the
crash and the half's last lines, so the agent reads it in the same step, fixes the
code, and installs again: a new revision is started, and the crash no longer holds
it. See [When the server half crashes](/guide/extension-ui#when-the-server-half-crashes).

That keeps an accident from stopping the portal. It is no security boundary: the
process is the portal's user, with the portal's environment.

## The ask after a suspected prompt injection

`extension_install` and `extension_remove` declare that every call of theirs is
the shape of the `persist` rule. After the chat has read something that looks
like a prompt injection, the guard puts each such call to you in the chat
([Asked or refused](/guide/security#asked-or-refused)): **Yes** lets that one
call run, recorded as *Allowed by approval*; **No**, or closing the dialog,
refuses it, and nothing is copied or installed. Before such a read, and in a
chat that never reads one, nothing asks.

## In Audit and in Settings

- **Audit** has a row of the kind *Extension*, under `pithagoras-creator`, for
  each install (*Installed*, then *Installed again*) and each removal
  (*Removed*): the name and version, the short digest and the folder. The
  chat's id is kept with the row (`session_id` in `GET /api/audit`).
- **Settings → Extensions** marks a made extension **From pithagoras-creator**
  (or the name you gave it in Settings → Tools), with when it was installed on
  hover and a note under it: the chat it was made in and its folder. Switch it
  off or **Remove** it there as any other.

## Creator's page

**Settings → Extension settings → Creator mode** lists what agents made in
Creator mode chats, the one installed last first: its name and version, whether
it is **On**, **Off** or **Not installed**, the chat it was made in (a link) or
that the chat was deleted, when, its short digest and its folder.

One you removed in Settings → Extensions keeps its copy, and is listed as **Not
installed**. **Forget** deletes that copy and its entry, after asking. One that
is installed has no Forget: remove it in Settings → Extensions first.

## Leaving the mode

A chat's mode is fixed, so leaving Creator mode means starting a new chat. What
was installed stays installed, and its tools stay on in every chat, unless a tool
says `offByDefault` or you switch it off in **Settings → Tools**.

Switching **Creator mode** off in Settings → Extensions takes its three tools out
of every chat at its next step, and its skill at the chat's next message: pi keeps
the prompt a run started with until the run ends. The mode leaves the picker; a
chat started in it keeps its mode, and says it is not available. The extensions
it installed stay as they are.

## Recovery

- **A made extension that misbehaves**: switch it off, or remove it, in Settings →
  Extensions. A crash of its server half holds it off by itself.
- **A page that a made extension's browser half breaks**: open the portal with
  `?extensions=off` on its address (`/settings/extensions?extensions=off`), which
  loads no browser half, and switch it off from there.
- **From the command line**: `pi remove` its folder in the portal's container,
  as for any package.

## With the sandbox off

The sandbox is off until it is switched on in **Settings → Sandbox**. While it
is off, the agent runs as the portal's own user: it can already change the
copies in Creator's folder directly, which load at the next change of what is
installed, and run `pi install` itself, with no ask and no row in Audit. Creator
mode then adds the structure, the marks and the audit, not a wall: the sandbox is
what closes Creator's folder to the agent. See [Creator mode](/guide/security#creator-mode)
under Prompt injection.
