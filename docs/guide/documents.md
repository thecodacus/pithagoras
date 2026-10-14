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
├── documents/
│   ├── plan.md
│   └── release-notes.md
└── .pithagoras-docs/      the history and the comments (the extension's own)
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

The history and what is said about the documents are in
`.pithagoras-docs` in the chat's folder:

- `git/` is a git repository of the extension's own, with one commit per
  revision. It is not your project's repository and does not change it; it
  holds only the documents. A `.gitignore` in `.pithagoras-docs` tells your
  project's git to leave the folder out.
- `docs.sqlite` holds the comments and an index of the revisions.

Only the portal can read the folder (mode 0700). With the
[sandbox](/guide/sandbox) on, the agent cannot read it, but the portal keeps
each document's owner and permissions when it saves it, so the agent can go on
editing its files. A new document belongs to the owner of the `documents`
folder.

The portal checks the folder before it uses it, every time. It must be the
portal's own (not a link, and nothing in it a link or a pipe), and it is closed
to everyone else again if the sandbox's permissions for the chat's folder, or
someone, opened it. A folder that someone else made or swapped in is refused
("is not the documents store's own"); move or delete `.pithagoras-docs` to
start a new history.

### A secret in a document

A save whose text looks like a secret (a private key, or a token of a common
service) is saved, with a warning: the history keeps every revision, so take
the secret out and change it where it was issued. To remove it from the
history as well, delete the folder's `.pithagoras-docs`. That removes the
history and the comments of every document in that folder; the documents
themselves stay, and start again at revision 1.

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
