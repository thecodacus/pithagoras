# Documents

**Documents** is an extension that ships in the repository, in
`extensions/docs` (package `pithagoras-docs`). It adds a **Documents** page to
the sidebar. The page shows the Markdown documents in the folders your chats
work in.

It is under construction. This page describes what it does so far.

## Installing it

Open **Settings → Extensions → Install a package** and enter the package's
path: `/app/extensions/docs` in the image, or the `extensions/docs` folder of
a checkout. Like any extension, you can switch it off or remove it there again
([Extensions](/guide/extensions)).

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
- files bigger than 1 MB

## The page

The page has one section for each folder that has documents. Several chats can
work in one folder, and that folder is shown once. A document is listed by its
title, which is its first heading, or its file name when it has no heading.
The list also shows when the document last changed.

Click a document to read it. It is drawn the way the portal draws Markdown in
a conversation. The page only shows documents: to change one, edit it in Files
or ask the agent. **All documents** goes back to the list.
