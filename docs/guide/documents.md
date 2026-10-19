# Documents

**Documents** is an extension that ships in the repository, in
`extensions/docs` (package `pithagoras-docs`). It adds a **Documents** page to
the sidebar. The page shows the Markdown documents in the folders your chats
work in, which you and the agent edit together.

- A document is an ordinary Markdown file, so the agent reads and writes it
  with its own tools as well as with the ones Documents gives it.
- You edit it in the page as it will look. The agent can change it while it is
  open, and its change is put together with yours as it comes.
- Every revision the portal makes or sees is kept, whoever made it, and an
  earlier one can be brought back.
- You and the agent comment on passages of a document, and write `@agent` in a
  comment to have the agent answer it.
- You can rename a document (its file) and delete it, from the list or from the
  open document ([below](#renaming-and-deleting-a-document)).

Documents is not [Canvases](/guide/canvases). A canvas belongs to one
conversation, and is kept by the portal (in memory, or in its database once
stored). A document is a file in the project, shared by every chat that works
there, with a history and comments of its own. Both exist side by side.

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
with npm in the background (it needs npm and a network). The portal's log says
when the install starts and when it ends, or why it failed. A failed install is
tried again at the next start. A request waits for the install to end, and
after a failed one the page says that the store's packages are not installed
yet. This installs what the extension needs to run, not what builds its editor:
a checkout still needs `npm run build`, or documents are shown read-only
([History](#history)).

The history is kept with git, which the image has. A portal run from a
checkout needs `git` on its `PATH`; without it the page says so for every
folder ([When a folder's documents cannot be opened](#when-a-folders-documents-cannot-be-opened)).

## What a document is

A document is a Markdown file (`.md`, in any case) directly in a folder called `documents`
in a chat's folder:

```
<the chat's folder>/
└── documents/
    ├── plan.md
    └── release-notes.md
```

These are ordinary files. [Files](/guide/files) lists them, and the agent can
read and write them like any other file in its folder.

There is no button for a new document: ask the agent to make one (it has a
tool for it, [below](#the-agents-tools)), or put a Markdown file into
`documents`. It becomes a document the next time the page lists the folder
(or the agent lists them), with the file's text as its first revision, and
within a couple of seconds while the page shows the list of documents
([below](#the-page)). Left out are:

- names that start with a dot
- files in folders below `documents`
- links, and files that have a second name elsewhere (hard links)
- everything in a `documents` that is itself a link to another folder
- files bigger than 1 MB
- anything that is not a plain file, such as a pipe
- a file the portal is not allowed to read
- names with a backslash or a control character in them
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
page or the list of documents is, it is kept as a revision of its own, marked
as an outside change. The
portal sees the file as it is at that moment, so several outside changes made
between two looks are one revision. The same happens to a save that the portal
could not finish (it stopped in the middle, say): what reached the disk is kept
as a revision. Every document is looked at by its own file name, however many
other things are in the `documents` folder. Only a Markdown file the portal has
not seen yet is taken in as a new document from the first 2,000 entries of the
folder (folders first, then by name), as Files lists it.

### A file that is deleted or renamed

A document is a file, so [Files](/guide/files), the agent's own tools or an
editor can delete it or give it another name while you have it open. What
happens then is below. (Renaming or deleting a document from the Documents page
is not this: the portal does it itself, and the document stays the same one, or
is gone, with what went with it, as
[described below](#renaming-and-deleting-a-document).)

- The document is no longer listed, and asking for it is answered with "There
  is no such document". The list of documents on the page drops it within a
  couple of seconds ([The page](#the-page)). Its history and its comments are
  kept in the store ([below](#where-the-history-is-kept)) and are there again
  as soon as a file of that name is: the list shows it again then, too.
- The page is not told. The text stays in the editor, and nothing is lost: the
  next time it is saved, the save makes the file again from your text, under
  its name, as the next revision, and the page says so ("This document's file
  had been deleted or renamed. It was made again from your text …"). If the
  whole `documents` folder was deleted, it is made again with the chat folder's
  owner and mode, so that the agent can write in it as before.
- A save that started from an earlier revision than the document's last one is
  a conflict, as ever, with the last revision's text as the other version. The
  file is made when you keep your text.
- Comments on the open document go on: a new one is made on the text the
  document last had, and replies and resolving work as before. The agent cannot
  read the document until its file is there, so an `@agent` on it is not
  delivered, and says why.
- Something else where the file was (a folder, a link, a file with a second
  name) is not written over: the save is refused ("Another file took the
  document's name"), and your text stays in the editor. If `documents` itself
  became a link, nothing is written through it either: a save and the agent's
  `doc_create` are refused ("documents in this folder is a link").
- **Restore this revision** makes the file again too, from an earlier revision.
- A **rename** is a new file to the portal: it is taken in as a document of its
  own, at revision 1, marked as an existing file, with none of the old
  document's history or comments. Those stay with the old name. If a file of
  the old name is there again (renamed back, or another written by the agent),
  it is the old document again, at the revision it had if the text is the same
  and at its next one, marked as an outside change, if it is not.
- A title whose file is gone is free for the agent: `doc_create` makes a new
  document with the next file name (`plan-2.md`) and does not touch the one
  that is gone.
- A file that is there, but that the portal does not read as a document (an
  outside change made it bigger than 1 MB, or the portal may not read it), is
  not called gone and is not written over: reading and saving the document are
  refused with that reason ("The document's file is bigger than 1 MB, or the
  portal is not allowed to read it"), and your text stays in the editor. The
  portal writes over such a file only when you restore an earlier revision.

### Where the history is kept

The history and what is said about the documents are in the portal's data
folder, not in your project: in `extension-data/pithagoras-docs/<id>`, where
`<id>` is the id of the folder the documents are in (in the image,
`/data/extension-data/pithagoras-docs/<id>`). The folder is made the first time
the page lists a folder's documents. It holds:

- `git/`, a git repository of the extension's own, with one commit per
  revision (a rename and a deletion are revisions too). It is not your project's
  repository and does not change it; it holds only the documents.
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
another user). A store that someone else made or swapped in, or that holds a
file or folder of another user's, a link or a pipe, is refused ("is not the
portal's own", "holds something that is not its own"): the page names the store
and what is wrong with it, and [below](#when-a-folders-documents-cannot-be-opened)
says what to do.

The store is for the folder it was made for, not only for a path:

- A folder that was **deleted and made again** at the same path is another
  folder. It starts a new history, and the old one is kept beside it as
  `<id>.replaced-<time>`, to look at or to delete. (The portal tells folders
  apart by their device and inode, so on a file system that gives a new folder
  the inode number of the one deleted, the old history carries on.) The
  exception is a folder **restored from a backup**: it has other inodes, but
  its documents are the ones the store knows (some document is there with the
  text of one of its revisions), so the history stays with it.
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

When it cannot be moved, the page says why for that folder ([below](#when-a-folders-documents-cannot-be-opened)),
and so does the portal's log ("could not be moved into the portal's data folder"),
a request for its documents is answered with the reason, nothing is changed, and
the old store is not used. A `.pithagoras-docs` that is still there beside a store in
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

## When a folder's documents cannot be opened

A folder whose documents the portal cannot open is not left out in silence,
where it would read as a folder with no documents. The page says so above the
folders it can list, with the folder and the reason:

> The documents in /data/workspaces/site could not be opened: …

The other folders are listed as usual, the portal's log has a line with the same
reason, and the documents' files are not touched. The agent's tools in that
folder refuse as well. A right the portal lacks in the documents folder, a full
disk and a read-only file system, said as such, are told to it as they are.
Anything in the store's own folder (its rights, its owner, its database, git) is
told to it only as "the store cannot be used, ask the person": where the store
is and what to delete or change in it are yours to decide, and the agent runs
commands as the portal and could carry them out. The reasons the page gives are
the portal's own words, in English. The usual ones are these:

| The page says | Why, and what to do |
| --- | --- |
| The documents store's packages are not installed yet | The extension installs what it needs to run in the background when the portal starts ([Installing it](#installing-it)); it needs npm and a network. The install failed (the portal's log says why); the page says this for every folder until the portal starts again and tries again. |
| The portal is not allowed to read this folder's documents folder (permission denied) | The user the portal runs as cannot enter or list `documents`. Give it the right to (`chmod`, or the folder's owner). A document of that folder that is open gets the same reason when it is read or saved, not "There is no such document". |
| git could not be found on the portal's PATH: … | The history is kept with git ([Installing it](#installing-it)). Install it, or put it on the portal's `PATH` (a portal that was started before has to be restarted). Nothing was changed. |
| The history of the documents could not be used: git … | git could not read or write the folder's history. It names the store's folder. If the history is damaged (a crash, a disk that failed), remove the `git` folder in the store: the history starts again from the files as they are, every document at revision 1 and marked as an existing file, and the documents and their comments stay (except those of a document whose file is gone: it is forgotten with its comments). The damaged history is gone with it: keep a copy first to look into it. A full disk, a read-only file system and a missing right are not this: git saying so is reported as one of those (the next rows and the list below), and the history is not to be removed for it. |
| The portal is not allowed to use the documents store in … (permission denied) | A file or folder in the store belongs to the portal's user, but it may not write it: its mode was changed (a `chmod -R`, a restore that kept other modes). Make the store's folder writable for the portal's user again (`chmod -R u+rwX`). Nothing is to be removed for it. |
| The documents database cannot be written: … | The portal's user may not write the `docs.sqlite` files in the store (the same cause as the row above, for the database), or their file system is read-only. SQLite then opens the database read-only and says so at the first write. Mend the mode or the mount; the comments are all still there. |
| The documents store is not the portal's own (…), The documents store holds something that is not its own: …, The documents database is not the store's own (…) | The store, a file or folder in it (the page names it) or its database belongs to another user, or is a link or a pipe. It is usually a store copied or restored as another user (`sudo cp -r`, a restore as `root`), or a portal that now runs as another user than it did. The message says where the store is. If you trust what is there, give the whole store folder to the portal's user (`chown -R`); a link or a pipe is removed. If you do not, remove the store's folder: the history starts again, and the history and the comments of that folder's documents are lost. |
| The documents store was removed, replaced or opened to others while it was in use | The store's folder changed under the running portal (a restore, a `chmod -R`). The next request opens it again and closes it to others; if what is there is not the portal's own, it gives the row above. |
| The database of the documents is damaged: … | The comments and the index of the revisions could not be read. Remove the `docs.sqlite` files in the store's folder (all of them: a database left with the log of another one is damaged again): the index is built again from the history. The comments are lost, and a chat's own documents become the project's. Keep a copy first if you want to try to read the comments with `sqlite3`. |

A save that the portal cannot make says why ("Could not save: …", and **Try
again**; your text stays in the editor and is tried again at your next change),
a restore says "Could not restore: …", and the agent's `doc_create` is refused
with the same reasons:

- **The portal is not allowed to change files in this folder's documents
  folder (permission denied)**: it can read the documents but not write them.
  It is the folder that has to be writable, not the file: a save is a new file
  renamed over the old one, as an editor does it.
- **There is no room left on the disk for this document**, or **… is on a
  read-only file system**: the disk of the documents, or of the portal's data
  folder, is full or not writable.

Nothing is left half done by any of these: a save is written whole or not at all,
and a write that was cut off is put right the next time the store is used
([above](#revisions-and-history)).

## The page

The page has one section for each folder that has documents. Several chats can
work in one folder, and that folder is shown once. A document is listed by its
title. The title is its first heading in its first 4 KB: a `#` line, or a line
underlined with `=` or `-`, also inside a quote or a list. A heading-like line
in a code block (fenced, or indented by four spaces or a tab), in an HTML
comment or in a block of HTML is not a heading, and neither is a YAML front
matter block at the top (`---`, `title: …`, `---`).

The title is shown as plain text. Links and pictures are shown by their text,
emphasis, code and HTML tags lose their marks however long they are, and
footnote marks are left out. A title longer than 256 characters is cut. A document with no heading in
its first 4 KB is listed by its file name, without the `.md`. The list also shows when the
document last changed, how many comments on it are open and how many threads
the agent has answered, open or resolved, that you have not reacted to yet
([below](#comments)).

**All documents** goes back to the list. A folder whose documents could not be
opened is said above the list, with the reason ([above](#when-a-folders-documents-cannot-be-opened)).

### Uploading Markdown files

**Upload** beside a folder (and in the panel beside a chat) adds Markdown files
(`.md` or `.markdown`) to that folder's `documents` folder, several at once. You
can also drop them on the list. A file is kept as it is, under its own name
(a `.markdown` file is saved as `.md`); a name that is taken gets a number. A
file that is not Markdown, is bigger than 1 MB, or is not UTF-8 text (a file saved
in Windows-1252, say, whose umlauts would be lost) is not sent, and the list
says so. A byte order mark at the start of a file is kept. A single file uploaded on its own opens at once.

A Markdown file put into a `documents` folder any other way (an upload in
[Files](/guide/files), an editor, a copy) is a document too. While the page or a
panel lists the documents, the portal watches each `documents` folder, and such
a file is in the list a moment later.

### Renaming and deleting a document

Each row of the list (on the page and in the panel beside a chat) has two
buttons at its right end, **Rename _name_** and **Delete _name_**, which show
when the row is pointed at or has the keyboard focus, and always on a touch
screen. An open document has the same two in the **Document actions** menu
(**…**) of its bar, next to **Download**. The menu opens with **Rename** focused;
the arrow keys, **Home** and **End** move in it, **Escape** closes it and the
focus goes back to its button. In a row, Tab goes from the document's button to
**Rename** and **Delete**.

**Rename** changes the document's file name, `documents/<name>.md`. What you see
of a document is two things, and this changes only the second: its **title** is
its first heading (the list and the bar show it, [above](#the-page)) and is
changed in the text; its **file name** is what you rename. The field takes the
name without `.md`, which is added (an `.md` you write yourself is not doubled; a
file that has its extension in capitals, as an uploaded `README.MD` does, keeps
them), has the name selected, and says this under it. **Enter** renames, **Escape**
or **Cancel** gives it up, and the focus goes back to the button that opened the
field. **Enter** in a field that was not changed asks for nothing. A name that is
refused is said under the field, which stays open with what you wrote:

- a name that another document has, or anything else in the folder has (a file,
  a folder, a link)
- a name that is not a document's: it must end in `.md`, may not start with a
  dot, may not have `/`, `\` or a control character in it, and is at most 255
  bytes
- a name that **differs from the file's own only in capitals, or in the form of a
  letter, on a file system that does not tell such names apart** (macOS, Windows,
  and Linux folders made case-insensitive): there it is the same name, so there
  is no second name to give the file, and a rename of a name onto itself would
  change nothing or, worse, take the only name away. It is refused ("This file
  system does not tell … from …"), and the file is as it was. Rename it to
  another name first, and then to the one you want. On a file system that tells
  the two apart (Linux as it usually is), a name that only changes the capitals
  is an ordinary rename.

A rename keeps the document: its id, its comments and their passages, its
history and its text. It is a revision of its own (the same text, made by you,
marked **Renamed from _old name_** in the [history](#history)), so every earlier
revision can still be read and brought back, and a page that has the document
open takes it as it takes any revision: it shows the new name, and what is typed
there and not yet saved is kept and saved on top of it (a window that did not
ask for the rename says "This document was renamed to …"). What was typed in the
open document is saved before it is renamed. The agent finds the document by its id,
so a rename costs it nothing except a new revision to read before its next edit.
Only the page and the routes below rename: the agent has no tool for it.

**Delete** asks first, as the portal does before it deletes anything ("Delete
‘Title’? This deletes the file _name_, the comments on it and its history. It
cannot be undone."). **Settings → This browser → Confirmations → Ask before
deleting** ([Interface](/guide/interface#confirmations)) turns the question off,
and the document is deleted at once. What is deleted:

- the file, from the `documents` folder
- the document's comments and their threads, and what waits on them (an `@agent`
  that was not answered yet is not asked any more)
- the document, from the lists and from its history on the page: asking for it is
  answered with "There is no such document"

Its file name is free again, and a document made under it is a new one, with
nothing of the old one. The deletion is a commit of its own in the store's git
repository ([below](#where-the-history-is-kept)), which is how the history says
that the document is gone, so that the index made again from it does not bring it
back. **The commits the document had stay in that repository** (git keeps what a
commit once held), and nothing on the page reads them: for someone who runs the
portal and wants a deleted document's text back, `git --git-dir=<the store's git>
log --all` and `show <commit>:<file name>` find it. Its comments are not in
git and cannot be brought back. Only a plain file is deleted: where the name is
something else (a link, a folder, a file with a second name) the delete is
refused ("… is not the document's file now") and the thing is left as it is. A
document whose file is already gone (an outside deletion, [above](#a-file-that-is-deleted-or-renamed))
is forgotten by the delete, with its comments.

**An open document that is deleted from elsewhere** (another window, or the
person who runs the portal) says so: "This document was deleted. Your text is
kept here and is not saved." The text stays in the editor, nothing more is sent,
and the bar's menu is off. **Save as a new document** makes a document of the text
that is on the page (with the old title, and the same project or chat scope) and
opens it; **Close** goes back to the list. A page that was not told (its
connection was down) finds out with its next save, or when it asks for the
comments again. Deleting from the page you have open leaves it at once, and the
text typed since the last save goes with the document.

The page takes a document for deleted only when the server half says so: the 404 for
a document it has no more carries `code: "deleted"`, and its stream sends a `deleted`
event. Any other 404 is not that. While the portal starts, or the extension is being
updated, the routes of the server half answer with the portal's own 404 ("No such API
route"), and the page then does what it does for any failed save: it says "Could not
save", keeps the text (and a draft, if you leave), asks for the comments again with the
connection, and saves the text with the next change once the server half is back.

**Where this is safe.** The portal may run as root (with the sandbox on) while the
agent writes in the same folder, so a delete and a rename are not done by path:
the `documents` folder is held open, and the file is taken away or given its new
name through that folder, by `portal.files.removeFile` and `renameFile` ([A chat's
folder](/guide/extension-ui#a-chat-s-folder)). A folder or a link that the agent
puts where the file was between the look and the call is never followed or
removed, and a rename never replaces what is at the new name.

The `documents` folder itself is the one the store **holds to**: the folder it made,
or the first it saw there (its device and inode, kept in the store's database). The
agent writes in the chat's folder, and a rename there needs only the right to write
in that folder, so it can rename a folder it has no access to (the sandbox's closed
folders are root's, mode 0700) onto the name `documents`, or move a closed file into
it, and what the portal does in a folder, or reads from a file, it does with its own
rights. So the portal asks, with the [sandbox](/guide/sandbox) on, whether the agent
could use the folder, and the file, itself: as the kernel would tell it for the user
and the groups the agent runs as, from the owner, group and mode of what the portal
holds. The agent is the one the sandbox runs each session of the folder as, by the
workspace stored for it, so a link the agent puts where that path was does not
change who is asked. The sessions are all of them that work in the folder (tasks, and
also routine runs, conversations on the Agent page and heartbeats, which have the
document tools too; one for each agent that has some there, as what an agent can reach is the same from each of
its sessions, which are never removed, and a stored path can be a link), and for what an agent's own tool does, the session that calls
it, always: if the folder has sessions of more than one agent, all of them must be
able to use it, which also means that one that leads its stored path into another
agent's folder stops that folder's documents for everyone until it is put back. A project is root's too, so who owns a folder says nothing,
and the sandbox closes a subtree only by its top folder (what is inside keeps the
group's rights), so **every folder of the path** from `/` down to the documents
folder must be searchable by the agent, as the kernel needs for it, and none of them
may have been replaced by a link. A folder, and a file in it, that the agent could not
read is not read: its files are not listed as documents or taken in, `doc_read` and
the page do not give them, and the store never holds to it (the page says "documents
in this folder is closed to the agent", and `doc_list` says it is closed, not that there are no documents).
A `documents` folder is not made in a folder the agent could not write in either, and what is said of a folder
the agent could not even look into is the same whatever stands there (nothing, a `documents` folder, a link or a file of that
name, or a store of an earlier version): the portal refuses the folder before it looks at anything in it. To hold to a folder, to write in it and to
delete or rename in it, the agent must also be allowed to write there; a folder the
agent can only read (a read-only project) is read and not changed in. In a sticky
folder (mode 1777) only what is the agent's own is deleted, renamed or replaced, as
for the agent. With the sandbox off the agent is the portal's own user, and nothing
is closed to it. One thing is not asked: POSIX ACLs. Only the mode bits count; the
sandbox sets no ACL, but one that a person put on a folder or file of a chat is not
seen.

A delete and a rename are done only in the folder held to: it is checked on the folder
the call holds, in the call itself (`expect`), not by a look at the path before.
Another folder at the place is refused ("The documents folder here is not the folder
these documents were kept in …", 409), with nothing changed. A folder that was
replaced on purpose (a `git checkout` that removed it, a restore) is taken as the one
when **you make a new document** in it (the page's **New document**, an upload or
**Save as a new document**, not the agent's tool), if it is a folder the agent could
use itself; the message says so, so make sure it is the folder you mean. The agent can
read and write in the folder as before (its files are taken in as they are anywhere in
`documents`); what it cannot do is get the portal to read, delete or rename in a folder
or a file that is closed to it, or in a folder that was not the documents folder.

**Cut off in the middle.** The portal writes down what it is about to do before
it touches the file. If it stops after the file was renamed or removed and
before the history says so, the next time the store is used it finishes: the
rename is committed (the document is the same one, not a new one made of the file
under its new name), or the deletion is. A rename that was cut off between the
two halves of the file's rename (the file has both names for a moment) loses the
old name, but only for the file it was decided for, only when the file really has
two names, and only while finishing such a rename: a second name made by someone
else is in the way of a rename, never a half of one. What is written down holds
the folder and the file (device and inode) it was decided for, and a deletion
notes that the file was taken away as soon as it was: finishing it later removes
nothing again, so a file made at that name since, or a folder moved onto the
place, is left as it is. If the folder is not the one it was decided in, the
decision is dropped and nothing is changed.

### Beside a chat

**Documents** in a chat's header opens a panel beside the conversation, docked
or floating like the other panels, with every document of the chat's folder,
as on the page. A folder such as the agent's home is shared by many chats: a
document another chat made as its own says **From the chat …** (its agent sees
it; the agent of this chat does not). A document opens there in the same editor
as on the page, with its toolbar, its comments and its history; a comment's card
fits the panel (under its passage there, where the panel has no room beside it),
and the list of comments comes in over the page from the right where the panel
is narrow. **Full page** opens it on the
Documents page, the whole of it. A title and **New document** make
one in the chat's folder and open it (the title is its heading, as below), and
**Open in Documents** on the card of one of the agent's document tools opens
that document in the panel, without leaving the chat. The list keeps itself up
to date as the page's does.

### Watching the agent write

When the agent begins a document (`doc_create`) or an edit of one (`doc_edit`)
in the chat on screen, the panel opens by itself and shows it as the model
writes the call, a few times a second:

- **A new document** is drawn as it will be, its title as its heading where the
  Markdown has none. Once it is made it opens in the editor; one the agent could
  not make (its title was taken, say) says so.
- **An edit** is drawn on its document as it is stored, with the edits that have
  come so far: each replacement appears where its quote is, as it is written. An
  edit the tool will refuse (a quote that is not there, or there twice) is not in
  the draft. **Show the saved text** goes back to the document as it is saved,
  for the rest of that call. When the call is done the change is in the editor
  like any change from elsewhere, marked for a moment.

Until the call ends it is all the page's own: what is drawn is never saved, and
what is saved is what the tool makes when it runs, as before. The page draws it
from the call as the chat's stream brings it to the page; with no page open on
the chat (a channel, a routine) nothing of this is done. If you are working in
the document when the agent's call begins (the text has your cursor, or
something of yours is unsaved), the draft is not drawn over it: your text stays,
and the agent's change comes in when it is done (or is refused, if your save
came first). Closed while a call is written, the panel stays closed for that
call, and opens again for the next.

### The list keeps itself up to date

You do not reload the list. While it is on the page it shows a document that
the agent or another window made, one that was renamed or deleted (in Files,
in an editor or by the agent's own file tools) or made again, a change to a
document's title, time or comments, a folder that gets its first document, and
a folder whose documents the portal can (or can no longer) open: the reason
appears above the list, and goes when the folder can be opened again. What the
agent does through its document tools, and what is saved on the page, shows at
once; what is changed outside the portal is noticed within a couple of
seconds.

The page keeps one connection open for the whole list (server-sent events),
not one for each folder. The portal says over it only that the list is not what
it was, and the page asks for the list again; the first message of a connection
says where the list stands, so a change made while the connection was down is
found as soon as it is back, and a page whose list is current asks for nothing.
If the connection drops, the page opens it again after a few seconds, with longer
waits. The list that is shown stays while it cannot be fetched.

The connection is open only while the list is on the page: opening a document,
or going to another page of the portal, closes it, and so does closing the
tab. The portal looks at the folders only while some page has the list open.
Like the rest of the page it needs the portal's login, and it ends when the
password changes. It names no folder, document or path; it says only that something changed.

## Editing a document

Click a document to open it in the editor. It is laid out as a word processor
is: a bar with the document's name, where it stands, **Comments**, **History**
and **Download** (the first two open a panel at the side, [below](#history)); a toolbar; and the page itself: the text is written on the whole
of the area under the toolbar, one continuous surface with no box or frame around
it (in the chat's panel as well as on the Documents page), in a column of a
readable width with room at its sides. It scrolls by itself, so that the bar and
the toolbar stay. A click on it beside a line of the text puts the cursor on that
line, and one under the last of the text puts it at the end of the document, as
on a word processor's page. Selecting text with the mouse and letting go beside
it, in the margin, keeps the selection. Nothing else is
shown with the text: the comments are on the page when you open one, and in a list
when you ask for it ([below](#comments)). On the Documents page an open document
takes the whole page.

You edit the text as it will look: headings, lists, task lists, tables, quotes,
links and code. What you write is saved as Markdown, in the document's file.
The toolbar has undo and redo, the text style (normal text, three levels of
heading, a code block), bold, italic, strikethrough, code, a link (its address
is asked for in the toolbar; the same button takes a link off), bulleted,
numbered and check lists, a quote, a table, a horizontal line, and
**Comment**. Each button shows whether it is on where the cursor is. A task's
box is ticked with a click. The usual Markdown shortcuts work as you type (`#`
and a space for a heading, `-` for a list, `>` for a quote, three backticks for
code), and so do Ctrl+B, Ctrl+I and Ctrl+E.

### Visual or Markdown

The bar has a switch, **Visual** and **Markdown**, for people who would rather
write the Markdown itself. **Visual** is the editor above and is what a document
opens in. **Markdown** shows the document's text as plain Markdown, in the place
of the editor: in the same column, in a monospace face, with soft wrapping and no
box. It is a plain text box, so the browser's own undo and redo, spelling and
selection work in it, and so does **Tab**, which leaves the box rather than
writing a tab. The browser remembers the choice (per browser, not per document),
and a document opens the way you left it last.
Where the bar is narrow (a window with the portal's sidebar open) the switch is
two icons, with the names as tooltips, so that the document's name keeps its room.

Everything else works as it does in the editor:

- The text is saved in the same way: after a second without typing, at once with
  Ctrl+S, and when the cursor leaves the box. What is saved is what is typed,
  character for character, so a list written with `*` stays that way. The status
  in the bar and the revision numbers are the same.
- When the agent or another window changes the document meanwhile, the change
  comes into the box as it does into the editor: at once if you have typed
  nothing unsaved, merged into your text where the changes do not meet, and a
  conflict that you choose in ([below](#when-the-document-changed-meanwhile)) where
  they do. The box is the text for all of it: what the agent changed is merged
  into what is in the box, in the style it is written in (a document that uses `*`
  for list items keeps them), and a line the agent changed is no conflict because
  of the style of another. Your cursor stays at the words it was at, and the
  browser's own undo keeps what you typed: the change from outside is a step of
  its own in it (the first Ctrl+Z takes it back, as an edit of yours that you can
  redo; a browser that does not allow this starts its undo over).
- A page that is closed with text not saved is kept, restored, and warned of in
  the same way. What was typed in the box comes back in it as it was typed. In
  **Visual** the same text is written by the editor, in its style. **History**
  works the same, and a revision restored shows in the box.
- Going from one to the other loses nothing, also text that is not saved yet,
  which stays unsaved. Going to **Visual** saves the text first where it can. If
  you only looked at a document, or went from one to the other without changing
  it, nothing is saved, even for a document written in another style than the
  editor's (`*` for list items, say). The page stays at the same place in the
  text, as far as the scroll goes.
- The toolbar (formatting and **Comment**) is not shown in the Markdown, where
  there is nothing to select a passage in and the formatting is written out; the
  shortcut Ctrl+Alt+M does nothing there either.
- The comments are not drawn on the text: no marked passages, no cards, no
  markers in the margin. **Comments** in the bar still has the list of all the
  threads and how many are open. A thread **chosen** in the list takes you back to
  **Visual** and opens its card at its passage. A passage is a stretch of the
  file's Markdown that is followed from one revision to the next, so what you
  write in the Markdown moves the comments as a change in the editor does
  ([below](#where-the-passage-is)).
- **Download** and **PDF (print)** are the same, and the print is the text as the
  editor draws it.

**Download** saves the document's file as it is (**Markdown (.md)**), or prints
the text on its own (**PDF (print)**), where the browser's print dialog saves it
as a PDF.

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
In the bar, at the end of the document's name, the page says where the
document stands: **Saved**, **Unsaved changes**, **Saving…** or **Not saved**,
and the revision. A window too narrow for all of it cuts the text (the whole of it
is in the tooltip); the bar is as high in every state.

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
cannot be made says why ("Could not save: …": the portal may not write in the
folder, the disk is full, the history is broken, [above](#when-a-folders-documents-cannot-be-opened))
and is tried again at your next change, or at **Try again**. Your text stays in the editor. A save with a secret in it (see
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
  who changed the document (the agent, through its document tools, or "from
  elsewhere": Files, an editor, the agent's own file tools) and that it is now
  at the new revision. The change
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

**History** in the bar opens the document's revisions as a panel at the right
edge of the page, newest first, with who made each (you; the agent, through its
document tools; or an outside change: Files, an editor, the agent's own file
tools, or a save the portal could not finish) and when. A revision that restored
an earlier one says which, and one that renamed the document says what it was
called ([above](#renaming-and-deleting-a-document)). It is the same panel as the list of comments
([below](#comments)): at the same edge and in the same size, beside the text
where the page is wide and over it, from the right, where it is narrow, with
**Close**. Only one of the two is open at a time: opening one closes the other,
and the bar's buttons show which one is open. **Escape** closes the panel while
the cursor is in it, and the button it was opened from has the focus again.

Click a revision to read its text. It is shown on the page, in the text's place,
while the panel stays open: the text cannot be edited then, and a note under the
bar says that you are reading revision _n_, an earlier text, and that the
document itself has not changed. **Back to the current text** in the note (or a
click on the revision again, or closing the panel) is the way back. The current
revision is the text itself, so nothing is changed for it.

**Restore this revision** (in the panel, also while the revision is shown on the
page) first asks "Restore revision _n_?": the current text is replaced, and the
current version stays in the history. **Cancel** (or Escape) changes nothing and
the focus goes back to the button; **Restore** goes ahead and the cursor is in
the text afterwards. The question is the portal's one before something is
removed or replaced, so **Settings → This browser → Confirmations → Ask before
deleting** ([Interface](/guide/interface#confirmations)) turns it off, and then
the restore is made at once. It saves the revision's text as a new revision, so
the history only grows. Text you have not saved yet is saved first, as a revision of its own, so
the restore does not take it away. If it cannot be saved (a change meanwhile
that you have not chosen about, or an error), nothing is restored until it is
dealt with. If the document changed since the page last saved or loaded it, the
restore is not made: the page shows the document as it is now and says so, and
you can restore again. The history shows the 50 newest revisions, and **Show
older revisions** the next ones.

If the editor cannot be loaded (its file is missing from a checkout that was
not built), the document is shown read-only, drawn as the portal draws
Markdown, with the reason and **Reload the page** (a module that failed to load fails again when it is asked for again, so only a new page loads it).

## Comments

A comment is on a passage of a document: you select some words, press
**Comment** in the toolbar (or **Ctrl+Alt+M**, **⌘+Alt+M** on a Mac) and write
what you want to say. The words are marked in the text, and the comment is a
**thread** on them. As in a word processor, the comments are on the same canvas
as the text, and nothing of them is shown until you ask:

- A **commented passage** is marked in the text. **Click it** and its thread
  opens as a card on the page. On a wide page the card is **beside the passage**,
  level with it at the right edge of the page, so that the highlighted words stay
  visible at its left (the text it overlaps on the right goes behind it); where
  the passage runs into the card's place, or the page has no room beside the text
  for it (a narrow panel, a phone, or a panel open at the side: the room right of
  the text column is measured, not the window), the card is just under the words
  (above them where there is no room under them). It stays inside the page. It has the comments of the thread, each
  with who wrote it and when, a check to **Resolve** the thread (**Reopen** on a
  resolved one) and **Delete thread** where that is yours to do. A thread with
  many comments shows its first and its last, and **Show _n_ replies** for the
  rest. The box to **Reply** in is one line, and says in its own words that
  **@agent** asks the agent. Only one card is open at a time: a click on another
  passage opens that one instead. It follows its words as you scroll (it scrolls off with them when they do)
  and as the text changes, and a click in the text elsewhere, a click outside the card or
  **Escape** (also when the card was opened by a click and the cursor is still in
  the text) closes it (the text has the focus again). What was typed in its box
  is kept when it is closed ([below](#writing-a-comment)). If its words are gone
  from the text while it is open (the agent rewrote them), it stays where it was,
  says so, and keeps what you were typing.
- A small **marker** stands in the right margin, level with the line of each
  commented passage: a speech bubble and how many comments the thread has. It is
  a button (its name says which words and how many comments); a click on it opens
  the thread's card as a click on the words does, and **Enter** on it opens the
  card with the focus in its box. Threads on one line have a marker each, one
  under the other. A marker follows its passage and is not there while its card
  is open. Markers are drawn only where the margin right of the text is wide
  enough to hold them without touching a word (measured, so a panel open at the
  side counts): where there is not (a narrow window or panel, a phone) there are
  no markers, and the highlighted words are the way in.
- A new comment opens its card in the same way at the words you selected, with
  the box ready to write in. The page stays where it is, also far down a long
  document.
- With the keyboard: **Ctrl+Alt+M** with the cursor in a commented passage (or in
  the passage of a comment you began and closed) opens its card, with the focus in
  the box; **AltGr+M** is left to the text (it types a character on some layouts); **Tab** from the text goes into the card,
  and **Escape** back to the text.
- **Comments** in the bar, with how many threads are open, shows the **list** of
  all the threads, and hides it again (**Close** in it does too, and so does
  **Escape** while the cursor is in it). It is a panel at the right edge of the
  page, the whole height of it: beside the text where the page is wide (the text
  gets narrower), over it, from the right, where it is narrow (a narrow panel, a
  phone). The history is the same panel ([above](#history)), and the two replace
  each other. A thread on a passage is a line in it (the
  words, and the last thing said): **choose** it and the text scrolls to the
  passage and its card opens there. A thread that has no passage to click, because
  its words are gone from the text (or could not be marked) or because it is
  resolved, is a card of its own in the list, with its box and buttons: this is
  where they are reached, **Show resolved** among them.

The agent starts threads too, with its tools ([below](#the-agents-tools)), and
your page shows them as soon as they are made, without a reload; a card that is
open takes in what the agent says, and what you were typing stays in the box.

### Writing a comment

What you type in a comment's box stays there until you send it, with **Send** or
**Ctrl+Enter**: only then is it saved, seen by the agent when it reads the
document, and, with `@agent` in it, asked of the agent. Nothing goes while you
type, so a comment half written is nobody's but yours. **Cancel** on a new
comment drops it; nothing was sent, so nothing is taken away. A comment that
could not be sent stays in the box with the reason, to be sent again. The
browser asks before a reload or a closed tab would lose a comment you had not
sent. What you typed is kept when you close the card (with **Escape** or by
clicking outside) and when you show or hide the list, and is there when you open
the card again; a comment on a passage that you close with words in it keeps the
passage marked, and a click on the mark, its line in the list (**New comment**) or
**Ctrl+Alt+M** in the passage opens it again (with nothing typed, closing it drops
it). Starting another comment while one is kept asks first (**Discard the comment
you started?**); **Cancel** opens the kept one. A change you began to a sent
comment with **Edit** is kept the same way, and the browser asks before the page is
left with one. An answer from the agent that comes while you type is added to the
thread, and what you are typing stays in the box.

Once it is sent the comment is in its thread. You change or delete it afterwards
with the buttons beside it ([below](#changing-and-deleting-comments)).

A comment on text you have just typed is made on that text: what you typed is
saved first (a revision of its own), so that the passage is in a revision the
history has.

What is in a thread:

- The passage it is on: the marked words in the text, which open the card when
  you click them, and, in the list, the line that brings them into view and opens
  the card (a card of the list, for a thread that has no passage in the text, shows
  the words it had).
- The comments in it, in the order they were made, each with who made it (you or
  the agent) and when. A comment is Markdown, drawn as the conversation draws
  it.
- A box to **Reply** in, sent with **Send**. **Resolve** closes the thread: it is no
  longer marked in the text and is out of the list until you press **Show
  resolved**; what you typed in the box is sent first, as the last word in it. **Reopen** opens a resolved thread again. Nothing is added
  to a resolved thread until it is opened.

You and the agent can both start a thread, answer it and resolve it.

### Changing and deleting comments

A comment that has been sent can be changed or deleted by whoever wrote it: you
change your own, and the agent its own ([below](#the-agents-tools)). Neither
changes or deletes the other's. Each of your comments has **Edit** and **Delete**
beside its time, in an open thread (its card on the page) or a resolved one (its card in the list).

- **Edit** turns the comment into a box with **Save** and **Cancel**. It is kept
  as it was until you press **Save** (or **Ctrl+Enter**); **Cancel** and
  **Escape** give it up. **Save** is for words that are new: the same words
  change nothing (**Ctrl+Enter** on them just closes the box), and ask nobody. A comment that was changed says **edited** beside its time (the
  time of the change is its tooltip), and so does the agent's when the agent
  changes it. The comment keeps its place in the thread and its passage in the
  text. Text that is still being typed in the box is not an edit, and is not
  marked.
- **Delete** asks first (**Delete this comment?**; the question can be switched
  off in Settings, like the portal's other deletions). The thread stays with its
  other comments, on its passage. A thread's only comment is the thread, and a
  thread of one comment has **Delete thread** instead.
- **Delete thread** takes a whole thread away with its comments, open or
  resolved, and its mark in the text with it. It is for a thread you started,
  and only while the agent has not commented in it: it is not there on a
  thread the agent started or has commented in, which you resolve instead (and
  if the agent takes its own comments away, what is left is yours to delete).
  The agent resolving a thread without a comment does not count. It asks
  first, too.
- Pages that have the document open show a change, a deletion or a deleted thread
  as soon as it is made, like any other comment.

What a change or a deletion does to where the thread stands with the agent
([below](#asking-the-agent)):

- **A change asks the agent as a new comment would**: only if it is the last
  comment of an open thread, and the agent is woken (a few seconds later, with the
  words it has by then) if it now has `@agent` in it. A comment that is not the
  last, one in a resolved thread, and one that the agent has answered already ask
  nobody, even when you put the mention in: write a new reply to ask again. A
  comment the chat has taken already is changed in the thread and wakes nobody
  again, as before. Taking the mention out of a comment whose ask no chat has taken
  takes the ask back, wherever the comment is in the thread.
- **Deleting a comment that asked** takes its ask with it: the thread stops
  waiting for the agent, and the agent is not woken for it. Deleting your reply to
  an answer of the agent's makes that answer news again (**The agent answered**);
  deleting a comment in the middle of the thread changes nothing of that.
- A deleted thread is not woken for either. If the agent was already woken, it
  finds the thread gone when it tries to answer, and says so.

### Asking the agent

Write **@agent** in a comment, a new one or a reply, to ask the agent to answer
it. The agent of a chat is then woken with the comment: if the chat's agent had
been let go it is started, and if it is in the middle of an answer it takes this
up afterwards. The chat shows a notice that names the document and the thread and
quotes your comment (the first thousand characters; the thread has all of it),
and the agent reads the thread and answers in it with the tools described
[below](#answering-a-comment).

- Only a comment you sent asks: the agent is woken in the background a few
  seconds after you send it, so a mention in a comment you are still writing
  wakes nobody, and no chat is looked for or opened for it. Nothing waits for the
  chat to start: you can go on writing, and the thread says where the ask
  stands. A comment you change with **Edit** before the agent is woken is asked
  as it is then; one you take the mention out of does not wake it at all. One
  you change after it was woken wakes nobody again, unless it asks as a new one
  would, as [above](#changing-and-deleting-comments) says.
- Only a comment of yours wakes the agent, and only with `@agent` as a name of
  its own, in any case: `@agents`, `me@agent.example` and `@agent` straight after
  a backtick do not (a mention elsewhere in a code span or block still counts).
  A comment without it wakes nobody; the agent finds it when it reads the document. Text
  you type into the document is never a ping, and neither is a comment the agent
  writes.
- The comment goes to the chat you are in. The Documents page is not in a chat,
  so it takes the chat that was on screen last in this browser tab, if that chat
  works in the document's folder. If there is none (you came to the page by a link,
  or the chat works in another folder) the page opens a new chat for the folder,
  named **Comments on** and the document's title, and asks in it, and in that
  chat from then on. A chat's own document is answered by that chat only,
  wherever you are. The thread says which chat it asked.
- The agent has no more rights than before: it changes only the passage the
  comment is on, with the document's revision check, and the rest is up to you
  ([below](#answering-a-comment)). Resolving the thread, saying what it did, is an
  answer as much as a reply is.
- If the chat could not be reached (it was discarded, the agent does not run in
  the portal's own process, or no chat could be opened) the comment is kept and the
  thread reads **Not delivered to the agent**, with the reason where there is one.
  The agent sees the comment the next time it reads the document. Nothing is sent
  again by itself: changing the comment, with the mention in it, asks again. The
  portal's log says why the chat could not be reached.

The thread says where it stands with the agent: **Asked the agent**, with the
chat, until the agent comments in it; **The agent answered** from then until you
react (a reply, resolving or reopening it, or **Got it**, which says you have read
it). The agent resolving a thread counts as an answer: a thread it resolved is in
the list, resolved and marked as answered, until you have said you have seen it,
and then it is put away with the other resolved ones. The document's entry in the
list counts such threads, whether they are open or resolved. The page is told as
soon as the agent has written, like any other comment of the agent's, so you see
the answer without a reload. Nothing else tells you: there is no notification
outside the page. The conversation of the chat shows the agent's calls, with a
button that opens the document.

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
  paragraph do not count). A sentence that stands once in the text is found
  wherever it is (see below).
- Words that read the same in two places (a short phrase, "Yes."), or that are
  short, are not taken for the passage unless the text around them is like what
  was around it: a passage deleted from a document where another has the same
  words is gone, and the comment does not move to the other. Nor does a comment
  on a word whose sentence was deleted move to the same word in a sentence written
  later, however many changes there were in between (the portal sees the
  document's changes in steps, one for every time the comments were asked for).
  A passage of 30 letters and digits or more (a sentence) that stands in the text
  once is the same passage wherever it is, so a sentence moved to another place in
  the document keeps its comment, and a short paragraph cut and pasted does not.
  Words the comparison put at the place where the passage was, and that are still
  in it, are the passage. The text round a passage is compared with CRLF and LF
  line breaks as the same, so a document written back with the other line
  endings by a program outside the portal keeps its comments.

A passage is marked in the editor by finding its words in the text the editor
writes. A document written in another style than the editor's (`*` bullets,
padded tables) is found by its letters and digits, with the marks left out; if
that is not enough, the thread says **The passage could not be marked in the
text**, and works all the same. Editing the document once writes it in the
editor's style. The same is said of a passage in a paragraph, list item or quote
that the editor cannot put a mark in without changing what it writes (one that
starts with a character the editor writes escaped at the start of a line, such as
`15\. März` or `\#hashtag`, also as `- 15\. März` in a list of meetings): the
passages in all the other paragraphs and items are marked as usual, however many
of those there are.

Limits: a passage is at most 5000 characters, a comment at most 4096 bytes, a
thread at most 100 comments and a document at most 1000 threads.

Comments are kept in the store's database ([above](#where-the-history-is-kept)),
not in the document's file or in its history: copying the file does not copy
its comments, and restoring a revision brings back text, not comments.

## The agent's tools

With the host executor (pi runs in the portal's own process) each chat's agent
has nine tools for the documents. Like any tool they can be switched off for
a chat or by default under Settings → Tools, where they are listed in the group
`pithagoras-docs`, the package's name, as every extension's tools are. With `EXECUTOR=container` the agent has none:
the runner image does not get extensions.

| Tool | What it does |
| --- | --- |
| `doc_list` | The documents the chat sees: id, title, file, revision, whether it is the project's or the chat's own, and how many comments on it are open. `scope` narrows it to one of the two. |
| `doc_read` | One document's Markdown and revision, and after the text the comment threads on it that are open (`comments` asks for all of them, or none), with the ids of the agent's own comments and whether they were edited. Where comments follow the text, `[End of the document.]` comes right after its last character, so that the blank lines it ends with are seen as its own. `revision` reads an earlier one from the history; a long document is returned in parts of about 60,000 characters, and the end of a part says where to read on (`from_line`, and `char_offset` inside a line that is longer than a part). The comments come with the first part, for the document as it is now: at most 30 threads, the last 10 comments of each, and a passage cut to 400 characters, with a line saying how many more there are. |
| `doc_create` | A new document from a title and its Markdown, at revision 1. The file is named from the title. What the document is called is its first heading: Markdown with none is given the title as its heading at the top (after a front matter block); Markdown with a heading of its own keeps it, and is called by it. A heading changed later changes what it is called, never its file name. |
| `doc_edit` | Replaces quoted passages with new text, on the revision the agent read. With a `thread` and a `reply` it answers a comment ([below](#answering-a-comment)). |
| `doc_comment` | Starts a thread on a passage the agent quotes, with its first comment. The document is not changed. |
| `doc_reply` | Adds a comment to an open thread. |
| `doc_edit_comment` | Changes the text of one of the agent's own comments or replies, in an open thread or a resolved one. The comment is marked as edited. |
| `doc_delete_comment` | Deletes one of the agent's own comments or replies. A thread goes with its only comment. |
| `doc_resolve` | Resolves a thread, with a last comment if the agent gives one. |

None of them renames or deletes a document: that is for the person, on the page
([above](#renaming-and-deleting-a-document)). The agent can still move or remove
the file with its own file tools, which is what
[A file that is deleted or renamed](#a-file-that-is-deleted-or-renamed) is about.

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
  Whole lines taken out (a quote of a line or a paragraph with an empty
  replacement) take their line breaks with them: no extra blank lines are left
  where they were, and the document starts and ends as it did.
  Each call that changes the text makes one revision, by the agent; one whose
  replacements give the same text changes nothing, and says so.
- `doc_create` never replaces anything: a title whose file name is taken by a
  document is refused. (A document whose file is gone does not take its name:
  the new document gets the next one, `plan-2.md`.) The agent has no tool to
  delete a document, to restore a revision or to change the history.
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
`thread_resolved`, `thread_orphaned`, `comment_not_found`, `comment_not_yours`,
`too_many` or `refused`, for
anything else the store will not do: the folder is full, `documents` is a link,
the store's packages are not installed yet, the portal may not write in the
folder, git is missing or the history is damaged, a document's file is past
1 MB), so that it can put it right or tell you.

These checks are in the tools. The agent can still change a document's file
with its own tools (it is an ordinary file in the chat's folder); that is kept
as an outside change like any other, but it is not checked against what you are
doing, which is why the tools' instructions tell the agent to use them.

### Answering a comment

`doc_read` lists the open threads after the document's text: each thread's id,
the passage it is on (as the Markdown has it) and the line, and what the person
and the agent said in it. `doc_list` says how many comments are open on each
document. A comment reaches the agent when you write **@agent** in it
([above](#asking-the-agent)): the agent is woken with the thread's id. A comment
without it is not sent anywhere; the agent sees it when it reads the document, and
a thread that asked it is marked *asks you* there.

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
  resolved after an answer is the agent's to decide: resolving a thread it was asked
  in (`@agent`) is an answer as a reply is, and you are told so
  ([above](#asking-the-agent)). Its instructions say to resolve a thread when
  what it asked for is done or answered for good, and to leave it open when you
  still have to weigh in.

An edit without a `thread` is as before: it may change anything in the document,
and a comment whose passage it touches follows it as above.

The agent's own comments are its to correct: `doc_edit_comment` changes one,
whichever it is (named by the id `doc_read` shows beside it), and
`doc_delete_comment` takes one away. Both refuse a comment of yours
(`comment_not_yours`): the agent does not change or delete what you wrote, it
answers it or resolves the thread. Neither answers: a thread that still asks the
agent (`@agent`) is answered with `doc_reply`, and the tool says so when it
leaves the thread asking. What they do to the thread:

- A change marks the comment as edited. If it is the last comment of the thread
  the answer is news to you again (**The agent answered**), as a new answer
  would be; a change to an earlier comment is not. The same words change nothing.
- A deleted comment leaves the thread on its passage with the others. The
  agent's only comment of a thread of its own takes the thread with it; if you had
  replied, your comments stay, and the thread is then yours to delete. If the
  deleted comment was the answer to a comment of yours that asked, the thread asks
  the agent again (**Asked the agent**), but nobody is woken again; the agent's
  deleting its own last comment never makes an answer that you have read news
  again.
- Both work in a resolved thread too, and neither reopens it.

A comment the agent starts is its own, and a comment you make through the page
is always yours: neither can be made in the other's name. Comments on a document
that is only a chat's own (`scope: chat`) can be read and answered only by that
chat, like the document.

In the conversation a call of `doc_create`, `doc_read`, `doc_edit`,
`doc_comment`, `doc_reply`, `doc_edit_comment`, `doc_delete_comment` or
`doc_resolve` is drawn as a card that names the document and says what became of
it (created, read, commented on, a comment changed or deleted, edited from
revision 2 to 3 with how many edits, and whether that answered a comment).
**Open in Documents** opens the document in the panel beside the chat. A call
that failed, and a list, are drawn as any tool call is.

## Limits

| What | At most |
| --- | --- |
| A document | 1 MB of text. A save one byte over is refused ("A document can be at most 1 MB"), and so is a file that grew past it outside the page (it is left as it is) |
| Documents in a folder | 1000, after which `doc_create` is refused ("A folder holds at most 1000 documents"). A document whose file was deleted or renamed keeps its place |
| A comment | 4096 bytes. The box takes 4000 characters; a comment over 4096 bytes (accents and other scripts take 2 to 4 bytes a character) is refused when it is saved, with a message, and stays in the box |
| A passage a comment is on | 5000 characters |
| Comments in a thread | 100 |
| Threads on a document | 1000 |
| A title in the list | 256 characters, from the first heading in the document's first 4 KB |
| A title given to `doc_create` | 200 characters |
| Revisions the history shows at once | 50, then **Show older revisions** |
| What `doc_read` returns at once | about 60,000 characters of the text |
| Edits in one `doc_edit` | 50 |
| A comment quoted to the agent that is woken | 1000 characters (the thread has all of it) |

And how long things wait:

| What | How long |
| --- | --- |
| A save of the text | 1 second after you stop typing |
| A save of a comment | 0.7 seconds after you stop typing |
| A look for changes made outside the page | every 2 seconds, while some page has a document of the folder open |
| The agent woken by `@agent` | 3 seconds after you last changed the comment |
| A chat that does not start for a wake | given up after 2 minutes: the thread says "Not delivered to the agent", and changing the comment asks again |
| A git run | 2 minutes, then it is stopped |

## How it is built

This part is for whoever works on the extension, or builds another like it:
Documents is the largest worked example of the [extension API](/guide/extension-ui).
It imports nothing of the portal's core (`npm run check:boundaries` keeps it
so), and reaches the portal only through that API and the portal's own routes
(it opens a chat for a comment through `/api/sessions`).

```
extensions/docs/
├── package.json     the manifest: the browser half, its style and the server half
├── package-lock.json  the versions it needs to run and to be built, which the build and the install keep to
├── build.mjs        builds the editor into web/editor.js
├── server.js        the server half: routes, the streams, the wake of the agent
├── store.js         one folder's documents (class Store): files, history, comments
├── files.js         what a document's file is (its name, what refuses a write, rename or removal), on `portal.files`
├── git.js, guard.js the history in git, and the store's folder held open
├── place.js         where a folder's store is, and which folder it is for
├── tools.js         the agent's nine tools
├── ping.js          what wakes the agent's chat, and what it is told
├── errors.js        the refusals, and what a failed disk, git or database is to a reader
├── secret.js        what a secret looks like, for the warning and for the agent's tools
├── deps.js          installs what the extension needs to run
├── web/             the browser half, plain JavaScript as it is served, and its stylesheet
└── src/             the editor (Milkdown), built into web/editor.js: not kept in git
```

**The halves.** The browser half (`web/client.js`) registers a page in the
sidebar (`nav.page`), the cards for the agent's calls (`chat.tool`), one entry
that remembers which chat was on screen last and one that opens the panel when
the agent begins to write (`chat.background`). Its
texts are its own, in English in the code and in German through
`portal.locale.add`. It is plain JavaScript, loaded as it is, with the
portal's React and building blocks (`portal.ui`). The server half is loaded
once by the portal, for all chats, and is given `portal`; it adds the routes
below, and where pi runs in the portal's process (`EXECUTOR=host`) it adds the
tools to each chat's pi (`portal.chats.extend`). Both import some of the same
files (`web/merge.js`, `web/anchor.js`, `web/mention.js`), so that the page and
the server agree on what a merge, a passage and a mention are.

**Routes**, under `/api/x/pithagoras-docs`. A folder is named by an id made from
its path and a document by an id the store gave it, never by a path:

| | |
| --- | --- |
| `GET /folders` | The folders chats work in that have documents, with their documents, and `problems` for the ones that could not be opened |
| `GET /chats/:chat/documents` | Every document of a chat's folder (another chat's own marked `otherChat`, with `chatTitle`) and the folder `{ id, name, path }`, for the panel beside it |
| `POST /folders/:folder/documents` | A new document `{ title, markdown?, scope?, chat? }`: Markdown with no heading near its top is given the title as its heading |
| `POST /folders/:folder/documents/upload` | A Markdown file the person uploaded `{ name, markdown }`, kept as it is under its own name |
| `GET …/:id/download` | The document's file, as an attachment |
| `GET`, `PUT /folders/:folder/documents/:id` | A document's Markdown and revision; a save `{ markdown, base }`, answered 409 with the current text when its changes meet later ones |
| `POST …/:id/rename` | Another file name `{ name }` (`x.md`), as a revision of its own: 400 for a name that is not a document's, 409 for one that is taken (`exists`: the other document's id, or `null` for another file) |
| `DELETE /folders/:folder/documents/:id` | Deletes the document: its file, its comments and its place in the lists (409 where its name is a link, a folder or a file with a second name) |
| `GET …/:id/events` | A stream (server-sent events) of its revisions (`revision`), comment changes (`threads`) and its deletion (`deleted`, once) |
| `GET …/:id/history`, `…/revisions/:n`, `POST …/restore` | The history, one revision's text, and bringing one back |
| `GET`, `POST …/:id/threads`, `…/threads/:thread/{comments,resolve,reopen,seen}` | The comment threads, and a reply |
| `PUT`, `DELETE …/threads/:thread/comments/:comment` | Change or take away one of the person's comments `{ body }`. With `draft` (`?draft=1` for the delete) it is a comment saved as it is typed, by a client that does that (the page sends one only when it is sent): only the last comment of an open thread, not marked as edited. Otherwise any of theirs, open thread or resolved; a change is marked as edited |
| `DELETE …/threads/:thread` | Take away a thread the person started, with its comments, while the agent has not commented in it (409 `thread_answered`, or `thread_not_yours` for one the agent started) |

**What the agent is writing** is the browser half's alone. It reads the chat's
calls as the page has them (`calls` in `portal.chats.use`: a call the model is
writing, with its arguments as far as they have come), opens the panel for a
`doc_create` or `doc_edit` once for each call, and draws the draft
(`web/writing.js`): a new document's Markdown, or the edits so far made on the
document as it is stored, which it reads once when the edit begins. The server
half does nothing for it: the tool saves when it runs, as before.

A stream's first message says where the document stands (`revision`, with
`id: <revision>`, the author and the time), so that a page that was away finds
out at once; `threads` says the comments changed. A comment line goes out every
25 seconds so that nothing between the portal and the page takes the stream for
idle.

**A write** is made under the folder's lock in three steps (the file, the git
commit, the database) and any failure between them is put right the next time
the store is used (`store.js`, top). A rename or a delete begins with a fourth,
first step: what is decided is written to the database (`pending`), then the
file is renamed or removed (`portal.files.renameFile`, `removeFile`: the folder
is held, nothing is followed), then the commit (a rename is a commit that takes the
old name out of the tree and puts the new one in, with `Renamed-From`; a deletion
takes the name out, with `Deleted: yes`) and the database. Recovery finishes what
`pending` says from wherever the disk is (the file has the new name, or both, or
only the old), and a rebuild of the index from the history takes the name from the
last revision and drops what was deleted. A revision's text is read by its blob,
not by the file name it had in that commit, which is what keeps the history of a
renamed document readable. Every refusal is a `DocError` with an HTTP
status, which a route answers and a tool turns into the error the agent reads;
a failure of the disk, of git or of the database is made into one that says
what is wrong (`errors.js`), and anything else is logged and answered with
"The documents store could not do that".

**Options.** The server half takes a second argument, for tests: `dependencies`
(what installs the packages), `faults` (breaks a write after a step), `gitTimeoutMs`,
`pingMs`, `pollMs`, `wakeMs` and `wakeLimitMs` (the times in the table above).

**Tests.** They are beside the code, in `extensions/docs/test/`. Each file runs
alone, with `node --import tsx --test extensions/docs/test/<name>.test.mts`:

| File | What it holds |
| --- | --- |
| `store`, `extension` | The store and its routes against git on disk: history, recovery, where a store is, titles, listing, dependencies, German |
| `hardening` | The edges: a file deleted or renamed, no rights, a broken store, saves at once, the size limit, a chat that never starts |
| `rename` | A document renamed and deleted: what goes with a rename, the refusals, the pages told, a stop in the middle of either, the index made again from the history |
| `files` | What a document's file is, and the calls on `portal.files` it is read, written, renamed and removed with |
| `tools` | The agent's tools |
| `stream`, `live`, `merge`, `saver` | Telling a page of changes, and taking them in |
| `frame` | What the editor keeps apart from the Markdown: front matter and line endings |
| `comments`, `comment-tools`, `anchor` | The comments and where their passages are |
| `ping` | `@agent` and the wake |
| `browser/*.spec.mts` | The page, in a browser, against a stand-in for the server half. They build the editor first |

```
node --import tsx --test extensions/docs/test/hardening.test.mts
npx playwright test extensions/docs/test/browser
```

The browser tests' dev server has a fixed port (5191), so run one set at a time.
