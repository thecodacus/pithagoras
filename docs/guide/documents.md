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

The page leaves out:

- names that start with a dot
- files in folders below `documents`
- links, and files that have a second name elsewhere (hard links)
- everything in a `documents` that is itself a link to another folder
- files bigger than 1 MB
- anything that is not a plain file, such as a pipe

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

The page only shows documents: to change one, edit it in Files or ask the
agent. **All documents** goes back to the list.
