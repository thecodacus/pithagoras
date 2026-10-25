# Sessions

A session is one conversation with pi, its own model and effort level, and the
folder it works in. It is the normal unit of work in the portal.

## Where a session works

**New** starts a chat with the agent picked for new chats, in **Home** (the first
agent's own directory) by default; a chat in a
project works in that project's folder, and a chat with another agent in that
agent's home. See [Projects](/guide/projects) and [Agents](/guide/agents). The session is named after its
first message, and you can rename it.

Paths are validated server-side: a workspace must resolve inside the workspace
root, so a session cannot be pointed at the rest of the filesystem. Deleting a
session never deletes its folder.

## Giving it a task

Type and send. The request returns as soon as pi accepts the message — it does
not wait for the work to finish. Close the tab if you like.

While a run is in progress you can keep typing. Words sent mid-run steer it: the
agent takes them in after the step it is on, instead of when the whole run is
over. Until then the message sits in the transcript marked *Waiting — goes in
after the current step*. While it waits it can be changed: press ↑ in an empty
box to take the latest waiting message back into the box (with its pictures) and
send it again when you are done, or use the buttons under it to delete it or to
**send it directly**, which stops the run and sends that message at once, with
the others still waiting going in behind it in their order. Once the agent has
taken a message in, it can no longer be taken back. A message that did not get that far — the run was
stopped, or the portal restarted, before the agent took it in — says so and has
a button to send it again. **Stop** aborts the current run, and pressed while pi
is still starting for a message, it keeps that message from being sent at all:
the message comes back as not sent, rather than being answered seconds later. In
[voice mode](/guide/voice#pictures-tool-cards-and-controls) what you say stops
the task by default, and its settings have a switch to add it to the running task
instead.

## The message box

What you have typed and not sent stays with its chat. Switching to another chat
gives you that chat's box, and coming back gives you yours again — it survives a
reload too, for as long as the tab is open. Nothing typed in one chat can be
sent from another by accident.

A message that does not go — the portal is unreachable, or refuses it — goes back
in the box, in front of anything typed since, with the reason shown above it.
Nothing is thrown away to be typed again.

### Pictures and files

Paste a screenshot into the box, drop pictures on it, or pick them with the
paperclip, and they wait above the words as thumbnails — the × takes one back
out. They go to the model with the message, up to eight of them, and a message
can be a picture alone. The sent message shows them; click one to
[look at it in the viewer](#looking-at-a-picture).

The model sees them, but they are not files of the chat's folder, so the agent's
[`edit_image`](/guide/features#editing-a-picture) cannot change them: put a picture
in the folder with the Files panel for that, or change it on the
[Media page](/guide/media#changing-a-picture).

A photo straight off a phone is made smaller in the browser before it goes:
2048 pixels on its longer side, as a JPEG. Models scale anything bigger down on
their side anyway, so those pixels would only cost upload time and context. A
picture that already fits goes as it is, and a GIF always does. PNG, JPEG, GIF
and WebP are taken; each must be under 5 MB once made ready.

If the model cannot see pictures, pi leaves them out and tells it one was there,
and the chat says so in a line above the answer — pick a model that takes images
and **Retry**. Whether a model takes them is the `input` of its entry in
`models.json` (`["text", "image"]`).

Anything that is not a picture — a PDF, a spreadsheet, a zip — is put in the
chat's folder instead, and the box gets a line naming it, so the agent knows to
look. A name that is taken there gets a number (`report (2).pdf`); nothing is
replaced. The agent has the tools for those files; the model on its own does not.

Pictures waiting in the box stay with their chat like the words do, but only
while the page is open: they are not kept across a reload.

Two keys work from anywhere on the page:

| Key | Does |
| --- | --- |
| `/` | Jump to the message box with the command list open. Not while you are typing somewhere else, where it is a character. It is the [command character](/guide/commands#the-command-character), so it is another key if you chose one |
| `Esc` | In the message box, **stop the run**, whatever is typed: the words stay in the box, so it costs you nothing. Not while an input method is composing a word, and not while the command list is open, where it closes the list |

## Modes

A mode is how a chat works. A chat that has said nothing yet shows its mode
on a chip above the message box, where it is offered more than one; the chip
opens a menu with each mode and a line on what it does, and the chosen one is
checked. Choose before the first message: from then on the chat keeps it.

- **Standard mode** is the agent as the chat would have it anyway: the tools
  that [Settings → Tools](/guide/extensions#and-what-every-chat-starts-with), its agent and its project
  switch on. Every chat starts in it.
- **Code mode** gives the model one tool, `codemode`, pi's
  [code mode](/guide/extensions#code-mode): it writes a short JavaScript script
  that calls the chat's tools, and is given only what the script puts out. The
  other tools are not offered to the model one by one (pi's `only`
  presentation): the code tool's description lists them, and a script calls
  them. Every tool that is on in the chat is in a script's reach. Lazy marks do
  not apply here, since nothing is offered one by one anyway: a script finds the
  tools that do not fit in the description with `searchTools`, and the `tools`
  tool is not offered. An MCP server whose tools are not registered one by one
  stays behind the adapter's `mcp` tool, which a script calls like any other.
  A script has no time limit; **Stop** ends it. The
  [guard](/guide/security#marking-untrusted-output) holds each call a script
  makes as it holds the model's own. In the chat's tools, `codemode` is on and
  its switch cannot turn it off, with a line that says why: to work without the
  code tool, start a chat in Standard mode. The other switches work as in any
  chat.
- **An extension's modes** come last, after the portal's own and
  [yours](#modes-you-make): an installed extension can offer modes of its own,
  and what such a mode does is the extension's
  ([Chat modes](/guide/extension-ui#chat-modes)). One that asks first is shown
  in the warning colour, and is chosen only after you say yes to its warning,
  which [Audit](#audit) keeps as *Mode chosen*. A chat in the mode of an
  extension that is switched off or removed keeps its mode, shown as not
  available, and works without what the extension gave it until the extension
  is back. [Creator mode](/guide/creator-mode), which comes with the portal, is
  one that asks first: in it the agent writes extensions and installs them.

The mode is fixed once the chat has said something: its first message, or a
command sent to pi. Leaving a mode means starting a new chat; `/new` and
`/clear` start one in Standard mode. A chat whose every message was removed has
said nothing again, and its mode can be chosen again. Changing it before then
lets the chat's pi go if one was started (opening the model menu starts it), so
that the first message starts it again in the mode chosen; nothing is lost, as
the chat has said nothing. A subagent the chat starts does not take its mode.

Modes are offered in the chats you start on the portal's pages, and in the
conversations started on an agent's page, where pi runs in the portal's own
process. A routine's run, a heartbeat, a chat that came through a channel and
a chat a colleague speaks in have none, and a portal started with
`EXECUTOR=container` offers none.

Once the chat has started, the chip goes, and the chat's header shows its mode,
with its line when you point at it. Standard mode shows nothing there. A mode
that is not offered now is named by the last part of what the chat stores, and
says it is not available now when you point at it.

### Modes you make

You can make modes of your own in **Settings → Modes**, or with **New mode…**,
the last row of the menu above the message box, which opens that page over the
chat. The menu offers yours after Standard and Code mode, by their names. A
chat in one stores `custom/` and the id the mode was given from its first name;
naming it again later keeps the id.

A mode of yours has:

- **Name** and **Description**: what the menu shows. **Instructions**: said to
  the agent in the system prompt of every chat in the mode, after the portal's
  own rules. The three are saved with **Save**.
- **Model** and **Effort**: written into a chat as it is put in the mode, so the
  chat starts on them; the chat can still change them with the pills under the
  message box. The provider and the model are written together, once a model is
  chosen; left as **As the chat would have it**, nothing is written. Choosing
  another mode before the first message puts back what the mode wrote, unless
  you changed it in the chat since.
- **Work through the code tool**: its chats work as in Code mode, the code tool
  alone offered to the model. Switching it on switches the code tool on in the
  mode's tools too, and switching it off takes that back: the code tool is then
  as Settings → Tools, the chat's agent and its project leave it.
- **Tools**: what every chat in the mode starts with, one more tool layer. It is
  held against [Settings → Tools](/guide/extensions#and-what-every-chat-starts-with)
  and comes above a chat's agent, project and routine, so a tool the mode leaves
  as Settings → Tools has it is still decided by them: a mode cannot switch on,
  over a project, a tool that Settings → Tools has on. A chat's own switches are
  still the last word, but where the mode switches the code tool on, they cannot
  switch it off, as in Code mode.

These are saved as they are changed, except the texts.

An edit reaches the chats already in the mode as follows: its tools and its
instructions at once, from their next message; whether it works through the
code tool when each chat's pi next starts, since which tools are offered one by
one is fixed then; its model and effort never, as they were written into each
chat when it was put in the mode. The code tool that switch also switches is one
of the mode's tools, so it reaches the running chats at once: where it goes off,
a chat that worked through it works as in Standard mode from its next message.

Deleting a mode asks first. Its chats keep it, and their header says it is not
available now; they work as in Standard mode from their next message. A new mode
of the same name gets another id, so it does not take them over.

With `EXECUTOR=container`, Settings → Modes says that tools cannot be switched,
as Settings → Tools does.

## Questions from the agent

When the agent cannot go on without a decision or a fact only you have, it uses
its `ask_question` tool: its questions appear in the chat, just above the
message box (not over the page, so the rest of the chat stays usable), and the
agent waits for your answers. A question is one of four kinds: **choose
one**, **choose several**, **free text**, or **put the options in order** (best
first, moved with the arrows; they start in the order the agent listed them,
and that order only counts as your answer once you have moved something or
pressed **Keep this order**). A question the agent asks without options is
answered in free text.
A choice may also take an answer of your own when the agent allows it, and a
question marked *optional* may be left empty. **Submit** is available once every
other question is answered. **Cancel** puts the questions away, and the agent
is told that you did not answer.

The agent waits for as long as it takes: there is no time limit by default. It
ends when you answer, when you cancel, or when you press Stop in the message
box, which also takes the questions away in every window that has them. If you
would rather the agent carries on by itself after a while, **Settings → Tools →
Questions from the agent** sets a limit of 5, 15, 30 or 60 minutes. The portal
keeps a question with its chat until it ends: after a reload, a visit to
another chat or a restart of the portal it is there again. Answered while the
portal restarts or after, your answers reach the agent as a new message once the
portal is back. Once it ends, the chat
keeps a short record of it where it was asked: each question and your answer,
or that it was cancelled or not answered in time.

The tool exists wherever you answer in the portal's own pages: in your chats,
and in the conversations you start on the Agent page. It does not exist in a
routine, a heartbeat or a chat reached through a channel, where nobody could
answer in the web UI: there the agent asks in plain text, and the person
answers with their next message. It is in the tools list like any other, in a
group named `ask-question`, and can be switched off there.

## Looking at a picture

What a call gives you is drawn under its tool line, in the middle of the
conversation, with the same room above and below: a picture (from `show_image`,
or from any tool that [gives one](/guide/extension-ui#files-a-tool-gives)), a
clip in its player, and any other file as a link that saves it. A picture the agent
makes with `generate_image` or changes with `edit_image` has no tool line: it is
the [preview](#pictures-the-agent-makes) that held its place while it was made,
in the middle of the conversation as well. A very wide or very tall picture is
smaller there, never cropped: the viewer shows it whole. The pictures you sent
are in your message.

A click or a tap on any of them opens it **in the viewer**, over the chat,
fitted to the screen on a calm backdrop. The chat stays where it was: nothing
opens in a tab of its own. The viewer covers the whole window, whatever panels
are docked beside the conversation, and does not move them.

- **Closing it.** The × button, `Esc`, a click beside the picture, or the
  browser's **back** button — on a phone the way out, which here closes the viewer
  and does not leave the chat. Focus returns to the picture it was opened from,
  or to the one shown last.
- **Looking closely.** The wheel and a pinch zoom in on the spot they are over;
  a double click or double tap goes between the whole picture and its own size,
  one screen pixel for one of the picture's; a drag moves a zoomed picture. The
  buttons at the bottom do the same and say how far it is zoomed (`+`, `-` and
  `0` on the keyboard). A picture smaller than the screen is shown at its own
  size, not enlarged.
- **Several pictures.** The arrows at the sides, `←` and `→`, or a swipe go
  through every picture of the conversation in the order they came, the ones you
  sent and the ones the agent showed, with the place in them at the top left.
- **Its title.** What the agent called the picture is shown under it.
- **An edit and what it came from.** When a picture was changed with
  `edit_image` and the original was shown in the conversation too, **Original**
  and **Edited version** at the top go from one to the other. For an edit made
  from several pictures, the original is the first of them.
- **The file itself.** The two icons at the top open the picture in a new tab or
  download it. That is the only way a picture opens in a tab, and it is on purpose.

The viewer is a dialog: the keyboard stays inside it (`Tab` goes round), and the
page behind it does not scroll. It opens as quietly as every dialog does, and with
**Settings → This browser → Animations** on it swings up out of the page and sinks
away when it closes; with reduced motion asked for by the system it does not move
at all (see [Animations](/guide/interface#animations)). Voice mode's Pictures
window is its own place and works as before.

## Queued channel messages and questions

Channel messages wait for the current run to finish before applying a new
speaker or role. Pending notes are included when that queued turn starts and
are removed only after pi accepts the prompt. A failed startup leaves the
notes available for the next attempt.

When an extension asks a question, submitting a response closes the dialog only
after the server accepts it. If submission fails, the dialog stays open with an
error so you can retry or dismiss it. A timeout or cancellation resolves the
original question; it does not cancel a newer question that has replaced it.

## Sent messages

Hovering one of your messages gives it these actions:

- **Copy** puts the text on the clipboard (a message that is only pictures has none to copy). The agent's replies have the same
  button, once they are whole. It works over plain HTTP too, where browsers
  withhold the clipboard API, by falling back to the older way.
- **Retry**, on your last message, drops the agent's reply to it — a half-finished
  one after a Stop, say — and sends the same text again. It is editing without
  changing a word, so the agent's memory ends up as if the first attempt never
  happened rather than holding it and a second copy of the question. Pictures
  that went with it go again.
- **Send again**, on an older message, sends its text and pictures as a new
  message at the end. Retrying one of those would drop everything since. While a run is going
  it queues, like anything else you type.
- **Edit** rewrites the message in place. It replaces that message *and
  everything after it* — the agent's answers were to a question that is no
  longer the same one — and sends the new text, with the same pictures.
- **Delete** removes the message and the agent's answer to it, tool calls
  included, and leaves the rest of the conversation as it was.

Edit and delete change what the agent remembers, not just what the page shows:
pi's own record of the conversation is edited too, and the agent's next turn
reads the version without the message. They are unavailable while a run is in
progress, so stop it first.

They do not undo what the agent *did*. Files it changed, commands it ran and
messages it sent stay as they are; only the memory of having done them goes.

Some cases are refused rather than guessed at, with a message saying why. A
message that a compaction has already folded into its summary cannot be deleted
on its own, since the summary would go on describing it — edit it instead, which
drops the summary with everything after. A conversation with branches from pi's
`/tree` cannot be trimmed cleanly either. A message is only matched to the agent's
record by its exact text (or as a voice turn), never by a fragment of it. Nothing
is changed when this happens.

An edited message, or one sent again, keeps the version it replaced. Where there
are several, a small `‹ 2 / 3 ›` switch beside the message shows another one —
the message and what followed it at the time. Switching, like editing, is only
possible while nothing is running.

If an edit's replacement is refused — the model is unreachable, say — the
conversation is put back as it was, rather than left without the messages the
edit meant to replace.

## Pictures the agent makes

With [image generation](/guide/features#image-generation) on, a `generate_image`
or `edit_image` call is not shown as a tool line but as the picture itself, from
the moment it is asked for. These are [Media](/guide/media)'s cards, there while
it is installed:

- **While it is made**, a frame in the shape of the coming picture holds its
  place: the size the agent asked for, or, for an edit, the shape of the picture
  being changed (the first, when it was given several), which is shown under the
  wait; a square when nothing says. It
  says "Making a picture" or "Editing a picture" and, after a few seconds, how
  long it has taken; over the picture of an edit, both words and seconds sit on
  a plate of the theme's own colour, so that they read on a bright picture as
  on a dark one. Image endpoints do not report how far they are, so the
  animation does not pretend to: a soft light drifts over the frame and a sheen
  passes, and that is all.
- **When the call is over**, the wait is over too: the frame says "Loading the
  picture", still, until the file has come, however long a large picture over a
  slow connection takes, and the picture is fetched at once rather than when
  the browser sees fit. The picture then fades in over it, in the same place.
  Where the shape was right nothing under it moves; where it was not, the frame
  takes the picture's own shape. A click opens it in the
  [viewer](#looking-at-a-picture), with the conversation's other pictures to
  step through; the file is the one the preview has loaded, not fetched again.
  If the file cannot be fetched, it says so, and not that the picture is gone.
- **When it fails**, the frame says so quietly, with the reason in a line or
  two — the endpoint's answer, a setting that was switched off — and the whole of
  it under **Details**. A call that was cut off, because the run was stopped or
  the portal restarted before the picture came back, says it was interrupted.
- **The call itself** — the tool's name and what the agent gave it: the prompt,
  the title, the size, the picture to change — is under **Details**, below the
  picture.
- **Opening a chat again** draws the pictures that were made at once, with no
  fade, in the shape asked for when the agent asked for one and otherwise
  taking their own as they load; one whose file is gone from the folder says so.
- **A tool of the same name** that another extension brings is drawn the same
  way while Media is installed: a card goes by the tool's name, as every
  extension's cards do, not by which extension the tool is from.

The movement is one of the [animations](/guide/interface#animations): with them
switched off, or when your system asks for reduced motion, the frame is the same
and still, with the same words, and the picture simply appears. Only a picture
being made, or just arriving, moves, and only as layers of the frame slide —
nothing is laid out again — so several in a long chat cost nothing once they
are made. In
[voice mode](/guide/voice) the card of such a call carries the same preview as a
small tile.

Every picture the agent makes this way is also in the [Media](/guide/media) page's
gallery, from the moment it is saved, with the chat it is from, what it was asked for
and how it was made. The page can open it, change it, make it again, and delete the
file — which is the chat's, so that asks every time. What lies in these folders and was
never listed, such as pictures made before the gallery existed, is found there too, as a
picture of the folder.

## Videos the agent makes

With [video generation](/guide/features#video-generation) on, a `generate_video` call is not shown as a tool line
either, but as the video from the moment it is asked for. A video takes minutes, so the wait is the main thing:

- **While it is made**, a frame in the shape of the size the agent asked for (a square when nothing says) holds
  the place, says "Making a video" and, after a few seconds, how long it has taken. Nothing in it pretends to know how far the
  server is.
- **When it is made**, the browser's own **player** takes the frame's place, with the title under it: play and pause, the slider, the
  volume and full screen. It does not play by itself, and only the start of the file is fetched until you play it, which shows its first frame; the
  rest comes in the parts the player asks for. The portal serves it from the chat's folder, by its path, and only what its bytes say is a WebM or an MP4.
- **When it fails**, the frame says so quietly, with the reason in a line or two, and the whole of it under **Details**. A call that was
  cut off, because the run was stopped or the portal restarted before the video came back, says it was interrupted.
- **The call itself** — the tool's name and what the agent gave it: the prompt, the title, the size, the length, the first frame — is
  under **Details**, below the player.
- **A video the agent shows** with `show_video` is a player under its tool line, in the middle of the conversation as a picture is. One
  whose file is gone from the folder says so.
- **A tool of the same name** that another extension brings is drawn the same way while Media is installed: a card goes by
  the tool's name, not by which extension the tool is from.

[Voice mode](/guide/voice) has no window for videos, and while the agent has `generate_video` its voice instructions say so: a video
is for the chat, and is made only when asked. Every video the agent makes this way is also in the [Media](/guide/media) page's gallery, from the moment it is saved.

## Drafts and what is running

What you have typed into a chat's box and not sent is kept per chat, so half a
message does not follow you into the next chat, and survives a reload of the
page (in the browser's session storage, so not a new browser). An extension that
asks for what is in the box is told it.

Above the box, a small tray lists what runs beside the conversation: what an
extension has going in the chat (the [subagent extension](/guide/features#watching-a-subagent)'s
subagents at work, say; other tools, such as code mode or a web search, are not
listed and show their output on their own card), background jobs the agent left
running, and the status lines extensions set. Each opens its own window — see
[Subagents and background jobs](/guide/extensions#subagents-and-background-jobs).
A status that names one of the chat's slash commands runs it when clicked. The
tray is not there while nothing in it is.

## Sidebar and the sessions page

The sidebar opens with New, then the places — Sessions, Projects, Agents,
Routines and [Audit](#audit), and the
pages of extensions in a group of their own, **Extensions**, before Audit
([Media](/guide/media)'s while an image endpoint or a video endpoint is set up,
[Browser](/guide/browser)'s while there is a browser, Memory while
[Understory](/guide/features#memory-understory) holds the agent's memory) — then **Pinned**, then
**Recents**. The button at its
top edge folds it to a rail of icons. A chat's full path is not drawn in the list: the folders (below) name where it works, and the Files panel shows the path on request. Recents is capped at twelve; anything past that is reachable from
the Sessions page, which lists everything with a search of its own.

Pinning is stored server-side and drives the ordering (`pinned DESC,
updated_at DESC`), so the sidebar and the Sessions page never disagree.

With more chats than the sidebar lists, it has a search field above them. It looks
through every chat by its name, and by its folder's name where the chats are gathered by
folder (below), not only the ones shown, and Escape clears it. A pinned chat is found by
its name only, as its row shows no folder. It never goes by a chat's path. The Sessions page has the same search with more room; in its
list of all chats, each row names the folder it works in.

### By folder

Once there is a project or more than one agent, the chats below **Pinned** are
gathered by the folder they work in: each agent's home, named after the agent, and each project, a
chat in a project's subfolder counting as the project's. Each folder opens to show its chats — the sidebar up to eight,
then *N more in …*, which opens the Sessions page at that folder — and remembers
whether it was left open. The folder of the chat you open is opened for you. A
project without chats is there all the same, and the **+** on a folder's line
starts a chat in it. A project folder made or removed outside the portal — by
the agent, say — shows up or goes within half a minute.

The Sessions page lists them the same way, every folder open to begin with, and
the funnel on a folder's line shows that folder on its own (`/sessions?folder=…`,
so the link keeps it); the ✕ on the chip goes back to all of them. A link to a
folder that is gone since says so. A folder's count, and the mark that something
in it is running, take in its pinned chats too, in the sidebar as on the page.

Folders are ordered **Latest first** (by their latest chat), **By name** (the
first agent first, then the other agents), or in **Your order**: drag a folder by its grip, or press Alt with ↑/↓ on
its name, and the order is yours from then on. The list button next to the order
puts the chats back into one list, Pinned then Recents, as before. The order,
the grouping and which folders are open are kept per browser, and the sidebar
and the Sessions page share the first two. Searching shows only the folders with
a match, open; one shut during a search is shut only until the search ends.

The chat's name at the top of the conversation renames it too: click it.
A name is at most 120 characters, wherever it is given — `/name` included.

Hovering a session gives you pin, rename and delete; with the keyboard, a row is
reached with `Tab` and opened with `Enter` or `Space`, and its buttons show as
soon as one of them has the focus. One the server refuses — pin, rename or
delete — says so in an alert, with the reason, beside the list, and the row
stays as it was. Renaming turns the name into a field where it stands — Enter or
clicking away keeps the new one, Escape puts the old one back — and
double-clicking the name does the same. Delete asks in the portal's own dialog,
with the button saying what it will do — and **Settings → This browser →
Confirmations** turns that question off, for chats, messages, files, skills,
routines, projects, voices and channels alike. It is kept per browser.
Discarding unsaved changes is still asked about. The Agents page's conversations
can be renamed and deleted the same way, from the row.

### Sub-chats

An extension can give part of a chat's work to a chat of its own, a
[child chat](/guide/extension-ui#child-chats). One it keeps listed is a
sub-chat: it is not a chat among the others, but sits under its chat's row, in
the sidebar and on the Sessions page, behind a line that says how many there
are (*2 sub-chats*). That line opens and shuts them; they are indented, with a
line beside them. They are shut until you open them, and open on their own
while one of them works or waits for you, until you open or shut them by hand;
each list remembers that per chat, in this browser. Opening a sub-chat opens its
chat's in the sidebar, and its page names its chat at the top, a link back to
it.

A sub-chat is counted nowhere on its own: not in a folder's count or its
latest change, not against the twelve recent chats or the eight of a folder,
not in the Sessions page's totals, and its run ending is not a notification of
its own. Its chat shows for it instead: the π while a sub-chat works, and the
ringed dot while one waits for you, with a dialog or a question
([Status dots](#status-dots)) — on a page nobody may have open. A sub-chat has
no pin; it is listed where its chat is. A search finds a sub-chat by its name
and shows it under its chat; a chat found by its own name shows all its
sub-chats. A search by a folder's name does not find a pinned chat through its
sub-chats: a pinned chat is found by its title only.

Deleting a chat deletes its sub-chats, and the chats its extension keeps out of
the lists, with it: the question before it names the sub-chats. A sub-chat can
be deleted on its own. One whose chat is not in the list — a conversation that
came through a channel, say — is listed as a chat of its own, and is treated as
one: it can be pinned, and its run ending is told. An agent's page lists its
conversations the same way, a sub-chat under its conversation and not counted
with them.

## Using a phone

Tap the navigation icon in the header to open the sidebar, then choose a
session or **New** to start a chat. Selecting an item closes the drawer;
you can also close it with its close button or by tapping the dimmed backdrop.

Use the send arrow beside the composer to submit a message. The keyboard's
Return key can still insert a new line. Long slash-command lists scroll inside
the picker, keeping the composer and navigation in view.

## Model and effort

The pills under the composer show the session's live model and effort level.
Both are per-session, both persist across restarts, and both fall back to the
portal default when unset — see
[Settings](/guide/settings#where-a-model-comes-from).

The model pill lists models you have used recently, with the full catalogue
behind **More models**. Only models with working credentials appear.

Effort is a slider over the levels the current model offers, from `off` through
`max` at most. A model can narrow that list with a `thinkingLevelMap` in pi's
`models.json`, and the pill follows it: a model with just `off` and one other
level turns the pill into an on/off switch, and one with a single level shows it
without a control.

pi coerces the level on a model that does not reason — ask for `high` on a
non-reasoning model and it lands on `off`. What gets stored is the level pi
resolved to, not the one you asked for, so a rejected value is not reapplied on
every restart.

### When `off` does not switch thinking off

The pill can say `off` and the model go on thinking. What `off` puts in the
request is decided by pi from the model's entry in `models.json`, and for an
OpenAI-compatible server it does not know how to switch reasoning off unless it
is told. Left alone it sends `reasoning_effort: "off"`, which llama.cpp does not
read: measured on a local model, that answer reasons exactly as much as
`medium` does.

Those models switch thinking through their chat template, so say so:

```json
{
  "id": "my-local-model",
  "reasoning": true,
  "thinkingLevelMap": { "off": "off", "minimal": null, "low": null, "medium": "medium", "high": null, "xhigh": null, "max": null },
  "compat": { "thinkingFormat": "qwen-chat-template" }
}
```

pi then sends `chat_template_kwargs: { "enable_thinking": false }` for `off` and
`true` for any other level — the request above went from 67 tokens to 4. A model
with `"off": null` in its `thinkingLevelMap` has no off at all and the pill does
not offer one; give it `"off": "off"` and the `compat` line to add it.

## Context

The rightmost pill is a donut showing how full the context window is, green
through amber to red as it fills. It follows a run turn by turn rather than
waiting for it to finish. Clicking it opens everything context-related:

- the exact usage — tokens used, window size, tokens left
- the **context window**, which you can change (below)
- **auto-compact**, on by default, which summarises before the window fills
- **compact now**, to do it immediately
- input and output tokens, message count, tool calls, cost

pi refuses to compact a session that is too short, and says so rather than
failing quietly.

### The context window

The percentage, and the moment a chat is compacted, are measured against the
window in the model's entry in `models.json`. That number cannot know how the
server is run. llama.cpp with `--parallel 2` splits `ctx-size` between two
slots, so a chat gets half of what the model's entry says: it is compacted far
too late and then fails at the server.

Set what one chat really holds in the pill's **Context window** field; **Reset**
goes back to the default (below) or, without one, the model's own number. The
setting belongs to the model, not the chat: it applies to every chat that uses
that model, open ones included, and is kept in the portal's database —
`models.json` is left alone. The pill appears once something has been said in a chat, and not before: an
empty conversation has nothing to measure, and a meter reading 0% is not
information. Until then the window is the one in the model's entry, or the
default below.

For all models at once there is a **Context window** default under
Settings → Defaults. It is a ceiling: a model that declares more is held to it, a
model that declares less keeps its own number, and a window set for one model in
its pill wins over it. Leave it empty to use what each model says.

Neither is available with `EXECUTOR=container`. pi runs inside the container
there and the portal cannot change its model, so the field and the default are
turned off rather than accepting a number that would do nothing.

## Persistence

Sessions survive restarts. Three things make that true, and each was a bug
before it was a feature:

- **The conversation.** pi's session file path is stored on the session row and
  reopened by path. Earlier the portal called `SessionManager.create()` on every
  boot, which started a fresh conversation each time and reset context to 0%.
- **The model and effort.** Stored per session, applied when pi relaunches.
- **The transcript.** Independent of pi — every event is in the portal's own
  log, which is what replay reads.

If the server restarts mid-run, that session is marked `interrupted` rather than
left spinning. The run is stopped first, as Stop would, so what the agent had
written so far is kept in the transcript and in its own record of the
conversation, not lost with the process. Send a message to carry on.

A chat's pi is let go after twenty minutes without use: nothing running, no
command or question waiting, no subagent working in the background, and nothing
this chat started that is still running in its folder (a dev server, a build, a
job an extension started during one of its tool calls; see
[Subagents and background jobs](/guide/extensions#subagents-and-background-jobs)).
Every pi is a whole agent in memory (or a container), and a portal with many
conversations would otherwise hold them all until it stopped. Nothing is lost —
the next message starts pi again from the conversation's file, which takes a few
seconds on a cold start. That is why a chat with a job running is not let go:
an extension that started the job stops it when its pi goes, and the
message it would have sent when the job ended would have nobody to receive it. Only the
chat that started a job is kept for it. The other chats in the same folder, such as the
conversations of one agent, are let go as usual. A chat with `EXECUTOR=container` is not let go: pi in a container
does not pick the conversation up again when it is started anew, so the agent
would have forgotten it, and the container stays until the chat is deleted. Picking a model or opening the command list also starts it. A
routine that runs in a clean session each time lets its pi go as soon as the run
ends.

pi's file for the chat (`/data/sessions/<id>`, see
[Deploying](/guide/deploying#volumes)) is what the agent remembers. When it is
gone, the chat still shows its transcript, but the agent starts over, and a
notice in the chat says so.

## The tab

The browser tab's title follows the chat you have open: `● Fix login · working`
while it runs, `❓ Fix login · asks you` while an extension is waiting for an
answer, and the plain name when it is done. Whether it is worth switching back
to is then readable from the tab strip.

The pages that refresh themselves — the sessions in the sidebar, Agents, Routines,
Channels, Browser, Audit — do that only while the page is visible, and once
when you come back to it. A tab left in the background asks for nothing.

If the connection to a chat breaks, the page reconnects — after two seconds,
then four, eight and at most fifteen — and says so once a second attempt has
failed. It is not shown for a blip. A chat the portal no longer has — deleted
on another device while this one still had it open — is not an outage: the page
says **This chat no longer exists** and offers the way back to Sessions, instead
of trying to reconnect.

## Status dots

| Colour | Meaning |
| --- | --- |
| Pulsing cyan | Running |
| Grey | Idle |
| Amber | Interrupted — the server restarted mid-run |
| Red | Error; the message is in the transcript |
| Cyan with a ring | Waiting for you: a [sub-chat](#sub-chats) has a dialog or a question open |

## Audit

**Audit** in the sidebar is the guard's record of what it decided, newest first,
kept for the last 2,000 decisions. Each row says what happened, for whom, when
and, for a tool, which tool and what it was asked to do:

| Kind | Meaning |
| --- | --- |
| Refused | The agent was stopped from doing something |
| Allowed by rule | A [standing rule](/people/rules) let it through |
| Allowed by approval | Somebody [approved it](/people/approvals), or you said yes in the chat to a call [held after a suspected prompt injection](/guide/security#asked-or-refused) |
| Turned away | A stranger on a channel was refused |
| You answered | A question from the agent was answered |
| Address reached | A tool went to an address: the agent's [browser](/guide/browser) was pointed at a page, or a tool that [declares `reaches`](/guide/extension-ui#what-the-guard-holds-a-tool-to) was given one |
| `allowed-by-exemption` | A routine [let off a rule](/guide/routines#the-injection-guard) did something that rule would have stopped |
| `revoked` | An approval not yet spent was taken back in Settings → Guard |
| `untrusted` | A flagged result you had trusted was untrusted in Settings → Guard, and holds its chat back again |
| Mode chosen | A chat was put in an extension's [mode that asks first](#modes), after you said yes to its warning: the mode's name, and what the chat stores |
| Extension | An extension [recorded something it did](/guide/extension-ui#a-row-in-audit), by its name: what it was done to, and what was done |
| Log cleared | Somebody emptied the log, and how many entries went |

The buttons above the list filter it: **Everything**, **Refused**, **Allowed**
(every kind of allowed) or **Strangers**, with counts of each and how many are shown. The
page shows the latest 300 and refreshes every ten seconds while it is visible.
Who is named is who they are called now: renaming a person renames them through
the history. A filter that shows nothing says "Nothing matches this filter"; a
log that could not be read says so, with **Try again**, rather than "Nothing
recorded".

**Clear the log** empties it, after a confirmation. It deletes every recorded
decision, not only the ones the filter shows, but not one made while the question
was open. A clear leaves a *Log cleared* row behind that says how many entries it
removed, so an emptied log cannot pass for a quiet one.
