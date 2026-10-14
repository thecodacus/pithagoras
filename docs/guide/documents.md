# Documents

**Documents** is an extension that ships in the repository, in
`extensions/docs` (package `pithagoras-docs`). It adds a **Documents** page to
the sidebar. The page shows the Markdown documents in the folders your chats
work in.

It is under construction. This page describes what it does so far.

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
in the meantime (the agent wrote to it, say), the save is refused and nothing
is written: you get the text as it is now, and your change is not lost.
Bringing back an earlier revision saves its text as a new revision, so the
history only grows and nothing in it is replaced.

A change made outside the page, by the agent with its own tools, in Files or
in an editor, is not lost either. The next time the document is listed, read
or saved, it is kept as a revision of its own, marked as an outside change.
The same happens to a save that the portal could not finish (it stopped in the
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
document last changed.

Click a document to read it. The page draws its text, headings, lists,
tables, quotes, links and code. Two things are not drawn yet:

- a `mermaid` diagram shows as its code
- a picture by a path in the chat's folder (`![](images/a.png)`) is not shown

The page only shows documents for now: to change one, edit it in Files or
ask the agent. **All documents** goes back to the list.
