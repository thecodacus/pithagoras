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
`npm run build` builds its editor along with the portal. When the portal
starts from a folder that does not have the packages yet (a checkout run by
systemd, for example), the extension installs them with npm in the
background. The portal's log says when the install starts and when it ends,
or why it failed. A failed install is tried again at the next start.

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
