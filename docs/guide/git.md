# Git

The branch icon in a chat's header opens **Git**: what has changed in the chat's
folder, the history, the branches, and pull requests, beside the conversation. It
runs the same `git` you would type in the [terminal](/guide/terminal) next to it,
in the same folder, so what it shows is what the agent sees.

The panel is for the repository the chat's folder is in. Where the folder is in no
repository, it says so and offers **Make it one (git init)**. Where the folder holds
clones of its own (a workspace with several projects), a **Repository** picker offers
them, see [The header](#the-header).

It follows the agent. A file the agent writes, the end of its turn, and switching
back to the browser tab each read the state again; while a run is going and the
page is visible, it is read every eight seconds as well, so a commit or checkout
made from the agent's shell shows up.

## The header

Under the tabs, one line shows where the repository is:

- **The repository.** When the chat's folder has repositories inside it, a
  **Repository** picker lists them by their path in the folder, with the
  repository around the folder first. Everything in the panel then belongs to the one
  picked, and a file opened in Files is found under the clone's path. The pick is
  kept per chat in this browser. A folder in no repository of its own that holds
  exactly one shows that one at once, and the folder itself stays in the picker (as `.`) so it can be made a
  repository too. A folder with an empty or broken `.git` (a half-made folder, or a file naming a
  repository that is gone) is not listed. The folder is scanned four levels deep, for up to 50 repositories; hidden folders, `node_modules`, build output and links are
  skipped, and a repository inside another one is not listed. Refresh scans again.
- **The branch.** Click it to open Branches. On a detached HEAD it reads
  *detached at* and the short hash.
- **Its upstream**, with `↑n` commits to push and `↓n` to pull, or `✓` when both
  are even. A branch with a remote but no upstream says *not on the remote yet*.
- **Fetch**, **Pull** and **Push**, when there is a remote. Pull is
  *fast-forward only*: if the branches have diverged it stops with git's message
  instead of making a merge you did not ask for. On a branch with no upstream, Push
  becomes **Publish** and sets one up.
- **Refresh**, which also asks GitHub again about pull requests.

If the panel cannot read the repository after it has shown it once (the portal is
restarting, the folder is gone), a red note says what is shown may be out of date
and offers **Try again**. A list that could not be read says so the same way and
is not left reading *Loading…*.

Whatever a button did shows on a line under the header while it runs, and what git
answered stays there until you dismiss it. Only one thing runs at a time — the
other buttons are greyed until it is done — and a failure is shown as git said it,
without its own prefixes and hints.

## Changes

What differs from the last commit, in three lists:

- **Conflicts**, while a merge has stopped on some. Resolve the file in Files,
  then use the **+** on its row (*Mark resolved*) to stage it. The diff of a file
  in conflict has the same button, and no Discard: git cannot discard a file that
  is unmerged.
- **Staged**, what the next commit will hold.
- **Changes**, everything else, including files git does not track yet (marked
  **U**). A letter in front of each name says what happened to it: modified, added,
  deleted, renamed, or type changed. A rename shows the old name too.

Each row has a **+** or **−** to stage or unstage that file, a discard button
(*Discard the changes to…*, or *Delete…* for a file not in any commit), and a
button that opens it in Files. They appear when you hover the row, and always on
a touch screen. Discarding asks first and cannot be undone. The list heads have
the same for everything: **Stage everything**, **Unstage everything**, **Discard
every change not staged**, and **Stash everything**.

Click a file's name to see its diff, on top of the tab, with **Back** at the top.
What you have typed into the panel is kept while you look: the commit message and
the **Amend** box here, the form that opens a pull request, and a comment on a pull
request. They are also kept when you close the panel, switch chats or reload the
page, and are gone once the commit, the pull request or the comment has gone through
(or you cancel the form). They are kept in the browser's session storage, one set per chat.

### Committing

Write a message and choose **Commit** (or press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>).
The button says what it will do:

- With nothing staged it reads **Commit all n**: it stages everything and commits
  it, which is the usual case in one click.
- With something staged it reads **Commit n staged**, and commits only that.
- **Amend** changes the last commit instead of making a new one. An empty
  message keeps the old one. Amending never picks up unstaged work on its own.

Committing is refused while files are in conflict.

A commit needs a name and an email, which git reads from its own configuration.
In the container nothing has set them, and its host name has no domain for git to
guess an address from, so the first **Commit** on a fresh install is refused with
git's *Author identity unknown*. Set them once, in [your shell](/guide/terminal#your-shell)
in the portal:

```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

They are kept in `/data/home`, the portal's home folder on the data volume, so
they stay across updates. A repository with its own identity (`git config` there,
without `--global`) keeps it.

### Stashes

When there are stashes, a line at the bottom of Changes counts them. Open it for
the list: click a stash to see what is in it, **Apply** to bring it back and keep
it, **Pop** to bring it back and drop it, or the bin to drop it. Dropping asks
first. A stash is made with the archive button on the **Changes** list head.

### A merge, rebase or cherry-pick that stopped

When one stops half way, a banner across the top names it — *Rebasing*, *Cherry-picking*,
*Reverting*, *Applying patches* or a merge — and says how many files are in
conflict. Resolve and stage them, then **Continue**; **Continue** is greyed until
none is left. **Abort** gives the operation up and puts the repository back as it
was. Both work from any tab.

## History

The commits on the current branch, newest first, 100 at a time; **Older
commits…** loads more (one page at a time: a second click while a page is on its
way does nothing). A merge is marked *merge*. Click one for its message, its
author and the files it changed (a merge is shown against its first parent), and
click a file for that commit's diff. The hash can be copied from its header.

**Compare this branch with its base** at the top shows what a pull request would:
the commits and files on this branch that its base does not have. The base is
`main` or `master` by default, or whichever branch you pick in the list above the
result. If a base cannot be compared with, the error is shown alone: the commits
and files of the one before are not left under it.

## Branches

The local branches, and under **On the remote** the remote ones. Click a branch to
switch to it; a remote branch is checked out as a local branch that follows it.
The current one is ticked. A local branch whose remote was deleted is marked *gone*.

- **New branch** — type a name at the top and **Create**. It starts from the
  branch you are on.
- **Filter** narrows the list.
- The bin deletes a branch here — not on the remote — after asking. A branch that
  is not merged anywhere is asked about separately, since its commits go with it:
  **Delete anyway**. Either way the branch leaves the list at once.

## Pull requests

Pull requests come from GitHub through the `gh` command line tool, so this tab
needs `gh` installed, signed in (`gh auth login` in the terminal) and a repository
that is on GitHub. If it is not, the tab says which of those is missing. Nothing
else in the panel needs `gh`.

Under **This branch**, the pull request the checked-out branch has, or, on a
branch of your own with none, a form to open one:

- A title and a description in Markdown, and the base branch. Both are filled in
  from what the branch adds: with one commit its subject is the title, with several
  they are listed. If it cannot compare, it says so and leaves them empty.
- **Push and open** when the branch is not on the remote yet — it is pushed first —
  or **Open** when it is. A draft can be opened as well.

On the default branch it says to switch to a branch of your own first. If GitHub
cannot be asked about the branch (a timeout, a rate limit), it says that, with **Try
again**, instead of offering a form that would fail on a pull request that is already
there; the list of pull requests has the same.

Below, the list of pull requests, filtered by **Open**, **Merged**, **Closed** or
**All**. Click one to read it: the description, the checks (*Passed*, *Failed*,
*Running*), the review state, and the conversation of comments and reviews in
order, and the changed files with their diffs. They are listed as a commit's are: a letter says what happened to each, a rename shows the old name when you point at it, and a deleted file is struck through. From there you can:

- **Check out** its branch here, to try it or work on it. It is offered for a
  pull request from a fork even where its branch has the same name as one you have
  (`main` is the usual case); only a branch of this repository counts as the one
  checked out.
- **Comment**, **Approve** or **Request changes**, with the text you wrote.
- **Merge**, choosing *Squash*, *Merge commit* or *Rebase*, and whether the
  branch is deleted afterwards. It asks first, and says what the method will do
  on the base branch. *Squash* is the default. A draft is not merged from here — mark it ready on
  GitHub first — and one with conflicts is marked *has conflicts*.
- **Open on GitHub**.

## The diff view

A diff opens over the tab and goes **Back** to it. It shows the file's changes with
line numbers on both sides. It is read with the repository's own commands for
looking, but without what its config would run to look — an external diff program,
a text conversion or a clean filter written into the repository's config is not
run by opening a diff. Staging and committing behave as they do in the terminal.

What it will not show, and says:

- **A binary file** — its changes are not shown.
- **A diff over 2 MB** stops where it is cut. A pull request's whole diff may be
  up to 8 MB. When one is cut, only the file it stops in says so.
- **More than 3,000 rows** of one file: the first 3,000 are drawn, and **Show more**
  adds 3,000 at a time, so a regenerated lockfile does not freeze the page. A stash
  of many files shows the first five and offers the rest.
- More than **2,000 files** at once are cut off, and the list says so.
- A file that was only renamed or had its mode changed has no text to show.

A diff of the working tree offers **Stage**, **Unstage** and **Discard** (or
**Delete**) for the file (a file in conflict offers **Mark resolved** instead), and **Open** to open it in Files. If the file stops being
changed while it is open — it was committed, or put back — the view says so.

## A few things worth knowing

- **One write at a time.** Two `git add`s at once trip over each other's lock,
  so the portal queues writes per repository. A run of the agent working in the
  same repository is not blocked by looking.
- **Nothing here asks a question.** Commands run without a pager and without a
  prompt nobody could answer, so a push that wants a password fails with git's
  message instead of waiting. Set up SSH keys or a credential helper for the
  remote in the container; SSH runs with `BatchMode` unless `GIT_SSH_COMMAND` says
  otherwise.
- **Long waits are bounded.** Reading stops after 20 seconds; anything that
  writes or talks to a remote, or runs a commit's hooks, after three minutes.
- **It is the same repository as the agent's.** There is no separate copy: a
  commit made here is in the agent's history, and the agent's uncommitted work is
  what appears under Changes.
- **It is an extension.** The panel is the `pithagoras-git` package from the
  portal's `extensions/git`, installed when a portal starts for the first time
  and listed under Settings → Extensions → Installed like any other. Turn it off
  or remove it and the branch icon goes; install your own panel by the name
  `git` and it takes its place. Its HTTP routes are under
  `/api/x/pithagoras-git/chats/:id`; see the [HTTP API](/reference/api#git).
- Like the other panels, it docks left, right or bottom or floats; see
  [Files → Panels](/guide/files#panels). In [voice mode](/guide/voice) it is not
  offered.
