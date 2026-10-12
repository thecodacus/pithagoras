# Images

**Images** appears in the sidebar while [image generation](/guide/features#image-generation)
is switched on and has an address, or while [editing](/guide/features#editing-a-picture)
is. It is the page for making pictures with that endpoint **without a chat**, and for
looking through every picture made with it — here, and by the agent in its chats. Nothing on it needs a model or a conversation:
the page asks the portal, the portal asks the image endpoint you set up.

The form at the top has two modes, chosen with the switch above it: **Generate** and
**Edit**. Both are always there. Making and changing a picture are set up apart, each
with its own switch in **Settings → Agent → Images** (**Image generation** and **Image
editing**, with an address), and a mode that is not set up is not hidden: it says
*not set up*, and when you choose it the form says it is switched off or has no address,
with a link to the setting. The page opens in **Generate**, or in **Edit** where only
editing is set up, and it still shows what is in the gallery whatever is set up.

Those two switches decide whether the feature exists: whether the page can make or change
pictures, and whether the agent can have the `generate_image` and `edit_image` tools at all.
Whether a chat's agent actually gets a tool is set where every tool is, in the tool lists
(Settings → Agent → Tools, a project's Tools, the tools control of a chat). The page does not
depend on those lists: a tool switched off there leaves the page as it is.

## Making a picture

Describe it in the box and choose **Make the picture** (`Ctrl`/`Cmd` + `Enter` does
the same; `Enter` alone is a new line). The picture takes its place at the top of the
gallery while it is made — the same frame a chat shows, with how long it has taken
— and the picture arrives where the wait was. Closing the page, or going to another
page of the portal, does not lose it: the portal makes it, and the page shows it
again when you come back.

Under the description are the settings of the picture. They are fields of their own, and a
field you leave empty is **not sent**: the add-on's own model and size, or the endpoint's own
default, apply, and the field shows what that is as its placeholder. The page keeps them for the
next visit (the description is not kept), **Generate** and **Edit** each with their own.

| Field | Sent as | Meaning |
| --- | --- | --- |
| **Model** | `model` | Instead of the model saved for the add-on (for **Edit**, the model saved for editing). Empty uses that one. |
| **Width** and **Height** | `size`, as `1024x768` | Both, or neither: a size needs both sides, each a whole number from 64 to 8192. Empty uses the size saved for the add-on; an edit has none of its own, and an empty size sends none, since what an edit comes out as is the endpoint's to say. |
| **How many** | `n` (1 for each) | One to four. Each is a request of its own for one picture, so an endpoint that makes one at a time is not asked for a number it may refuse. |

**Advanced** adds two more, which the OpenAI image format also has:

| Field | Sent as | Meaning |
| --- | --- | --- |
| **File format** | `output_format` | PNG, JPEG or WebP, as the endpoint takes them; some take only PNG and JPEG for edits. Empty is the endpoint's own. |
| **Compression** | `output_compression` | A whole number from 0 to 100, **only with JPEG or WebP**: the field is off for the others and says so, and nothing is sent for it. |

A setting that is wrong is said when you choose **Make the picture**, with the field marked and
the keyboard moved to it, and nothing is sent.

These fields are exactly what the OpenAI image format has for a request: `model`, `prompt`, `n`,
`size`, `output_format` and `output_compression`. **Nothing else is ever sent as a field of the
request.** The old free input for "other fields of the request" is gone, for that reason: a field
that is not in the format reaches an endpoint that does not know it as a field it ignores or
refuses. Pictures that an older version made with such fields still list them under
**Details**, as they were, and **Run again** does not send them.

### Stable Diffusion settings

Some settings are not in the OpenAI image format at all, and a server cannot be told them as
fields. **stable-diffusion.cpp's server** takes them in its own way: as a JSON block inside the
prompt, `<sd_cpp_extra_args>{…}</sd_cpp_extra_args>`, which it cuts out before it generates. The
page can send them that way, and only if you say the endpoint is such a server: switch on
**Stable Diffusion extra settings** in **Settings → Agent → Images** (off by default; one switch for
generating and editing). Only stable-diffusion.cpp servers understand it, and any other endpoint would
take the block as part of the description, so leave it off for those.

**Off,** the form shows only the OpenAI fields above and **nothing of this kind is ever sent**: no
block, not even for a value that was typed or kept earlier. Those values stay in the form's memory,
and are not shown or sent. Under **Advanced** a quiet line tells where to switch the settings on, with
a link to **Settings → Agent → Images**. The agent's tools never send these settings, on or off.

**On,** the fields are plain fields of the form, right under the others in **Advanced**, in the same
style and with no box or heading of their own, and the line about switching them on is gone. A short
note says that they are for stable-diffusion.cpp servers only:

| Field | In the block as | Meaning |
| --- | --- | --- |
| **Negative prompt** | `negative_prompt` | What the picture should not show. Up to 4000 characters. |
| **Seed** | `seed` | A whole number, 0 or more, or -1 for a random one. With several pictures each takes the next seed, so that they are not the same picture. A seed is not kept for the next visit. |
| **Steps** | `sample_params.sample_steps` | The sampler's steps, 1 to 100. |
| **Strength** | `strength` | Edit only: 0 to 1. See below. |
| **Start from** | `init_image: null` | Edit only: **Noise only**. See below. |

A field left empty is left out of the block, and with none set there is no block: the description
goes as you typed it. The block is made as JSON, so quotes, line breaks and `<` in a negative prompt
are text and cannot end it early. A description that has an `<sd_cpp_extra_args>` block of its own
cannot also have settings: it is refused, since only one of the two would be read.

At most **four** pictures are being made at once — a guard against a click that costs
more than meant, not a measure of what an endpoint can do. **Stop** on a picture that
is being made drops its request, which a hosted endpoint may still charge for, and no
picture comes of it. A picture that is not made says why in its frame, in the endpoint's
words, and **Dismiss** takes it off the page. A restart of the portal ends the pictures
that were being made; nothing is made of them.

A picture has as long as the **Time limit** of the [image endpoint](/guide/features#the-endpoint)
gives it: five minutes unless you set another, from 30 to 3600 seconds, the same for
making and for changing a picture. When it runs out the frame says so, and the message
names **Settings → Agent → Images**, where the limit is raised for a slow or local model.

Each picture can cost money at a hosted endpoint, as it does for the agent.

## Changing a picture

Choose **Edit** at the top of the form. The pictures it works from are chosen right there, in
the gallery under it: **tick the box on a picture to use it**, and tick it again to take it out. A
click on the picture itself never does that, it opens the picture. A picture you tick takes a place
after the ones there (a number on the tile shows it) and appears as a
small picture in the form, in the order the request sends them. New pictures can be put in from
your own files — **Add pictures from this computer**, a drop on the form, or a paste. Describe
what should change and choose **Change the picture**. **Edit it** on a picture in the viewer
does the same for that one picture alone, and **Run again** on a change puts it back in the form
with its pictures and words.

It needs [editing](/guide/features#editing-a-picture) switched on. Where it is not, **Edit** and
**Edit it** are still there: they lead to the form, which says that image editing is switched
off or has no address, and links to the setting. With editing on and generation off, **Run
again** is there for a change only, since making a picture from a description needs generation.
An edit goes to the editing endpoint with the model set for it, and has the settings of
[the form](#making-a-picture) too: the model, a size, how many (one change each), and the file format
and compression. It needs the **Stable Diffusion** settings, under **Advanced**, for the strength and for starting from
noise (below).

- **The result is a new picture.** The original is never changed, and the new one
  is a gallery picture of its own that the viewer links back to the original.
- **Choosing in the gallery.** Every picture has a box in its corner, and while the form is in
  **Edit** it is ticked while the picture is in the edit. A click on the picture, or `Enter` on it,
  opens it in the [viewer](/guide/sessions#looking-at-a-picture), as it does in **Generate**; only the
  box chooses. The box is a round place a thumb can find (44 pixels on a touch screen), named for its
  picture ("Use Alpha in the edit"), reached with `Tab` after the picture and ticked with `Space`. In
  **Edit** the boxes are all there. The viewer has the same choice: **Use in the edit** on the picture it
  shows, which stays open, so that you can look at one picture after the other and take in the ones you
  want. The picture in the form's row opens the viewer too. Pictures a job is still making cannot be
  chosen until they are in the gallery.
- **Several pictures.** Where the editing endpoint is [said to take several](/guide/features#several-pictures)
  (**Several pictures per edit**, off until you switch it on), the form takes up to eight
  pictures, in the order the request sends them. This also makes a new
  picture from references; the endpoint cannot tell the two apart, the description does.
  - **Adding.** Tick pictures in the gallery, in the order you want them. The **Add** button
    after the last picture takes several files at once (`Ctrl`/`Shift` in the file dialog). Files
    can also be **dropped anywhere on the form** — a drop in **Generate** switches to **Edit** — and a
    picture on the clipboard (a screenshot, or "Copy image") is **pasted** with `Ctrl`/`Cmd` + `V` into
    the description or anywhere in the form. Each file is checked by its bytes as a PNG, JPEG, GIF or
    WebP; one that is not a picture is named in the message and the others are still added. While files are
    still being added (the row shows a spinner), **Change the picture** and `Ctrl`/`Cmd` + `Enter` wait, so
    that an edit is never sent without the pictures you just put in.
    A picture of the gallery can be **dragged** from it into the form too, or copied with "Copy image" and
    pasted. That is the picture itself, taken in as a tick takes it, once however often it is dropped:
    nothing is uploaded and no copy of it appears in the gallery.
  - **Their order.** Each picture has its place on it (1, 2, …), in the form and on its tile in the
    gallery, which is how the description names them: "the first picture", "the second picture". **The
    order is the one the request sends them in** (`image[]`, first to last). **Drag a picture to another
    place** in the row to move it there (a mouse or a pen; a drag does not work on every touch screen). The
    arrows under a picture move it one place earlier or later, and **×** takes it out; these are buttons,
    so a keyboard and a phone reach them with `Tab` and `Enter`, and a move is said to a screen reader.
    The picture itself opens in the [viewer](/guide/sessions#looking-at-a-picture), which steps through
    them in this order.
  - **The first one counts most.** The form says so under a row of several: the first picture is the one
    that is changed or carried over, and the others are extra references. Put the picture you mean to
    change first.
  - **The limit.** The header of the row shows how many there are of the eight. At eight the
    **Add** button goes, and the tiles of the gallery that are not in the edit are dimmed and cannot be
    chosen until one is taken out (their box says why; the picture itself can still be looked at). Pictures that did not fit — in a pick, a drop or a
    paste — are **not uploaded** and are said to be left out, never dropped without a word (if the row
    filled up while a pick was still being uploaded, the one that no longer fits stays in the gallery and
    is said to be left out). Together they may weigh 50 MB; a row that weighs more is made lighter by the
    portal when it is sent (see the next point), so **Change the picture** does not wait for it.
  - **An endpoint that takes one.** With the switch off, the form works with one picture:
    a picture you tick, add or drop takes the place of the one there is, any others in the same pick are
    said to be left out, and the form says what to switch on and links to it. Several that came in anyway
    (a change made from several, run again) are said to be too many, and **Change the picture** waits until one is left.
  - **The size limit applies to each.** The [maximum picture size](/guide/features#editing-a-picture) of
    the editing settings is held for every picture: one that is over it is scaled down by the portal to fit,
    keeping its ratio, and the change goes ahead with it. One that cannot be scaled (it is no picture that can
    be read, or it has no size to read) fails the whole change in its frame with a message such as
    "Picture 2 cannot be made to fit an edit: …", and nothing is sent.
- **Strength.** With the Stable Diffusion settings on, **Strength** under **Advanced** (0 to 1; a comma is a decimal point)
  says how far the result may go from the first picture. A high one, such as 0.75 or more, **tends** to keep
  the result close to the first picture, so that the other pictures then have little or no effect; a lower
  one gives them more influence. That is how it has been seen to behave, not a promise of what an endpoint
  does. Empty is the server's own.
- **Starting from noise.** With the Stable Diffusion settings on, **Start from**, also under **Advanced**, has two ways. **The first
  picture** (the default) is the base that is built on, and works with the strength and the mask. **Noise
  only** sends `"init_image": null` in the block, so that the run starts from noise: the description and
  all the pictures, which are still sent as `image[]`, are used as references. The strength and the mask
  do not apply then, so they are not sent, and the form turns them off and says so (a request that has
  them is refused). The first picture likely counts less there than it does as the base, so the order
  matters less; the form words it that way, as it is not something the page can check. This is not kept
  for the next visit.
- **A mask.** **Only change a part: paint a mask** shows the first picture with a
  brush: paint over what should change. The mask is made at the picture's own size,
  transparent where you painted and opaque elsewhere — the area OpenAI-style endpoints
  change — and goes with the first picture, and only with it. While a mask is on, the first picture
  in the row has a **Mask** tag and the line over the brush names it ("picture 1, …"). To
  paint on another picture, move it to the first place: the mask then starts over on that one.
  Without a stroke, no mask is sent and the whole picture may change. A mask is made with a pointer or a finger, and is not kept.
- **From this computer.** The picture is checked by its bytes as a PNG, JPEG, GIF or
  WebP, at most 25 MB, and put in the gallery, listed under the name it had, so that it can
  be looked at, changed again and deleted like the others. A file that is no picture is refused.
  Only as many pictures as the row has room for are put in the gallery.

Pictures are sent as the agent's tool sends them: under a neutral name, as they are
if they fit what an edit takes. One over the maximum size of the editing settings is
**scaled down** by the portal to fit it (either way up, the ratio kept, nothing cut, and
never scaled up). One that weighs more than the endpoint is sent (25 MB each, 50 MB together)
is made lighter: first at lower quality, then smaller; a PNG with transparency becomes a WebP
so that the transparency stays, and a PNG without becomes a JPEG; a JPEG, WebP or GIF stays
what it is. A **mask** is scaled with the first picture to the same size, taking the nearest
pixel, so that it stays a mask and its edges do not turn grey. The result of the edit is not
scaled back up: it comes out as large as the picture that was sent. Only a picture that cannot
be made to fit at all is refused, with the reason and nothing sent, and so is a file of more than
25 MB, which the portal does not read (make a smaller copy first). A picture that fits is sent
byte for byte.

## The gallery

The gallery is the main part of the page: every picture of **this page**, every one
the agent made in a **chat** with `generate_image` or `edit_image`, and every one that
lies in the folders those tools write into, newest first, in a grid that is two columns
on a phone. Under each picture, its description (the file's name for one that was found
in a folder), where it is from (the chat's title for one the agent made, the folder for
one that was found, how it was made for the others) and how long ago.

- **Paging.** 48 at a time. The next page is loaded as you near the end of what is
  there, and **Show more** does the same. A picture far down is not fetched until
  it is near the screen, so a gallery of hundreds stays quick.
- **Small copies.** The tiles, and the pictures in the form of an edit, show a small copy of
  each picture (at most 480 pixels on a side, a few tens of kilobytes instead of megabytes)
  instead of the whole file; the viewer still opens the whole file. The portal makes a copy
  itself the first time a tile asks for it, as a WebP picture, which keeps transparency, and
  keeps it beside the gallery from then on, so every later view on any device loads the
  small one. A copy is made again when the file has changed, and goes with the picture. Files
  of 48 KB or less and GIFs (which would stop moving) have no copy and are shown as they are,
  and so is an animated picture or one the portal cannot read. At most two copies are made at
  a time, so a folder of large files makes the first view slower but not heavy on the server.
  Nothing needs setting up. Pictures in the chat itself are shown as they were.
- **Filters.** *Where from*: all, made here, from chats, from folders. *How it was made*:
  all, made, changed, from this computer, not known. They are in the address
  (`/images?origin=chat&kind=edited`), so a link keeps them and **Back** goes through them.
- **Looking at one.** A click on the picture, or `Enter` on it, opens it in the [viewer](/guide/sessions#looking-at-a-picture), in both modes, never anything else;
  which steps through the gallery with the arrows, `←` and `→`, or a swipe, and loads
  the next page when it gets near the end. A picture that was changed has
  **Original** and **Edited version** at the top to go from one to the other, also when
  the original is further down than the gallery has been loaded.
- **A picture that is being made** is a tile of its own, in the place it will have, with
  the same wait a chat shows; a change shows the original under it. When it is made, it
  stays in the place the gallery has for it, in order of time, and the arrows of the
  viewer step through the grid in the order it shows.

### What the viewer adds

Beside its own buttons, the viewer has these for a gallery picture:

| Button | Does |
| --- | --- |
| **Details** | The full description, when and how it was made, the model, the size, the file format and compression, the Stable Diffusion settings it was made with, including **Start from: Noise only** for a change that started from noise (they are listed whether or not the switch is on now), the free fields an older version sent, how many pictures an edit was made from and whether it had a mask, the file's name and size, and for the agent's pictures the chat, with a link that opens it. For one that was found in a folder it says which folder, and that nothing is kept of what it was asked for. |
| **Edit it** | Puts the picture in the form, in **Edit**, to be changed, in place of any that were there. Always offered: where editing is not set up it leads to the form, which says so. While the form is already in **Edit** this button is **Use in the edit** instead, which adds the picture to the ones there, or takes it out again, and leaves the viewer open. To work from several pictures, tick them in the gallery instead. |
| **Run again** | A picture made from a description is made once more, with the model, size, file format and compression it was made with, and its Stable Diffusion settings while that switch is on: one click, one more picture. With a seed that is the same picture again, as the endpoint makes it. A change is shown in the form instead, with its pictures and its description, since its mask is not kept; that is what to check before it is made again. Not for a picture you put in yourself, or one that was found in a folder, which have no description. |
| **Delete** | See below. |
| **Open in a new tab**, **Download** | The file itself. |

### Selecting several

The box in a picture's corner selects it, in **Generate**: nothing to switch on first. Where a mouse can
hover the box shows when the picture is pointed at or has focus, and on a touch screen it is always
there; once one is ticked, all of them are. A **bar** with **n selected** appears over the gallery for as
long as something is ticked, and stays in view as you scroll:

| Button | Does |
| --- | --- |
| **Select all shown** | Takes every picture on screen. |
| **Edit** | Puts the selected pictures in the form, in **Edit**, in the order you ticked them, and lets go of the selection. Off where the endpoint [takes one picture](#changing-a-picture) and more are selected, or more than eight; the reason is written on the bar, so that a phone and a keyboard have it too, not only in a tooltip. |
| **Download** | Saves each selected picture as a file of its own; the browser may ask once whether this page may download several. |
| **Delete** | Takes them away after asking. |
| **Clear selection** | Lets go of the selection; so does `Esc`. |

A click on a picture opens it and does not change what is selected. In **Edit** the boxes are the
pictures of the [edit](#changing-a-picture) and there is no bar; a picture is deleted from the viewer
there, or after going back to **Generate**. What is selected belongs to what is shown: a change of
filter, or **Back** to another one, clears it, so that nothing that is not on screen is deleted with what
is, and so does going to **Edit**.

### Deleting

A picture is deleted with its file. For a picture the page made that is the portal's own
folder, and the question can be switched off in Settings like the others that delete.

The agent's pictures are files in the **folder a chat works in**
(`generated-images`), and they are not the page's to take lightly: deleting one removes
it from there for good, so the chats that work there and their Files panel lose it. That
is asked **every time, whatever Settings says**, with the chat or the folder named, and a
delete of several says how many of them are in a folder. A picture that was found in a
folder is deleted the same way.

### What the gallery lists

The page lists and serves pictures only from the places the portal knows: its own
folder, `images`, under the portal's data folder, and the `generated-images` folder of
the folders the agent works in — the home of every agent, the projects, and the folder of every chat. It
never opens a path the page names — a picture is asked for by its id — and every file is
opened with the checks the Files panel's pictures have: a path inside the folder, no
link followed out of it, and what its bytes say it is.

- The agent's pictures are listed from the moment its tools save them, with what they
  were asked for. **Pictures that nobody listed are found as well:** the ones made before
  the gallery existed. The portal looks in
  `generated-images` of every agent's home, of every project and of every folder a chat works in, and
  lists each file there whose first bytes say it is a PNG, JPEG, GIF or WebP, of at most
  25 MB, whatever it is called. A link is never followed, a file that is no picture is
  left out, and nothing else in those folders — a project's other files, folders inside
  `generated-images`, a hidden file — is looked at. It never looks in a folder the portal
  does not know, so a path somewhere else on the machine is never listed.
- A picture that was found is *from the folder*: which chat made it cannot be told, since
  the chats of a project share its folder and the one that made it may be gone, and what
  it was asked for was not kept. Its *how it was made* is read from its name — `image-…`
  for one made from a description, `…-edited` for a change — and is *not known* for any
  other. It is one entry with a picture the agent recorded, never two: the same file is
  the same picture. It has no description, so a tile carries its file name instead, and
  there is no **Run again** for it; **Edit it** works as for any picture.
- A name the agent used before, whose file was taken away, is a new picture when it makes
  one under it again: the gallery shows the new one with its own description and time.
  Chats that work in one folder, such as the chats of a project, share its files, so this
  holds across them, and a picture one of them made is the original of an edit another makes.
- **The page's own pictures are kept until you delete them.** Nothing is removed by age
  or by how many there are, and the pictures you put in from your computer, up to 25 MB
  each, are kept the same way. **kept from this page**, in the header, shows what they take
  of the disk; the agent's pictures are in their chats' folders and are not counted.
- A picture whose file is gone — taken in the Files panel, or by hand — is dropped from
  the list the next time it is loaded, and so is one that cannot be served any more, such
  as one whose `generated-images` has been replaced by a link out of the folder (what is
  moved to another disk and linked back). When a chat is **deleted**, its pictures stay in
  the gallery, as pictures of its folder with what they were asked for: the files are in
  a folder that is not the chat's to take away, and the portal goes on looking in it. A
  chat that is deleted while its folder cannot be reached has no folder to leave them in,
  and they go from the list. A chat's folder that cannot be reached for the moment, such
  as a drive that is not mounted, is not a file that is gone: its pictures stay in the
  list, are shown again when it is back, and a delete of one says it could not reach the
  file. A picture that was found has no chat to keep it, so it is dropped with its
  folder and found again when the folder is back, and a delete of one says the same while
  the folder cannot be reached. One that has what it was asked for, because its chat was
  deleted, or an edit that was made of it, is not dropped while its folder is out of
  reach, such as on a morning when the drive is not mounted: it is the same picture,
  with its description and its link to the original, when the folder is back. When the
  portal itself removes the folder, by deleting a project or an agent with its folder,
  these go with it.
- **Deleting an agent** does the same with its chats' pictures. With **Keep its folder**
  they stay in the gallery, with what they were asked for, as pictures of that folder
  (named by its folder, as no agent has it), and an agent made under the same name takes
  them up again. With **Delete its folder too** the files are gone, and so are they, those
  of its routines' runs included.
- Looking through the folders for the first time reads the first bytes of every file
  there; after that the portal only reads the folders' names, and opens a file again only
  when it is new or has changed, so a gallery of hundreds stays quick.
- The list is refreshed when you return to the tab, every half minute while it is on
  screen, and with **Refresh**, so what the agent makes while you are here shows up.
  What the agent's tools save is listed at once; the look through the folders for
  pictures nobody listed, and for files that are gone, is made when the page is
  opened and with **Refresh**, and while the page stays open at most once a minute,
  so a gallery of thousands does not keep the portal busy.

## What it takes from the endpoint

The same as the agent's tools, because it is the same code: the address, model, size and
key are read when a picture is made; the key goes to that address and nowhere else and
**never reaches the page**; a picture sent as an address is fetched only from the
endpoint's own host or over https from the public internet; what comes back must be a
PNG, JPEG, GIF or WebP by its first bytes and at most 20 MB, within the time limit (five minutes
unless you set another). See
[Opt-in features](/guide/features#what-is-accepted).

| | |
| --- | --- |
| Stored as | The files of the page's pictures in `images` under the portal's data folder, and the list in the portal's own database (`images`). Jobs are kept in memory. |
| API | [`/api/images`](/reference/api#images) |
