# Documents

**Documents** is an extension that ships in the repository, in
`extensions/docs` (package `pithagoras-docs`). It adds a **Documents** page to
the sidebar. The page shows the Markdown documents in the folders your chats
work in.

It is under construction: documents can be listed, read, edited by you and by
the agent at the same time, have a history, and can be commented on, by you and
by the agent. This page describes what it does so far.

## Installing it

It comes with the portal: open **Settings → Extensions → Discover** and
install it under **Comes with Pithagoras**. Like any extension, you can switch
it off or remove it under **Installed** ([Extensions](/guide/extensions)).

The extension has npm packages of its own. The image comes with them, and
`npm run build` builds its editor along with the portal. The build installs
the packages it needs first if they are missing, or if they are not the
versions the extension's lock file names.

A checkout that was not built since its last change (one run by systemd, for
example) may not have the packages the extension needs to run, or have other
versions of them. When the portal starts, the extension then installs them
with npm in the background. The portal's log says when the
install starts and when it ends, or why it failed. A failed install is tried
again at the next start.

## What a document is

A document is a Markdown file (`.md`) directly in a folder called `documents`
in a chat's folder:

```
<the chat's folder>/
└── documents/
    ├── plan.md
    └── release-notes.md
```

These are ordinary files. [Files](/guide/files) lists them, and the agent can
read and write them like any other file in its folder.

A Markdown file you or the agent put into `documents` becomes a document the
next time the page lists the folder. Left out are:

- names that start with a dot
- files in folders below `documents`
- links, and files that have a second name elsewhere (hard links)
- everything in a `documents` that is itself a link to another folder
- files bigger than 1 MB
- anything that is not a plain file, such as a pipe
- names with control characters in them
- documents past the first 1000 in a folder

## Revisions and history

Each document has a revision number. It starts at 1 and goes up by one with
every change, whoever made it. Each folder's documents have a history of their
own: every revision is kept, and an earlier one can be brought back.

A change is saved against the revision it was made on. If the document changed
in the meantime (the agent wrote to it, say), your change is put together with
the later one where the two do not touch the same lines
([below](#when-the-agent-changes-the-document-while-it-is-open)). Where they do,
the save is refused and nothing is written: you get the text as it is now, and
your change is not lost. Bringing back an earlier revision saves its text as a
new revision, so the history only grows and nothing in it is replaced.

A change made outside the page, by the agent with its own tools, in Files or
in an editor, is not lost either. The next time the document is listed, read
or saved, or within a couple of seconds while the document is open on the
page, it is kept as a revision of its own, marked as an outside change. The
same happens to a save that the portal could not finish (it stopped in the
middle, say): what reached the disk is kept as a revision.

Restoring a document whose file was deleted makes the file again.

### Where the history is kept

The history and what is said about the documents are in the portal's data
folder, not in your project: in `extension-data/pithagoras-docs/<id>`, where
`<id>` is the id of the folder the documents are in (in the image,
`/data/extension-data/pithagoras-docs/<id>`). The folder is made the first time
the page lists a folder's documents. It holds:

- `git/`, a git repository of the extension's own, with one commit per
  revision. It is not your project's repository and does not change it; it
  holds only the documents.
- `docs.sqlite`, the comments and an index of the revisions.
- `folder.json`, which folder it is for: its path, and which folder that is on
  this system (its device and inode).

Only the portal can read it (mode 0700). It is not in the chat's folder, so
with the [sandbox](/guide/sandbox) on the agent can neither read nor change it,
and nothing of it is in your project: there is nothing to leave out of your
project's git, and copying or deleting the project does not copy or delete its
history. The portal keeps each document's owner and permissions when it saves
it, so the agent can go on editing its files. A new document belongs to the
owner of the `documents` folder.

The portal checks the store before it uses it, every time. It must be the
portal's own (not a link, and nothing in it a link or a pipe), and it is closed
to everyone else again if something opened it (a `chmod -R`, a restore made as
another user). A store that someone else made or swapped in is refused ("is not
the portal's own"): fix its owner, or delete the folder to start a new history.

The store is for the folder it was made for, not only for a path:

- A folder that was **deleted and made again** at the same path is another
  folder. It starts a new history, and the old one is kept beside it as
  `<id>.replaced-<time>`, to look at or to delete. The exception is a folder
  **restored from a backup**: it has other inodes, but its documents are the
  ones the store knows (some document is there with the text of one of its
  revisions), so the history stays with it.
- A folder that was **moved or renamed** on the same disk takes its store along
  the next time a chat works in it and the page lists it, as long as some
  document in it still has the text of one of the store's revisions (the same
  check as for a restore). If another folder was made at the old path
  meanwhile, the store is put aside for it and found again from there. A folder
  that was copied elsewhere is a new folder: it starts a history of its own, and
  the history of the old path stays where it was.
- Two paths to one folder (a link, a mount) have a history each, over the same
  files: each takes the other's saves in as outside changes.
- A folder's store is **not deleted** with the folder. Delete the store's
  folder in the data folder to free the room (`folder.json` in each says which
  folder it was for).

### A store from an earlier version

The first versions of Documents kept the store in `.pithagoras-docs` in the
chat's folder. The first time the page lists such a folder, the portal moves it
into the data folder: the history, the comments and the revisions stay as they
were, and `.pithagoras-docs` is gone from the folder. It is renamed where that
is possible. Where the data folder and your projects are on different disks (a
container's two volumes), it is written anew in the data folder and the old one
removed; what is in it is checked as it is written, and a link or a pipe stops
it.

**With the [sandbox](/guide/sandbox) on it is not moved.** The sandbox gives
everything in a chat's folder to the agents' group, so an agent could have
changed what is in the old store, and the portal, which runs as root, does not
run git on it or remove it. Delete `.pithagoras-docs` to start a new history (the
documents stay), or, if you trust what is in it, copy it (do not rename it: a
file an agent holds open would then be in the data folder) into the data folder
as the folder named by the folder's id, the first 16 characters of the SHA-256
of the folder's path, and then delete `.pithagoras-docs`.

When it cannot be moved, the folder's documents are left out of the page (the
portal's log says why, as "could not be moved into the portal's data folder"),
a request for them is answered with the reason, nothing is changed, and the old
store is not used. A `.pithagoras-docs` that is still there beside a store in
the data folder is left alone, also when the folder is moved: the store in the
data folder (for this folder) is the one used, and the log says to remove it. If
the old one could not be removed after it was copied, the log says so: remove it.

### A secret in a document

A save whose text looks like a secret (a private key, or a token of a common
service) is saved, with a warning: the history keeps every revision, so take
the secret out and change it where it was issued. To remove it from the
history as well, delete the folder's store in the data folder (and any
`<id>.replaced-…` beside it). That removes the history and the comments of every
document in that folder; the documents themselves stay, and start again at
revision 1.

## The page

The page has one section for each folder that has documents. Several chats can
work in one folder, and that folder is shown once. A document is listed by its
title. The title is its first heading in its first 4 KB: a `#` line, or a line
underlined with `=` or `-`, also inside a quote or a list. A heading-like line
in a code block (fenced, or indented by four spaces or a tab), in an HTML
comment or in a block of HTML is not a heading.

The title is shown as plain text. Links and pictures are shown by their text,
emphasis, code and HTML tags lose their marks however long they are, and
footnote marks are left out. A title longer than 256 characters is cut. A document with no heading in
its first 4 KB is listed by its file name. The list also shows when the
document last changed, and how many comments on it are open
([below](#comments)).

**All documents** goes back to the list.

## Editing a document

Click a document to open it in the editor. You edit the text as it will look:
headings, lists, task lists, tables, quotes, links and code. What you write is
saved as Markdown, in the document's file. The usual Markdown shortcuts work as
you type (`#` and a space for a heading, `-` for a list, `>` for a quote,
three backticks for code), and so do Ctrl+B and Ctrl+I.

What the editor does not do yet:

- a `mermaid` diagram shows as its code
- a picture (`![](images/a.png)`) is drawn as its text, and nothing is fetched
  for it, whether it names a path in the chat's folder or another site. It is
  written back as it was
- raw HTML is shown as text

### Saving

You do not save by hand. The text is saved a second after you stop typing, when
the cursor leaves the text, when you go back to the list or to another page of
the portal, when the browser tab is hidden or closed, and at Ctrl+S. Each save
is one revision. A page that is being closed can send only a small request (the
browsers allow 64 KiB): when the document is larger than about 60 KB and you
closed the tab with text not yet saved, the browser asks first whether to leave.
Beside the **History** button the page says where the
document stands: **Saved**, **Unsaved changes**, **Saving…** or **Not saved**,
and the revision.

Opening a document does not change it, and neither does clicking in the text
and out again: nothing is saved until the text is different. The editor writes
Markdown the way most of it is written by hand, so when you do change
something, the rest of the document may be written in that style as well:

- bullets as `-`, rules as `---`, and numbered lists as `1.`
- a hard line break as a backslash at the end of the line
- tables not padded, and their rule under the head as short as can be
- a link written by reference (`[a][1]`) written in the line
- several blank lines as one

Two things the editor keeps as they were: a front matter block at the top
(`---`, `title: …`, `---`), which is not shown in the text and is not edited
there, and a document written with Windows line breaks (CRLF), which keeps
them. A byte order mark at the start stays too.

A save goes against the revision the page started from, as the agent's edits do
([above](#revisions-and-history)); when the document has moved on since, it is
put together with the later revision where it can be
([below](#when-the-agent-changes-the-document-while-it-is-open)). A save that
cannot be made says why ("Could not save: …") and is tried again at your next
change, or at **Try again**. Your text stays in the editor. A save with a secret in it (see
[A secret in a document](#a-secret-in-a-document)) is made, and the page warns
about it. Once you put the warning away it is not said again with each save,
until a save without the secret has come in between.

### When the agent changes the document while it is open

The page is told of each revision of the document it has open as it is made:
by the agent, by another window of the portal, by Files or by an editor. It
does not wait for your next save to find out. The page keeps one connection
open for the document (server-sent events), and says where the document stands
whenever the connection starts, so a change made while it was down is found as
soon as it is back. If the text of a change cannot be fetched (the portal was
busy, say), the page asks again after a few seconds, with longer waits, and
meanwhile shows the document as it was. A revision made outside the portal (Files, an editor, or
the agent's own file tools) is noticed within a couple of seconds, and only
while some page has the document open.

What the page does with a change depends on what is in the editor:

- **Nothing of yours is unsaved.** The change is in the editor at once, without
  a reload. Only the paragraphs, lists and other blocks that changed are
  replaced, and they are marked for a moment. Your caret and selection stay
  where they were, unless the change is in the block they are in. A note says
  who changed the document and that it is now at the new revision. The change
  is not something Ctrl+Z undoes (it is not yours to take back); what you had
  typed before it still can be.
- **You have text that is not saved yet.** The change is merged into your text
  where it does not touch what you changed, and your text is then unsaved on
  the new revision and saved as usual. A note says so. Nothing is sent for the
  merge itself.
- **The change touches what you changed.** It is a real conflict, and it is not
  guessed at: see below.

Merging is by lines, as git does it. The page merges the text the editor
writes (so a document written with `*` bullets is no different from one with
`-`). Two
changes are one when they touch the same line, or lines that follow each other
without a line between them; a blank line between two paragraphs is such a
line, so changes to two paragraphs merge. A list, which has no blank lines,
does not: changing two neighbouring items is a conflict. A change that you and
the agent made in the same way is made once.

The portal makes the same kind of merge when a save arrives that started from
an earlier revision (the page was not told in time, or the connection was
down): the saved text is then the merged one, which becomes a revision of its
own, by you, and the editor takes it up. Text you typed while that save was on
its way is kept on top of it. The portal has no editor, so it merges the
files' text as it is written, not as the editor writes it: for a document
written in another style (`*` bullets, say) a late save can be a conflict where
the page's own merge, above, would have gone through. Nothing is lost then: you
get the conflict message below.

### When the document changed meanwhile

If the agent, Files or an editor changed the same lines you were typing in,
nothing is merged and nothing is written. The page does not take your text
away or replace it with the other version: it stays in the editor, a message
says the document is now at a later revision, and nothing more is sent until
you choose:

- **Keep mine as a new revision** saves your text after the other one. The
  other version is not lost: it is in the history, and can be brought back.
- **Take theirs** (after a question) drops your text and shows the other
  version. Your text is gone.
- **Show the other version** reads it first.

If the agent changes the document again while the message is shown, the other
version it offers is the newer one.

Text that could not be saved is kept for the tab, so a reload, or a visit to
another page of the portal, does not lose it: when you open the document again,
the page says it brought your text back, and the same choice is there if the
document is at another revision by then. The page asks before the tab is closed
with text that could not be saved, and what you typed after the document
changed is kept as well. **All documents** stays on the document
while there is such text.

## History

**History** shows the document's revisions, newest first, with who made each
(you, the agent, or an outside change: Files, an editor, or a save the portal
could not finish) and when. A revision that restored an earlier one says which.
Click a revision to read its text.

**Restore this revision** saves its text as a new revision, so the history only
grows. Text you have not saved yet is saved first, as a revision of its own, so
the restore does not take it away. If it cannot be saved (a change meanwhile
that you have not chosen about, or an error), nothing is restored until it is
dealt with. If the document changed since the page last saved or loaded it, the
restore is not made: the page shows the document as it is now and says so, and
you can restore again. The history shows the 50 newest revisions, and **Show
older revisions** the next ones.

If the editor cannot be loaded (its file is missing from a checkout that was
not built), the document is shown read-only, drawn as the portal draws
Markdown, with the reason and **Try again**.

## Comments

A comment is on a passage of a document: you select some words, press
**Comment** in the bar above the text, write what you want to say and press
**Add comment** (or Ctrl+Enter). The words are marked in the text, and the
comment is a **thread** in the list of comments beside the text (under it on a
narrow screen). The agent starts threads too, with its tools
([below](#the-agents-tools)), and your page shows them as soon as they are
made, without a reload.

What is in a thread:

- The passage it is on, which you can click to bring it into view in the text
  (clicking the marked words does the same the other way round).
- The comments in it, in the order they were made, each with who made it (you or
  the agent) and when. A comment is Markdown, drawn as the conversation draws
  it.
- A box to **Reply** in. **Resolve** closes the thread: it is no longer marked in
  the text and is out of the list until you press **Show resolved**. With
  something written in the box it reads **Reply and resolve** and adds the
  comment first. **Reopen** opens a resolved thread again. Nothing is added to a
  resolved thread until it is opened.

You and the agent can both start a thread, answer it and resolve it. Comments
are not edited or deleted yet.

A comment on text you have just typed is made on that text: what you typed is
saved first (a revision of its own), so that the passage is in a revision the
history has.

### Where the passage is

A passage is a stretch of the document's Markdown, kept with up to 32
characters on either side of it. It keeps its place when the text around it
changes: a paragraph added above it, words changed after it, a revision restored
that still has it. It follows text that is edited in it too: words you type
inside it are in it, a word replaced by another is the other word, and a
sentence of a paragraph rewritten is the new sentence. Text put in at the very
start or end of it is not in it.

The portal works this out from the text a passage was last placed in and the
text the document has now, when the comments are asked for (the page asks after
every save, so each step is a small one): by lines first, and by words inside the
lines that changed. It guesses as little as it can:

- A passage that was a whole paragraph, and is replaced by words that have next
  to nothing in common with it, is gone: nothing can tell a paragraph rewritten
  from one deleted and another written. So is a passage in a sentence that was
  written again round it (most of the rest of the sentence changed too, and none
  of the passage is left): a word of the new sentence that the comparison pairs
  with the old one is no more than a pairing. A word of a sentence replaced by
  another, or a sentence of a paragraph rewritten while the rest is as it was,
  is the passage. The agent's `doc_edit` with a `thread`
  ([below](#the-agents-tools)) is how a passage is rewritten and stays: it knows
  which words stand there now.
- A passage that is deleted, or cannot be followed, is **no longer in the
  document**. Its thread stays in the list, with the words it had, and can still
  be answered and resolved. If the words come back (a restored revision, an undo)
  the passage is found again, but only where the text around it is like what was
  around it (letters and digits: the blank lines and full stops that set off every
  paragraph do not count), or where the words are long (60 letters and digits or
  more) and stand in the text once. A "Friday" in a new paragraph is not the
  "Friday" of a comment on a sentence that was deleted.
- Words that read the same in two places (a short phrase, "Yes.") are not taken
  for the passage unless the text around them is like what was around it: a
  passage deleted from a document where another has the same words is gone, and
  the comment does not move to the other.

A passage is marked in the editor by finding its words in the text the editor
writes. A document written in another style than the editor's (`*` bullets,
padded tables) is found by its letters and digits, with the marks left out; if
that is not enough, the thread says **The passage could not be marked in the
text**, and works all the same. Editing the document once writes it in the
editor's style. The same is said of a passage in a paragraph that the editor
cannot put a mark in without changing what it writes (a paragraph that starts
with a character the editor writes escaped at the start of a line, such as
`15\. März` or `\#hashtag`): the passages in the other paragraphs are marked as
usual.

Limits: a passage is at most 5000 characters, a comment at most 4096 bytes, a
thread at most 100 comments and a document at most 1000 threads.

Comments are kept in the store's database ([above](#where-the-history-is-kept)),
not in the document's file or in its history: copying the file does not copy
its comments, and restoring a revision brings back text, not comments.

## The agent's tools

With the host executor (pi runs in the portal's own process) each chat's agent
has seven tools for the documents. Like any tool they can be switched off for
a chat or by default under Settings → Tools, where they are listed in the group
`extension-host`: the name the portal gives to what extensions add to a chat's
pi through their server half. With `EXECUTOR=container` the agent has none:
the runner image does not get extensions.

| Tool | What it does |
| --- | --- |
| `doc_list` | The documents the chat sees: id, title, file, revision, whether it is the project's or the chat's own, and how many comments on it are open. `scope` narrows it to one of the two. |
| `doc_read` | One document's Markdown and revision, and after the text the comment threads on it that are open (`comments` asks for all of them, or none). `revision` reads an earlier one from the history; a long document is returned in parts of about 60,000 characters, and the end of a part says where to read on (`from_line`, and `char_offset` inside a line that is longer than a part). The comments come with the first part, for the document as it is now. |
| `doc_create` | A new document from a title and its Markdown, at revision 1. |
| `doc_edit` | Replaces quoted passages with new text, on the revision the agent read. With a `thread` and a `reply` it answers a comment ([below](#answering-a-comment)). |
| `doc_comment` | Starts a thread on a passage the agent quotes, with its first comment. The document is not changed. |
| `doc_reply` | Adds a comment to an open thread. |
| `doc_resolve` | Resolves a thread, with a last comment if the agent gives one. |

The agent names a document by its id, never by a path. A document is the
**project's** (every chat that works in the folder sees it) unless the agent
makes it with `scope: chat`: that one is listed and read only in its chat. The
page lists both, whichever chat they belong to.

What the tools check is what keeps the agent from overwriting you:

- `doc_edit` says which revision it was made on. If you saved the document
  since, or something changed its file (the agent's own tools, Files, an
  editor), the edit is refused, nothing is written, and the agent reads the
  document again before it tries again. Two edits made on one revision at the
  same time: one is made, the other is refused. The agent's edits are not
  merged with yours the way your saves are merged with its changes: it reads
  the document as it is now, and quotes it again.
- Each edit is a quote and its replacement. The quote must be in the document
  exactly once, as `doc_read` shows it. All of a call's edits are looked for in
  the document as it was, none may overlap, and either all are made or none.
  Each call makes one revision, by the agent.
- `doc_create` never replaces anything: a title whose file name is taken is
  refused. The agent has no tool to delete a document, to restore a revision
  or to change the history.
- A document is at most 1 MB.
- The agent is not let to write a secret (a private key, or a token of a common
  service) into a document, since the history keeps every revision. What
  counts is the text the edit would write, so a token put together from the
  document and a replacement, or from two edits, is refused too. A document
  that holds one already can still be edited, as long as the edit does not
  add one or change it.
- What the agent writes into a document with CRLF line breaks (written on
  Windows, say) gets CRLF line breaks, and a quote with line feeds still finds
  its lines.

A refusal reaches the agent as an error that starts with its reason
(`revision_mismatch`, `quote_not_found`, `quote_ambiguous`, `edits_overlap`,
`exists`, `too_large`, `secret`, `not_found`, `invalid`, `thread_not_found`,
`thread_resolved`, `thread_orphaned`, `too_many` or `refused`, for
anything else the store will not do: the folder is full, `documents` is a link,
the store's packages are not installed yet), so that it can put it right.

These checks are in the tools. The agent can still change a document's file
with its own tools (it is an ordinary file in the chat's folder); that is kept
as an outside change like any other, but it is not checked against what you are
doing, which is why the tools' instructions tell the agent to use them.

### Answering a comment

`doc_read` lists the open threads after the document's text: each thread's id,
the passage it is on (as the Markdown has it) and the line, and what the person
and the agent said in it. `doc_list` says how many comments are open on each
document. **Nothing tells the agent that you left a comment**: it sees them when
it reads the document, so ask it in the chat to look at them. (Letting a comment
reach the agent, and waking it, is the next step.)

The rule for answering a comment is the one Claude for Word follows: the agent
changes only the passage the comment is on, and says what it changed. It is held
to it by the tool:

- `doc_edit` given a `thread` looks for its quotes only in that thread's
  passage, so a quote need be unique in the passage only, and nothing outside the
  passage can be changed by it. The thread must be open, and its passage still in
  the document.
- It then needs a `reply`, which is added to the thread as the agent's comment
  once the change is made, so that you can read in the thread what was done. A
  `reply` is checked before anything is written; if the document is changed and
  the reply then cannot be added (the thread was resolved meanwhile), the tool
  says so and the agent adds it with `doc_reply`.
- The thread's passage is then the words that now stand there, including what
  the edit added at its end.
- `doc_reply` and `doc_resolve` say in their instructions that a reply says what
  was done about the comment, not only that it was read. Whether a thread is
  resolved after an answer is the agent's to decide; it is told to leave it to
  you unless the comment asked for something the change fully carries out.

An edit without a `thread` is as before: it may change anything in the document,
and a comment whose passage it touches follows it as above.

A comment the agent starts is its own, and a comment you make through the page
is always yours: neither can be made in the other's name. Comments on a document
that is only a chat's own (`scope: chat`) can be read and answered only by that
chat, like the document.

In the conversation a call of `doc_create`, `doc_read`, `doc_edit`,
`doc_comment`, `doc_reply` or `doc_resolve` is drawn as a card that names the
document and says what became of it (created, read, commented on, edited from
revision 2 to 3 with how many edits, and whether that answered a comment).
**Open in Documents** opens the document on the page. A call that failed, and a
list, are drawn as any tool call is.
