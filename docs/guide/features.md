# Opt-in features

Four capabilities ship with Pithagoras and are **off** until you switch them on
in **Settings**: a **subagent tool**, **Understory** as the
agent's memory under **Extension settings → Memory**, and **image generation and
editing** and **video generation** under **Extension settings → Media**. A fresh
install has none of them. ([Voice mode](/guide/voice)'s settings are at the end of **Settings → Defaults**;
the [voice service](/guide/voice-service), [Voice servers](/guide/voice-servers) and the agent's [browser](/guide/browser) are extensions.)
The subagent tool is the `pithagoras-subagent` extension, which comes with the
portal and is switched on in **Settings → Extensions** like any other, with its
settings under **Extension settings → Subagents**. Switching Understory on
writes it into pi's own configuration as an MCP server, so it can also be seen,
and undone, from Settings → MCP. Understory is the
`pithagoras-understory` extension, which you install first (see
[Memory: Understory](#memory-understory)). Image and video generation are
the tools of the [Media](/guide/media) extension, which a portal installs when
it first starts, and keep their settings in its own store.

The first two are reference implementations behind a seam the portal already
has, so a third-party equivalent can take their place without changing the
portal:

- the subagent tool speaks the [subagent protocol](/guide/extensions#the-subagent-protocol);
  any extension that does is shown and steered the same way;
- Understory is an [MCP server](/guide/mcp); any memory server can be attached
  the same way.

A switch reloads the idle open chats so they have the change at once. A chat
that is busy has it from its next step, and one with a subagent still working
in the background once that is done: see
[a chat that is working](/guide/extensions#a-chat-that-is-working).

## Subagents

**Settings → Extension settings → Subagents.** The `subagent` tool hands a
self-contained task to a second pi with a context of its own and gets its answer
back. You can watch it beside the chat (the robot button in the chat's header),
give it instructions while it works, and stop it.

It is the `pithagoras-subagent` extension, which comes with the portal in its
`extensions/subagent` folder. Install it, or switch it on and off, in
**Settings → Extensions**: switched off, no chat has the tool, and its page is
gone from Settings. Its server half gives every chat's pi the tool and keeps
its settings. A portal that had the tool on before it was an extension keeps it
on, with the settings it had (see [Upgrading](/guide/upgrading)).

### How it runs against the agent

| Mode | What happens | When to use it |
| --- | --- | --- |
| **Interrupt** (default) | The tool call waits for the subagent's answer, so the agent's turn is held while it runs. Subagents asked for together run one after the other. | Local hosting, a single GPU: only one model call at a time. |
| **Background** | The tool call returns at once and the agent goes on working. The subagent's answer arrives later as a message in the chat and starts a turn if the agent is idle. A subagent you stop does not start one. | Hosted models, or hardware that can serve two agents at once. |

Background runs two agents — two model processes — at the same time. With a
local model that means two model calls at once, which a single GPU may not
hold. Stopping the chat does not stop a background subagent; stop it from its
window. Closing or reloading the chat does.

### Which model a subagent runs on

By default a subagent runs on **the model its chat is on** when it starts one —
the one already loaded, so a local server does not have to load a second one.
**Model** on its page names another for every chat instead, and each
chat can say its own in its model menu (*Subagents in this chat run on*):
the default, this chat's model, or any model there is. A choice is read when a
subagent starts, so it needs no restart.

Stored in the extension's own settings (`"provider/model"`, or absent for the
chat's own); a chat's own is the portal's, and reaches the tool over the
protocol's `subagent:v1:config`.

### Subagents at once

**Subagents at once** (default 1) is how many run at the same time, across
every chat — each one is a model running. One asked for beyond it waits for a
free slot: in interrupt mode its tool call waits (and gives up if the chat is
stopped meanwhile); in the background the call returns saying it is queued,
and it starts once another has finished. A queued one does not start once its
chat has been closed or reloaded.

The mode, the limit and the model are kept in the extension's own folder of the
portal's data folder (`extension-data/pithagoras-subagent/settings.json`), each
left out while it is the default. Before it was an extension, the tool read
them from pi's `settings.json` (`subagentMode`, `subagentMaxParallel`,
`subagentModel`): the upgrade hands them over once, and takes them out of pi's
file. They are set on its page or through its own address
(`/api/x/pithagoras-subagent/settings`, see the [API](/reference/api)).
`PI_SUBAGENT_BIN` picks the `pi` it starts (default: `pi` on `PATH`).

Subagents need the host executor (`EXECUTOR=host`): only there does the portal
run pi in its own process, where the extension gives a chat's pi the tool and
shares its event bus.

### What the agent is told

The `subagent` tool's description names the mode it runs in and the limit
("One runs at a time: further calls wait for it to finish", or "At most 3 run
at once; further calls wait for a free one"), so the agent does not ask for more
than will start. The results carry the live numbers, counted across every chat:
a background call says how many are running and how many wait ("2 of 2 running,
1 waiting, this one included"), and an interrupt call that had to wait for a
slot ends its answer with how long it waited, so the agent can tell the wait
from the subagent's own work time. Nothing is added to the system prompt, so its
cache holds.

The description is read when a chat loads the tool, so a change under
**Subagents at once** or **Mode** reaches an idle chat at once (it is reloaded),
a busy one at its next step, and one with a subagent still working in the
background once that is done. The limit is enforced live all the same, so a
chat that has not yet taken the change never runs more than the settings say.

## Image generation

**Settings → Extension settings → Media**, **Image model.** The image endpoint, and the switches for
**Image generation**, **Image editing**, **Several pictures per edit** and **Stable Diffusion extra settings**. The section opens and
closes, with the first two switches always in view; the editing endpoint and the last two switches are groups in it
(**Editing endpoint**, **More options**). Before Media became an extension it was on other Settings pages, last
**Settings → Agent → Media**; what was set there is carried over.

The two switches, **Image generation** and **Image editing**, are the general switches of the
feature: they decide whether it exists. Switched on, with an address, the [Media page](/guide/media)
can make or change pictures, and a chat's agent can have the tool for it: a `generate_image` tool, in
which the agent describes a picture, an image model you set up makes it, and it appears in the
chat — and in voice mode's picture window — just like one the agent showed with `show_image`.
Changing a picture that already exists is a second tool with a switch of its own,
[`edit_image`](#editing-a-picture). Switched off, or without an address, there is no such tool at all,
the voice instructions say nothing of one, and the page says in its form that it is not set up, with a
link here.

Whether a chat's agent actually has a tool is a different question, and is answered only in the
**tool lists**: Settings → Agent → Tools for every conversation, a project's Tools, and the tools control
of a chat (see [Tools](/guide/interface#tools)). The switches here do not decide it, and the
Media page does not look at those lists: a tool switched off there leaves the page as it is, as
a feature switched off here removes the tool from the lists.

The same endpoint also makes pictures **without the agent**: while it is on and has
an address the sidebar has a [Media](/guide/media) page, with a form to make and
change pictures and a gallery of everything made, here and in chats. The page is there
as well where only [editing](#editing-a-picture) is set up.

### The endpoint

Any server with an OpenAI-style `images/generations` route: hosted providers,
and local servers that offer it. Nothing about one provider or model is built
in.

| Field | Meaning |
| --- | --- |
| **API address** | The API's base, such as `https://images.example.com/v1`. The portal adds `/images/generations` unless the address already ends with it. No login, query or `#` in it: the key has its own field. |
| **API key** | Sent as `Authorization: Bearer …` to this address, and nowhere else. Left empty for a server that needs none. A saved key is never shown again — the page is only told that one is set — so leave the field empty to keep it, or choose **Remove the saved key**. Giving the address of another server without a key drops the saved one: a key belongs to the server it was given for. (A key saved before any address belongs to the first one.) |
| **Model** | Sent as `model`. Empty sends none, for a server that has only one. |
| **Picture size** | Sent as `size`, such as `1024x1024`, each side a whole number from 64 to 8192 (or `auto`): the same sizes the [Media page](/guide/media) takes. Empty sends none. The agent can ask for another size in a call, within the same limits. A size saved before there were limits, outside them, counts as none. |
| **Time limit** | How long the portal waits for one picture, in whole seconds: **300** (five minutes) unless you set another, from 30 to 3600. It is one limit for making and for [editing](#editing-a-picture), and counts the endpoint's answer and the picture's arrival together. A setup saved before there was a limit has the default. When it runs out, the error names the limit and this setting. A slow or local model, or an edit of several pictures, may need more. |
| **Stable Diffusion extra settings** | A switch for the endpoint, for making and for editing, **off** by default. It says the endpoint is a **stable-diffusion.cpp** server, and lets the [Media page](/guide/media#stable-diffusion-settings) offer, under **Advanced**, and send, the settings only that server reads: a negative prompt, a seed, the sampler's steps and, for an edit, a strength and starting from noise. They go inside the prompt, in a `<sd_cpp_extra_args>` block, since the OpenAI image format has no fields for them. **Only stable-diffusion.cpp servers understand it:** any other endpoint takes the block as part of the description, so leave it off for those. Off, nothing of this kind is ever sent, however it came to be set. It is said of the endpoint, so it goes **off again when the generation address or the editing address moves to another server** (unless the same save switches it on), as **Several pictures per edit** does: the new server is not assumed to be stable-diffusion.cpp. Not for the agent's tools: they send none of these settings, on or off. Read at each request, so a change needs no reload. A setup saved without it has it off. While an address is typed and not saved, the switch waits for the save, as the other switches of the endpoint do. |

The request is `{ model?, prompt, n: 1, size?, output_format?, output_compression? }`, the fields
the OpenAI image format has, and a field the page was not given is left out. The answer's first picture is
taken from `data[0].b64_json`, or from `data[0].url` — an address, or a `data:`
URL. Other request and answer shapes are not translated; an endpoint that
speaks one needs a small adapter in front.

The address, model, size, time limit and key are read at each call, so changing them needs
no restart. Switching the tool on or off, though, is decided when a chat loads:
like the other features, a switch reloads the idle open chats, and a busy one
has it from its next step. The tool belongs to the
in-process agent (`EXECUTOR=host`), as `show_image` does.

### What the agent gets

`generate_image(prompt, title?, size?)` makes one picture, saves it, and shows
it. The picture is written to a `generated-images` folder inside the chat's
folder — the one place the page serves pictures from — under a name the portal
makes (`image-20261001-101500-a1b2c3.png`), never one the agent or the endpoint
chose, and never over an existing file. Its answer names the picture as a [file it gave](/guide/extension-ui#files-a-tool-gives),
with a title, as `show_image`'s does, so the chat draws the picture, in a preview
that holds its place while it is made (see
[Sessions](/guide/sessions#pictures-the-agent-makes)) and opens in the
[viewer](/guide/sessions#looking-at-a-picture) on a click, and voice mode opens
the Pictures window on it. The preview is Media's card for a call of
`generate_image`, and it goes by the tool's name, as every extension's card
does: another extension's tool of the same name is drawn with it too while
Media is installed. A failure — nothing configured, the endpoint's error, a reply that is
no picture — is an error result the agent sees and can pass on, never a
silent success.

The tool is a tool like the others: it can be switched off for a chat, a project
or everywhere in the tool menus and Settings → Tools, where it sits in Media's
group, `pithagoras-media`, with `show_image` and `edit_image` (and the video tools), and then the model does not
have it and the voice instructions say nothing of it either. Its name is
`generate_image`, which an image extension you installed may use too. pi keeps
the first tool of a name it loads, and Media's tools, which its server half
registers, load after those of pi's own packages, so then the other
extension's tool is the one the model has, Media's is left unused, and the
voice instructions do not mention it. Switch that extension off to use
Media's tool.

Only the primary user's conversations can have the agent make a picture: like
any tool that is not a plain read, it is refused in a conversation with a
teammate unless a [tool rule](/people/rules) allows it. Each picture can cost
money at a hosted endpoint.

### What is accepted

- **A real picture.** What the endpoint sends must be a PNG, JPEG, GIF or WebP
  by its first bytes, whatever it is called or served as. Anything else —
  an SVG, an HTML page — is refused and not kept.
- **A size and a time.** At most 20 MB per picture, and the [time limit](#the-endpoint)
  (five minutes unless set) in all for the endpoint to answer and the picture to arrive. Stopping the chat stops
  the request.
- **Where an address may lead.** When the endpoint answers with an address, the
  portal fetches the picture from it, which means fetching from a place the
  endpoint picked. Two kinds of place are allowed: the endpoint's **own host**
  (same scheme, name and port — it is the one you chose to trust, and a local
  server hands out its pictures itself, with the key if it needs one), and any
  host on the **public internet over https**, which is what a hosted provider's
  storage links are. Everything else is refused: another place on this machine
  or its network (`localhost`, `10.…`, `192.168.…`, `169.254.169.254` and the
  like), including through a name that resolves to one — checked where the
  connection is made — and including through a redirect, of which three are
  followed, each judged the same way. The key is never sent to a host other than
  the endpoint's own, and the endpoint itself is never followed to another place.

### Editing a picture

An `edit_image` tool: the agent changes a picture that is in the chat's folder
as it is told, and the result appears in the chat, and in voice mode's picture
window, as a generated one does. It is the same feature and the same endpoint
rules, with a switch of its own: an endpoint that makes pictures does not always
change them, so editing is opt-in apart from generation and says whether it is
available. While it is off, or has no address, the agent has no `edit_image`
at all, and the voice instructions say nothing of it. Generation and editing
do not need each other; one may be on without the other.

On the same page, under the generation settings:

| Field | Meaning |
| --- | --- |
| **Editing address** | Where edits go, with the same rules as the API address. The portal adds `/images/edits` unless the address already ends with it, and an address that ends with `/images/generations` is taken as the base, so the address saved for generation also does for editing. **Empty uses the API address above:** one server that does both needs no second address. |
| **Editing key** | Sent as `Authorization: Bearer …` to the editing address, and nowhere else. **Empty:** the key above goes along when edits go to the same server as generation (an empty address, or the same scheme, name and port), and no key goes to another server: a key belongs to the server it was given for. A saved key is never shown again, and a new address of another server without a key drops it, as for the key above. |
| **Editing model** | Sent as `model`. Empty sends none. It is never the model above, which may be one that only makes pictures. |
| **Maximum picture size** | The most pixels a picture sent to be edited may have, as `WIDTHxHEIGHT` such as `2048x2048`: the box it must fit, whichever way up it is (a `1024x2048` picture fits a `2048x1024` limit). Empty is no limit, as an empty size sends none. It applies to the picture, to each of [several pictures](#several-pictures) and to a mask, and is what an endpoint with a limit on its input needs; an edit comes out about as large as the picture it is made from. A picture beyond it is scaled down to fit: see below. Read at each call, so a change needs no restart. A setup saved before there was one has none. |
| **Image editing** | The switch of the feature, as **Image generation** is for making pictures: on the Media page, and for the `edit_image` tool being there at all (which chats get it is set in the tool lists). It needs an address, its own or generation's; like generation's it is decided when a chat loads, so a change reloads the idle open chats. |
| **Several pictures per edit** | Off by default. Switch it on only if the editing endpoint takes more than one picture in a request. Then `edit_image` is given a list of pictures instead of one, and the [Media page](/guide/media#changing-a-picture) takes up to eight (see [several pictures](#several-pictures)). **While it is off, an edit uses exactly one picture** — if the agent or the Media page seems to use only one of several, this switch is the first thing to check — and both say so (below). It is said of this endpoint: when edits move to another server (a new editing address, or a new generation address while editing has none of its own), it goes off again until you say the new one takes them. The tool's shape is decided when a chat loads, so a change reloads the idle open chats. |

The request is the OpenAI-style `images/edits` one: a `multipart/form-data` form
with `image`, `prompt`, `n` (always 1), `model` when there is one, and `mask`
when a caller gives one. The picture is sent under a neutral name (`image.png`,
with the type its bytes say), never under the name or the place it has in the
chat's folder. With [several pictures](#several-pictures) switched on, a request
of more than one picture has `image[]` once for each, in order (`image-1.png`,
`image-2.jpg`, …); one picture is always sent as `image`, whatever the setting. The tool sends no `size`, and the Media page only one that was set in its form: what an edit comes out as is the endpoint's to
say, usually the picture's own, and the size set for generation need not be one
an edit takes. The answer is read as a generation's is — the first picture from
`data[0].b64_json` or `data[0].url`, with the same rules for where an address may
lead, the same check of its bytes and the same limits (20 MB, and the one time limit
for the upload and the making together). Other request and answer shapes are not
translated.

`edit_image(path, prompt, title?)` reads the picture at `path` (relative to the
chat's folder, or absolute inside it), asks for the change, saves the result and
shows it. Its answer is the same as `generate_image`'s — the new picture's path
and a title — so the page treats it alike. A
failure — switched off since, a path that is no picture of the folder, the
endpoint's error, an answer that is no picture — is an error result the agent
sees and can pass on.

What was decided for it:

- **The original is never changed; the result is a new file, named after it.**
  It goes into the same `generated-images` folder generated pictures do, so that
  the work folder stays as it was, as `<name>-edited.<ext>`: `photo.png` becomes
  `photo-edited.webp` (the extension is the result's own type). A name that is taken
  gets a number, `photo-edited (2).png`, and a result is never put over a file.
  Editing an edit takes the mark off first, so a chain is `photo-edited (2).png`,
  `photo-edited (3).png`, not `photo-edited-edited.png`.
- **A failed edit leaves nothing behind.** The result is written only once the
  endpoint has answered with a real picture, and then as a new file is: beside its
  place first, and put there whole. A failure before the result is in hand —
  a picture that is refused, the endpoint's error, an answer that is no picture —
  leaves no file and no `generated-images` folder that was not there. (A disk
  that fails while the result is being written leaves no file either, and at most
  the empty folder.)
- **Only a real picture, only from the chat's folder, and not too large.** The
  picture to change must be a PNG, JPEG, GIF or WebP by its first bytes,
  whatever it is called, and at most 25 MB — the limit the Files panel shows a
  picture up to, which is more than a generated picture can be, so one the
  portal made can always be edited. A picture outside the chat's folder, or
  reached through a link that leads out of it, is refused, as for `show_image`.
  All of this is checked before anything is sent, so nothing that is not a
  picture ever leaves the portal. **A picture over the limits is scaled down
  to fit, not refused** (see below): the endpoint gets the picture that is in the
  folder if it fits, a scaled copy if it does not, and where its own limit is
  lower it says so in its answer, which is passed on without the key.
- **A picture attached to a message is not in the folder.** Pictures pasted,
  dropped or picked in the message box go to the model with the message and are
  kept beside the chat, not in its folder, so `edit_image` has no path for them.
  The tool's description says so: the agent tells you and asks you to put the
  picture in the chat's folder, or to change it on the
  [Media page](/guide/media#changing-a-picture), rather than guess a path or
  edit another picture. Taking attached pictures straight into an edit is not
  built.
- **A picture beyond the maximum size is scaled down to fit.** With a
  **Maximum picture size** set, a picture (or mask) with more pixels than it is
  scaled down by the portal before anything is sent: the largest size within the
  box, either way up, with its ratio kept and nothing cut, never up, and as it is
  seen (a photo held on its side is turned by its EXIF mark first). The kind stays
  what it was, PNG, JPEG, WebP or GIF, and so does transparency. A picture
  within the box is sent byte for byte. A mask is scaled with the first picture to
  the same size by taking the nearest pixel, so that it stays a mask; a mask of
  another size is not matched to the picture, but is scaled to the box on its own
  where it is over the box and made lighter where it is over the byte limit, and
  the endpoint says if the two differ. `edit_image` says in its
  answer what it did ("The image was scaled down from 4000x500 pixels (3 MB) to
  2048x256 pixels (180 KB) to fit what an edit takes."), so the agent can tell you the
  result is smaller; the result is not scaled back up. The Media page shows the
  same sentence as a warning above the form when a change it made had to scale or
  compress a picture, until you close it or ask for the next one. A picture whose size
  cannot be read is still refused, since it cannot be shown to be within the
  limit, and so is one that cannot be read as a picture at all: the message says
  "cannot be made to fit an edit" and "Nothing was sent", and with several pictures
  which one it is. The scaling is in the shared editing function, so every caller of
  it, not only the agent's tool, has the same behaviour and the same words.
- **No mask in the agent's tool.** A mask is a second picture of the same size
  with the area to change cleared, which an agent has no good way to make
  and which endpoints treat differently. The endpoint support in the portal
  does send one — checked as a picture by its bytes and size, sent as `mask` — and the
  [Media page](/guide/media#changing-a-picture) paints one with a brush; whether
  its size matches the picture's is for the endpoint to say.

The same rules as for generation apply to who may use it: the primary user's
conversations only, unless a [tool rule](/people/rules) allows it, and each edit
can cost money at a hosted endpoint. The tool is a tool like the others and can
be switched off in the tool menus and Settings → Tools, in the same group; another extension's tool of
the name `edit_image` is the one pi keeps, as for `generate_image`.

| | |
| --- | --- |
| Stored as | Media's own store (`image_generation` in its `media.db`), not pi's `settings.json`, which the Advanced tab shows in full. |
| API | [`/api/x/pithagoras-media/settings/images`](/reference/api#media) |

### Several pictures

Some endpoints take more than one picture in an edit: to combine subjects, to
keep a style or a person the same, to use a picture as a pattern. Others take one,
or fail on a list. So this is opt-in and off by default, with a switch of its own
under the editing settings (**Several pictures per edit**), and while it is off the
tool is exactly what it was: `edit_image(path, prompt, title?)` with one picture.

**While it is off** the agent is not left to guess: the tool's description says that the
editing endpoint is set up to take one picture per edit, and tells it, when you want several
pictures combined or used as references, to say so and to point you to this switch rather than
make the edit with one of them as if it were all. A call that gives a list anyway (a chat that
was loaded with several taken, a model that sends one) is refused before anything is sent, with
the count and the name of the switch: `The editing endpoint is not set up to take several
pictures, so none was sent (3 were given). …`. On the [Media page](/guide/media#changing-a-picture)
the form works with one picture, says that this endpoint takes one, and links to this setting.

Switched on, the tool is `edit_image(paths, prompt, title?)` instead: `paths` is a
list of one to eight pictures of the chat's folder, and one path is a list of one.
The agent is told how the pictures are known: **by their place in the list**. The
endpoint sees them in that order and nothing else about them, so the prompt says
"the person from the first picture, painted like the second". There is no label per
picture: the OpenAI-style form has no field for one, and putting one in the prompt
would change what the agent wrote.

The same call also makes **a new picture from references**. The route cannot tell
the two apart — the prompt does — so there is no second tool for it, and
`generate_image` stays as it is: `images/generations` takes no pictures, and an
agent with a reference picks `edit_image`. A single reference works with the
switch off, too; the switch only adds more than one. It needs editing switched on,
since the references go to the editing endpoint with its key.

What was decided for it:

- **Per endpoint.** The setting belongs to the editing endpoint, like its key: it
  is turned off again when edits move to another server, and a request that moves
  them and says it again in the same save keeps what it says. The endpoint is the
  editing address, or the generation address while editing has none of its own.
- **The same safety rules, for every picture.** Each is a PNG, JPEG, GIF or WebP
  by its first bytes, from inside the chat's folder only (not through a link out of
  it), at most 25 MB, sent under a neutral name, and never changed. The key stays
  in the portal and goes to the editing address only; the result is read, limited
  and written as for one picture.
- **On the Media page, too.** The page's form sends the same request for the same pictures: up
  to eight, in the order of the row, `image[]` once for each, with the same count, weight and
  [maximum size](#editing-a-picture) scaling per picture, and the same refusal for an endpoint that
  takes one. It adds ways to put the pictures in: several files at once, a drop, a paste, and
  ticking pictures of the gallery (see [Changing a picture](/guide/media#changing-a-picture)).
- **A count and a weight.** At most **8 pictures**, and **50 MB together** (25 MB each):
  all of them are held in memory and go up within the time limit of the request. More
  pictures are refused with the numbers. Pictures that weigh more are made lighter, never
  cut or dropped: at lower quality first, then smaller, the heaviest first and a light one
  left alone; a PNG with transparency becomes a WebP and one without a JPEG when it has to
  be lighter. A file of more than 25 MB is not read at all. The endpoint's
  own limit, if lower, is its to say, in its answer, which is passed on without the
  key. The count is also what the tool's list accepts, so the model is held to it
  before the tool runs.
- **One that is refused refuses the call.** A picture that is outside the folder,
  is no picture, is missing, or is too large, fails the whole call, before anything
  is sent, naming which one (`Picture 2 (style.jpg): …`). Leaving it out would shift
  the places the prompt refers to and make something other than what was asked, at
  the person's cost. Nothing is kept either: a failed call leaves no file and no
  `generated-images` folder.
- **Named after the first picture.** One result, as `<first>-edited.<ext>` in the
  `generated-images` folder, with the same numbering and the same cut by bytes as
  an edit's: `person.png` and `style.jpg` give `person-edited.webp`. The answer to
  the agent lists all the originals, in order, and the page shows the result as it
  does an edit's, in the chat and in voice mode.
- **Tool rules see each picture.** For a person the agent talks to for you, a
  [tool rule](/people/rules) for `edit_image` is matched against the path of the
  picture, as ever. With a list, **each picture's path** is matched, and the call
  is allowed only if every one is: a rule for `shared/*` allows a list of pictures
  in `shared/` and nothing with another picture in it, and neither the prompt nor
  another picture of the list can satisfy a rule meant for one. An
  [approval](/people/approvals) is for the pictures, not the prompt, as for one
  picture: the agent is told to ask with each picture's path on a line of its own,
  in the order of the call, and the refusal it got says exactly which. **Approve
  once** allows that call's pictures once, and **Always allow** writes one rule for
  each of them, for the person who asked.
- **A mask goes with the first picture** where a caller gives one, as for one
  picture; the agent's tool still has none.
- **The setting is read at each call.** A list is refused when the endpoint is no
  longer said to take it, and a path still does where the tool was loaded with a
  list. Only the tool's shape is decided when a chat loads.

## Video generation

**Settings → Extension settings → Media**, **Video model.** The video endpoint and the switch for **Video generation**. It is
built on the same pattern as [image generation](#image-generation), and takes the same trouble not to assume
one server or model: the address, the model and the key are yours.

Switched on, with an address, the [Media page](/guide/media) can make videos, and a chat's agent can have two
tools: `generate_video`, in which the agent describes a video (or gives a picture as its first frame), a video
model you set up makes it, and it plays in the chat; and `show_video`, which plays a video that is in the chat's
folder. Switched off, or without an address, there are no such tools at all, and the page says in its form
that it is not set up, with a link here. Whether a chat's agent actually has them is answered only in the
**tool lists** (Settings → Agent → Tools, a project's Tools, the tools control of a chat), where they sit in
Media's group, `pithagoras-media`, with the picture tools. The switch here does not decide it, and the Media page does not
look at those lists.

While it is on and has an address the sidebar has a [Media](/guide/media) page, with a form to make videos and a
gallery of everything made, here and in chats, together with the pictures.

### The video endpoint

There is no single standard for video generation yet, so how a video is asked for belongs to a **backend**, and
the jobs, the gallery, the page and the tool know nothing of it. There is one backend for now:
**stable-diffusion.cpp's server**, spoken to through its native job API. Nothing about one model is built in; the
server is started with the video model you choose.

| Field | Meaning |
| --- | --- |
| **API address** | The server's own address, such as `http://localhost:1234`, or `http://host:port/upstream/<model>` through llama-swap. The portal adds `/sdcpp/v1/…` to it; the address of the same server's image endpoint, ending in `/v1`, works as well. Only a stable-diffusion.cpp server works: an OpenAI-style `/v1` endpoint of another kind, or another video server, does not. No login, query or `#` in it: the key has its own field. |
| **API key** | Sent as `Authorization: Bearer …` to this address, and nowhere else, for a server behind a gateway that needs one. Left empty for a server that needs none. A saved key is never shown again — the page is only told that one is set — so leave the field empty to keep it, or choose **Remove the saved key**. Giving the address of another server without a key drops the saved one: a key belongs to the server it was given for. |
| **Model** | Sent as `model`. stable-diffusion.cpp's server runs the one model it was started with and ignores it; a gateway in front of it may choose a model by it. Empty sends none. |
| **Video size** | Sent as `width` and `height`, such as `832x480`, each side a whole number from 64 to 4096. Empty sends none (the server's own). The agent can ask for another size in a call. |
| **Frames** and **Frame rate** | How many frames a video has and how fast they play, used where a request does not say: whole numbers from 1 to 1000 and from 1 to 120. Empty is the server's own. A length in seconds, which the agent's tool takes, is worked out from the frame rate here, else the server's own, else 16. A server may round a count to one its model takes, and the video's details say how many it made. |
| **Time limit** | How long the portal waits for one video, in whole seconds, from the request to the file, the wait in the server's queue included: **1800** (half an hour) unless you set another, from 30 to 14400. When it runs out, the error names the limit and this setting; a video the server has begun goes on there. A setup saved without one has the default. |
| **Disk limit** | How many megabytes the videos made **on the Media page** may take together; empty is no limit. At the limit no new video is made on the page until some are deleted or the limit is raised. Nothing is ever deleted for it. The agent's videos are files in its chats' folders and are not counted. |
| **Video generation** | The switch of the feature, as **Image generation** is for pictures: on the Media page, and for the tools being there at all. Needs an address. |

A video is asked for as a job (`POST /sdcpp/v1/vid_gen` with `output_format: "webm"`), asked about until it is done
(`GET /sdcpp/v1/jobs/{id}`), and taken out of the answer as base64; see [Media](/guide/media#what-it-takes-from-the-endpoint)
for the fields and the steps. Before it sends anything the portal asks the server what it can do, so a server with
**no video model loaded**, or **built without WebM support** (a browser plays neither of the other formats it can make), says so in
plain words. Other request and answer shapes are not translated; an endpoint that speaks one needs a small adapter in front.

The address, model, size, frames, frame rate, time limit and key are read at each call, so changing them needs no
restart. Switching the tools on or off, though, is decided when a chat loads: a switch reloads the idle open chats, and a busy
one has it from its next step. The tools belong to the in-process agent (`EXECUTOR=host`), as
`show_image` does.

### The agent's video tools

`generate_video(prompt, title?, size?, seconds?, path?, lastFrame?)` makes one video, saves it and shows it. `seconds` is more than 0 and at
most 600. It is the picture tool's twin and keeps its rules: the video is written to a `generated-videos` folder inside the chat's folder under a name the
portal makes (`video-20261001-101500-a1b2c3.webm`), never one the agent or the endpoint chose, and never over an existing
file; nothing is written until the endpoint has answered with a real video, and a failure — nothing configured, the
server's error, an answer with no clip in it, the time limit — is an error result the agent sees and can pass on. `path` is a
picture in the chat's folder, which is the first frame of the video; it is read and checked as `edit_image` checks a picture,
and a picture outside the folder is refused. `lastFrame` is a picture to end the video on, read and checked in the same way; it goes only to a server that says it takes one, and the call fails with the reason where it does not. Whether the clip really ends on it depends on the model, which some ignore without saying so, and the tool's description tells the agent so, so that it reports the picture as asked for and not as reached. A picture only attached to a message is not in the folder, and the tool's
description says so. The call waits for the video and stopping the chat stops the wait.

Its answer is the video's path and a title, and the chat plays the video in Media's card for the call, which goes by the
tool's name: another extension's `generate_video` is drawn with it too while Media is installed. `show_video(path, title?)` plays a WebM or an MP4 of the chat's folder by what its bytes say, and nothing else. Voice mode
shows no videos: while the model has `generate_video`, the voice instructions say that a video is not shown in a spoken
conversation, only in the chat, and tell it to make one only when asked.

Only the primary user's conversations can have the agent make a video: like any tool that is not a plain read, it is refused in
a conversation with a teammate unless a [tool rule](/people/rules) allows it. A video can cost money at a hosted endpoint, and
always costs minutes of its model.

### What is accepted from the video endpoint

- **Nothing is refused for its format.** A finished clip is kept whatever it is (see [Clips a browser cannot play](/guide/media#clips-a-browser-cannot-play)):
  by its first bytes, whatever it is called or served as, a WebM (an EBML file whose document type is `webm` or `matroska`, which is
  what stable-diffusion.cpp writes) or an MP4 plays, and any other file — an AVI, an animated WebP, a GIF, an EBML file of another
  type, a file of no known kind — is stored as it is, listed as what it is and offered as a download, never shown.
- **A size and a time.** At most 100 MB per video, and the [time limit](#the-video-endpoint) in all. The video comes in one answer,
  as base64, so a long video is held in memory a few times over while it is decoded: the limit keeps that within reason.
- **No other place.** The portal asks the address you gave, and no address the server's answers name: the job is asked about by
  the id the server gave, on the address you gave, and a redirect is refused.

## Memory: Understory

**Understory** (`extensions/understory`, the package `pithagoras-understory`)
gives the agent [Understory](https://github.com/thecodacus/understory) as its
memory: a memory that grows, plain markdown on disk, cross-linked and
maintained, which the agent looks things up in and adds to through its tools
(`understory_memory_query`, `…_add`, `…_update`, `…_status`, `…_maintain`).
The bundle is human-readable and git-diffable.

Neither Understory nor [Docker](/guide/docker), which it requires, is installed
by default: install them from **Settings → Extensions → Discover → Comes with
Pithagoras → Understory**, which installs Docker first
([Installing what it requires](/guide/extension-ui#installing-what-it-requires)).
Its page is **Settings → Extension settings → Memory**
(`/settings/x/pithagoras-understory`), and its **Memory** page is in the
sidebar's **Extensions** group. A portal that ran Understory before it was an
extension handed what it kept over to it: see
[Upgrading](/guide/upgrading#understory-is-an-extension).

A [project](/guide/projects#an-agent-for-a-project) can do without it: its **Understory
as memory** switch is off, and its chats are neither told about Understory nor have it
instead of the agent's `MEMORY.md`. Home keeps it, and so does a project with an agent unless it is switched off; a blank-slate project has no agent and so no Understory.

### Running it here

With Docker access (see [Giving the portal Docker](/guide/docker#giving-the-portal-docker)),
Understory runs in a container of its own (`pithagoras-understory`), made
through Docker, with its memory in a volume (`pithagoras_understory-memory`). On
its page, **Run it here**:

- **The model that keeps the memory.** Understory uses a model to file, link
  and tidy notes. By default **the chat's model**: the one the chat calling its
  tool is on, already loaded, so writing with one model does not load another
  for the memory. Understory is pointed at a model server the extension runs
  on the portal's own loopback (`127.0.0.1:3801`, `UNDERSTORY_LLM_PORT`), with
  a key of its own, and the extension passes each request on to that chat's
  model, with its address and key. With no chat asking — tidying up at night —
  the one that asked last, and before any has, the default model for new
  chats. It takes a model with an OpenAI-compatible API (local servers,
  OpenRouter). Where that port is taken by something else, the chat's model is
  not offered, and the page says so: set `UNDERSTORY_LLM_PORT` to a free one.
  An Understory made for the chat's model is stopped then, and not started
  again until the model server listens, since what it sends would go to
  whatever holds the port.
  For another API, give Understory a model of its own: *a provider set up
  here* — one and one of its models, its address and key taken from the
  provider each time Understory starts — or *an address of its own*: the API
  address, a key (none needed for a local server), a model and the format
  (OpenAI-compatible or Anthropic). A saved key is never shown again; leave the
  field empty to keep it.
- **Tidying up.** How often Understory goes over the whole memory on its own —
  merging duplicates, linking orphans, splitting notes grown too long (its
  "dreaming"). One of three: **never** (the default); **at a time of day** —
  every day at, say, 03:00 when nobody is using the model, in the portal's
  time zone, started by the extension while Understory runs, with Understory's
  own timer left off; or **on an interval** — every hour, 6, 12 or 24 hours
  or week, Understory's own timer, which counts from when it starts, so
  saving begins the count anew. Never both. Each pass costs tokens, and does
  nothing when the memory is already tidy. **Tidy up now** runs a
  pass at once, and the last one's outcome is shown beside it.
- **Install and use as the agent's memory** pulls the image the first time,
  starts it, and switches it on as the memory. Then **Stop / Start**,
  **Remove** (the memory stays in its volume) and **Remove and forget the
  memory** (deletes the volume; asked first).

Understory reads its model and interval only when it starts, so **Save and
restart Understory** makes its container again with the new ones; the memory
is untouched. Understory has no way to be asked for a pass, so at a set time
the extension runs the very pass its timer runs, inside its container with its
own settings (Docker's `containers.exec`). It runs on the portal's own network
(Docker's [`sharedNetwork()`](/guide/docker#a-container-on-the-portal-s-network)),
so a model server the portal reaches on `localhost` is reached the same way.
When the portal's container is made again, as a Compose update does, the
extension makes Understory's again on the new one within half a minute, with its
memory and its token. It is given a token of its own (`AUTH_TOKEN`), which the
extension writes into the agent's MCP entry and uses for the Memory page; nothing
else can read the memory through it.

Removing or switching off the extension in Settings → Extensions leaves the
container as it is: it is made to restart with Docker (`unless-stopped`), and
stays listed under `pithagoras-understory` in **Settings → Docker**, where it can
be stopped or removed. Remove it on its page in Settings first to have it
go. The agent's MCP entry stays in `mcp.json` too, until it is switched off.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNDERSTORY_PORT` | `3800` | The port the Understory run here listens on. |
| `UNDERSTORY_VOLUME` | `pithagoras_understory-memory` | The volume that holds its memory. |
| `UNDERSTORY_LLM_PORT` | `3801` | The port on the portal's loopback (`127.0.0.1`) where the extension's model server listens for Understory, in the chat's model mode. Understory's container is told it when it is made, and made again with a new one as the extension starts after a change. |
| `UNDERSTORY_LLM_HEADERS_TIMEOUT_MS` | `1800000` | How long, in ms, to wait for the model's answer — until its headers arrive — before it is given up on and said so as a timeout; an answer that does not stream (what Understory gets today) sends no byte until it is done, so this covers the whole of it there. `0` sets no wait. |
| `UNDERSTORY_LLM_BODY_TIMEOUT_MS` | `1800000` | How long, in ms, a streaming answer may go quiet between its bytes before it is cut off. `0` turns the wait off. |
| `PORTAL_FETCH_HEADERS_TIMEOUT_MS` | `1800000` | A ceiling of quiet, not of work: how long, in ms, any fetch the portal's process makes — pi's MCP tool calls among them — may wait for an answer's first byte before it is cut off; Node's own fetch cuts one off after five quiet minutes. The default outlasts Understory's own model wait, so a run allowed to think half an hour is not cut off mid-thought by the client waiting on it. `0` sets no wait. |
| `PORTAL_FETCH_BODY_TIMEOUT_MS` | `1800000` | How long, in ms, a streaming answer to such a fetch may go quiet between its bytes before it is cut off; an answer that keeps moving is never cut by these waits. `0` turns the wait off. |

Without Docker access, or to keep running your own, see
[Running your own](#running-your-own).

### Reading the memory

While Understory is on, **Memory** appears in the sidebar's **Extensions** group.
Its page is laid out as Understory's own:

- down the side, the memory's folders and notes, each with its type, and
  Understory's own `index.md` and `log.md` set apart; a search; and whether the
  bundle is well-formed (*conformant*, or how many issues — which lists them);
- beside it, the open note — its type, tags, when it last changed, its text,
  and links to other notes that open them there — or the **Log** of changes,
  newest first, or the **Graph**: every note as a glowing point coloured by its
  type in space, its links as see-through lines, in five looks, the paths
  Understory's own runs took (lit in the graph when you point at one), and zoom,
  drag and click to open.

What is open is in the address (`/x/pithagoras-understory/memory?note=…`,
`?view=log`, `?view=graph`, `?view=chat`), so it can be linked to. The page and
its [librarian](/guide/memory#memory) are described under
[Memory and audit](/guide/memory).

### Changing a note by hand

In the Understory the portal runs, a note can be **edited** — its title, type,
description, tags and text — or **deleted** (asked first), from the pencil and
bin over it. Understory's own index.md and log.md are its to write, and are
not offered. The change goes through Understory's own write path, run in its
container like the tidy-up, so its index and log follow it; Understory has no
API that writes. One run elsewhere is read only here.

A change by hand can leave something behind: a link to a deleted note, a note
nothing links to any more, an index that misses something. So after each one a
window says what Understory's checks find now, and offers the two ways to put
it right:

- **Rebuild the index** writes every folder's index.md anew and removes empty
  folders — no model, a moment.
- **Repair with the model** runs Understory's own pass over the memory (the
  tidy-up): it mends links, wires in notes nothing links to and merges what is
  doubled. It takes as long as the model needs, and costs tokens.

Or leave it; the nightly tidy-up, if set, gets to it as well. **Repair with
the model** is offered only when there is something to repair, and the model is
not asked otherwise; the tidy-up the portal starts skips an empty memory too.

**Clear the log** (in the Log) empties the record of what changed and the
paths Understory's queries took; the notes stay. **Clear the memory** (the bin
beside the heading) starts the memory from nothing: every note and folder
deleted, the index and log as a new memory has them, and Understory started
again so it holds nothing of what was there. Both ask first, and cannot be
undone. (**Remove and forget the memory** on its page in Settings removes
Understory as well.)

The portal asks Understory for all of it, at the address in `mcp.json` and
with its token, so the page works wherever the portal does: over HTTPS, from a
phone, without Understory's port being reachable from the browser. It reads the
small JSON API Understory's own web UI uses (`/api/tree`, `/concept`,
`/search`, `/log`, `/graph`, `/traces`, `/validate`), which is not a
documented one: should a new Understory change it, the page says what went
wrong instead of showing an empty memory.

### Switching it on and off

Switching it on:

1. installs `pi-mcp-adapter` if it is not installed yet, which makes MCP servers
   into tools;
2. writes an `understory` server into `mcp.json`, with its tools directly in the
   agent's tool list — the Understory run here with its token, or the
   address given;
3. counts what its server says as your own words, so the guard neither marks
   nor checks it: it is added to the trusted MCP servers in **Settings → Guard**,
   where you can take it out (see [Prompt injection](/guide/security#marking-untrusted-output));
4. stops reading `MEMORY.md`.

Switching it off removes the server, takes it out of the trusted servers again,
and `MEMORY.md` is read again. Removing the Understory run here switches it off
too.

### MEMORY.md while it is on

Understory **replaces** the agent's global memory, so the two do not both feed
the agent: while the `understory` server is in `mcp.json` and not disabled,
`MEMORY.md` in the agent's home is not handed to new chats, and the agent is
told to use its memory tools instead. The file is not deleted, and it is marked
as not read on the Agents page. Disabling the server in Settings → MCP counts as
off too.

Only conversations with the primary user ever had `MEMORY.md`; a teammate's
conversation cannot use the memory tools unless a rule allows it (see
[Roles](/people/roles)).

### Running your own

Understory can also run anywhere the portal reaches, set up by you; the portal
then only points the agent at its MCP address (*Or use one you run yourself*
on Understory's page in Settings, which needs the extension installed all the
same). Its model and tidying up are then set in its own
environment — `LLM_*` and `DREAM_INTERVAL`, which the portal cannot change.

```yaml
services:
  understory:
    image: ghcr.io/thecodacus/understory:latest
    ports: ["3800:3800"]
    volumes: [understory-memory:/bundle]
    environment:
      BUNDLE_ROOT: /bundle
      LLM_API_BASE_URL: ${LLM_API_BASE_URL}
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_API_FORMAT: openai
      LLM_MODEL: ${LLM_MODEL}
      # DREAM_INTERVAL: 6h
      # AUTH_TOKEN: ${MEMORY_UNDERSTORY_AUTH_TOKEN}
    restart: unless-stopped
volumes:
  understory-memory:
```

The address is what the **portal** reaches: `http://localhost:3800/mcp` with
the shipped compose file's host networking, or `http://understory:3800/mcp` on
a shared Docker network. It can be changed on Understory's page in Settings.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORY_UNDERSTORY_URL` | `http://localhost:3800/mcp` | The address Understory's page in Settings starts from. |
| `MEMORY_UNDERSTORY_AUTH_TOKEN` | — | Sent as `Authorization: Bearer …` when Understory has an `AUTH_TOKEN`. Named in `mcp.json` (`bearerTokenEnv`), never copied into it. |
