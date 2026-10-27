# Media

**Media** appears in the sidebar's **Extensions** group while [image generation](/guide/features#image-generation) or
[editing](/guide/features#editing-a-picture) or [video generation](/guide/features#video-generation) is
switched on and has an address. It is the page for making pictures and videos with those endpoints
**without a chat**, and for looking through every picture and video made with them — here, and by the
agent in its chats. Nothing on it needs a model or a conversation: the page asks the portal, the portal
asks the endpoint you set up.

Media is an extension, `pithagoras-media` from the portal's `extensions/media`,
installed when a portal starts for the first time and listed under Settings →
Extensions → Installed like any other: switch it off or remove it, and the page,
its settings, the agent's picture and video tools (`show_image` among them) and
their cards in the chat go. What it keeps, its gallery and the pictures and
videos made on the page, stays in its folder of the data folder for when it is
back. A portal that had Media before it was an extension handed what it kept
over to it: see [Upgrading](/guide/upgrading#media-is-an-extension).

The form at the top is for one kind at a time. Where both are made, **Make: A picture / A video** above
it chooses which; it follows the gallery's filter (with only videos shown, the form for videos is open) until
you choose, and keeps the words you typed in each. Where only one kind is made, that form is the only one.
The gallery under it holds both kinds together, with a filter for **All**, **Pictures** or **Videos**.

Both are set up in one place, Media's page in Settings, **Settings → Extension settings → Media**
(`/settings/x/pithagoras-media`): the **Image model** (with **Image generation** and
**Image editing**, each with an address) and the **Video model** (**Video generation**, with an address), two sections that open
and close, with their switches always in view. Those
switches decide whether the feature exists: whether the page can make or change pictures and make videos, and
whether the agent can have the `generate_image`, `edit_image`, `generate_video` and `show_video` tools at all
(`show_image` comes with Media, and is there while Media is). Whether a
chat's agent actually gets a tool is set where every tool is, in the tool lists (Settings → Agent → Tools, a
project's Tools, the tools control of a chat), where the picture and video tools are one group, `pithagoras-media`. The page
does not depend on those lists: a tool switched off there leaves the page as it is.

The page's address keeps what is shown (`/x/pithagoras-media/media?show=videos&origin=chat&kind=animated`), so a
link keeps it and **Back** goes through it.

## Pictures

The form for pictures has two modes, chosen with the switch above it: **Generate** and **Edit**. Both are
always there. Making and changing a picture are set up apart, each with its own switch in **Settings → Extension
settings → Media**, and a mode that is not set up is not hidden: it says *not set up*, and when you choose it the form says
it is switched off or has no address, with a link to the setting. The page opens in **Generate**, or in **Edit**
where only editing is set up, and it still shows what is in the gallery whatever is set up.

### Making a picture

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
| **Model** | `model` | Instead of the model saved for the add-on (for **Edit**, the model saved for editing). Empty uses that one. With [reference pictures](#reference-pictures) it is always the model saved for editing: the field shows it and is off. |
| **Width** and **Height** | `size`, as `1024x768` | Both, or neither: a size needs both sides, each a whole number from 64 to 8192. Empty uses the size saved for the add-on, with reference pictures too; an edit has none of its own, and an empty size sends none, since what an edit comes out as is the endpoint's to say. |
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

#### Stable Diffusion settings

Some settings are not in the OpenAI image format at all, and a server cannot be told them as
fields. **stable-diffusion.cpp's server** takes them in its own way: as a JSON block inside the
prompt, `<sd_cpp_extra_args>{…}</sd_cpp_extra_args>`, which it cuts out before it generates. The
page can send them that way, and only if you say the endpoint is such a server: switch on
**Stable Diffusion extra settings** in **Settings → Extension settings → Media** (off by default; one switch for
generating and editing). Only stable-diffusion.cpp servers understand it, and any other endpoint would
take the block as part of the description, so leave it off for those.

**Off,** the form shows only the OpenAI fields above and **nothing of this kind is ever sent**: no
block, not even for a value that was typed or kept earlier. Those values stay in the form's memory,
and are not shown or sent. Under **Advanced** a quiet line tells where to switch the settings on, with
a link to Media's page in Settings. The agent's tools never send these settings, on or off, but for one: a picture
`generate_image` makes with references starts from noise while the switch is on (see [Reference pictures](#reference-pictures)).

**On,** the fields are plain fields of the form, right under the others in **Advanced**, in the same
style and with no box or heading of their own, and the line about switching them on is gone. A short
note says that they are for stable-diffusion.cpp servers only:

| Field | In the block as | Meaning |
| --- | --- | --- |
| **Negative prompt** | `negative_prompt` | What the picture should not show. Up to 4000 characters. |
| **Seed** | `seed` | A whole number, 0 or more, or -1 for a random one. With several pictures each takes the next seed, so that they are not the same picture. A seed is not kept for the next visit. |
| **Steps** | `sample_params.sample_steps` | The sampler's steps, 1 to 100. |
| **Strength** | `strength` | Edit only: 0 to 1. See below. |
| **Start from** | `init_image: null` | Edit only: **Noise only**. See below. A picture made with [reference pictures](#reference-pictures) always has it while the switch is on. |

A field left empty is left out of the block, and with none set there is no block: the description
goes as you typed it. The block is made as JSON, so quotes, line breaks and `<` in a negative prompt
are text and cannot end it early. A description that has an `<sd_cpp_extra_args>` block of its own
cannot also have settings: it is refused, since only one of the two would be read.

#### Reference pictures

A new picture can be made **with reference pictures** as well as the description: a character sheet, a
product, a style, carried into a completely new picture, in another scene or pose. **Use reference pictures**,
under the description in **Generate**, opens a row for them; **Leave out the reference pictures** closes it and
empties it. While it is open the gallery's boxes choose references, in the order you tick them ("Use A fox sheet as a
reference"), and the viewer has **Use as a reference** for the picture it shows; files can be added from this
computer, dropped on the form or pasted, as in **Edit** (a drop in **Generate** adds references only while the row
is open; otherwise it starts an edit, as it always did). The row is the one **Edit** has, with the same places,
arrows, drag and **×**: the description names them by their place ("the first picture"), and the endpoint gets them
in this order.

The OpenAI image format has no route that takes pictures to make a new one, only `images/edits`, so a picture with
references is asked of the **editing endpoint**: it needs [editing](/guide/features#editing-a-picture) switched on
(the row says so, with a link to the setting, where it is not), and more than one reference needs **Several pictures
per edit**, like an edit (with it off, a reference you add takes the place of the one there is). It is still a **new
picture**: in the gallery it is *Made from a description*, kept under a name of its own, never tied to a reference as
an edit is to its original, and **Details** lists how many reference pictures it was made with. The request is the
edit's — the references as `image` or `image[]`, checked, limited and scaled like an edit's pictures — with:

- **Always the editing model.** A model typed for making pictures need not be one the editing endpoint has, so while
  there are references the **Model** field shows the editing model and is off, with a note under it ("Reference
  pictures use the editing model: …", or the endpoint's own where none is saved). What you typed is kept, and comes
  back and is sent again once the references are left out. The portal ignores a `model` sent with references, so the
  agent's tool, the form and **Run again** all use the editing model.
- **A size, always where there is one**: the field's, else the size saved for the add-on. Without one, a
  stable-diffusion.cpp server makes the picture in the size and shape of the first reference, and the form says
  so while no size is set anywhere.
- **Starting from noise**, as `"init_image": null` in the `<sd_cpp_extra_args>` block, so that a stable-diffusion.cpp
  server uses the references as references and does not rework the first one into the result. That block goes only
  while **Stable Diffusion extra settings** is on, since any other server would read it as words of the description:
  the portal cannot tell which server it is. **With the switch off**, nothing is added: an OpenAI-style server takes
  the pictures of an edit as references either way, but a stable-diffusion.cpp server then starts from the first
  reference, and the picture may come out as a reworked copy of it. The form says so in a warning under the row, with
  a link to the switch; with it on it says the picture starts from noise, and **Details** lists **Start from: Noise only**.
  With it on, a description that has an `<sd_cpp_extra_args>` block of its own is refused with references, since the
  server would read that block and not the one that starts from noise.

The other settings (format, compression, and the Stable Diffusion ones while that switch is on) go as for any
picture; there is no strength and no mask. A reference over the [maximum picture size](/guide/features#editing-a-picture)
or the weight an edit takes is scaled down as an edit's picture is, and the warning above the form then says **A
reference picture was scaled down to fit what the editing endpoint takes.**, with which one and how ("The reference was
scaled down from … to fit what the editing endpoint takes."): it is not a picture that was changed, so the words for an
edit are not used. **Run again** on such a picture makes it again with the same references,
when they are all still in the gallery, and says so when they are not. Without references the request is the
`images/generations` one it always was.

At most **four** pictures are being made at once — a guard against a click that costs
more than meant, not a measure of what an endpoint can do. **Stop** on a picture that
is being made drops its request, which a hosted endpoint may still charge for, and no
picture comes of it. A picture that is not made says why in its frame, in the endpoint's
words, and **Dismiss** takes it off the page. A restart of the portal ends the pictures
that were being made; nothing is made of them.

A picture has as long as the **Time limit** of the [image endpoint](/guide/features#the-endpoint)
gives it: five minutes unless you set another, from 30 to 3600 seconds, the same for
making and for changing a picture. When it runs out the frame says so, and the message
names **Media** in Settings, where the limit is raised for a slow or local model.

Each picture can cost money at a hosted endpoint, as it does for the agent.

### Changing a picture

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
  pictures, in the order the request sends them. This also combines pictures into a new one, starting
  from the first; for a new picture of the same character, object or style, use
  [reference pictures](#reference-pictures) in **Generate**, which start from noise.
  - **Adding.** Tick pictures in the gallery, in the order you want them. The **Add** button
    after the last picture takes several files at once (`Ctrl`/`Shift` in the file dialog). Files
    can also be **dropped anywhere on the form** — a drop in **Generate** switches to **Edit**, unless its
    reference pictures are open, which it adds to — and a
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

## Videos

::: warning Only a stable-diffusion.cpp server works
Video generation works only with a [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
server, through its native API (`/sdcpp/v1`), with a video model started on it. **An OpenAI-style `/v1` endpoint, or
another video server, does not work.** The same note is under the address in Media's page in Settings.

Through llama-swap the address is `http://host:port/upstream/<model>`, where `<model>` is the llama-swap name of
the model that runs the stable-diffusion.cpp server: the portal adds `/sdcpp/v1/…` to it.
:::

How a video is asked for is a backend's business and nothing else in the portal knows it, so another can be added
later; there is none yet (see [What it takes from the endpoint](#what-it-takes-from-the-endpoint)).

### Making a video

Describe it in the box and choose **Make the video** (`Ctrl`/`Cmd` + `Enter` does the same;
`Enter` alone is a new line). A video takes **minutes**, so it is made as a job on the
portal: the video takes its place at the top of the gallery as a frame that says what is
going on, and arrives where the wait was. Closing the page, or going to another page of the
portal, does not lose it: the portal goes on, and the page shows it again when you come back.

Under the description are the settings of the video. They are fields of their own, and a
field you leave empty is **not sent**: the add-on's own setting, or the server's own default,
applies, and the field shows what that is as its placeholder. The page keeps them for the next
visit (the description and the seed are not kept).

| Field | Sent as | Meaning |
| --- | --- | --- |
| **Model** | `model` | Instead of the model saved for the add-on. Empty uses that one. stable-diffusion.cpp's own server runs the one model it was started with and ignores it; a gateway in front of it may choose a model by it. |
| **Width** and **Height** | `width`, `height` | Both, or neither: each a whole number from 64 to 4096. What a model takes is its own: many need sides that are multiples of 16 or 32. A server may refuse a size or bring it to one its model takes, and then the video comes out at another size than asked; the Details show the size that was asked for. Empty uses the size saved for the add-on, and then the server's. |
| **Frames** | `video_frames` | How many frames the video has, a whole number from 1 to 1000. A model takes only some counts, and the server may round the count to one it takes, up or down, by a rule of its model; the video's Details say how many frames it made, as the server reports them, and the count that was asked for beside it where they differ ("80 (asked for 81)"). |
| **Frame rate** | `fps` | Frames per second, from 1 to 120. A video plays for its frames over its frame rate: under the fields the form says so for what it has, "33 frames at 16 frames per second play for about 2.1 s". |
| **How many** | — | One to four. Each is a request of its own for one video, so a server that makes one at a time queues the rest. |

**Advanced** adds four more:

| Field | Sent as | Meaning |
| --- | --- | --- |
| **Seed** | `seed` | A whole number, 0 or more, or -1 for a random one. With several videos each takes the next seed, so that they are not the same video. A seed is not kept for the next visit. |
| **Steps** | `sample_params.sample_steps` | The sampler's steps, 1 to 100. |
| **Strength** | `strength` | A number from 0 to 1 (a comma is a decimal point). How strongly the first and last frame hold the video; what a model does with it is its own. It is sent only when set, whether or not a picture goes with it, and empty leaves it to the server's own (0.75 for stable-diffusion.cpp). |
| **Negative prompt** | `negative_prompt` | What the video should not show. Up to 4000 characters. |

A setting that is wrong is said when you choose **Make the video**, with the field marked and
the keyboard moved to it, and nothing is sent. A description is at most 4000 characters.

#### First and last frame

**Start from a picture** above the settings chooses the **first frame** of the video: a
picture from the gallery, in a dialog of its own, or one from this
computer (it is put in the gallery, as a picture for an edit is). The description then says
what happens next. The picture is sent as `init_image`; the server brings it to the video's size
itself. **Remove** (the **×** beside it) makes the next video from the description alone again.

**End on a picture**, beside it, chooses the **last frame** in the same way: the video then ends on that
picture. It is optional, with or without a first frame, and is sent as `end_image`. The portal sends it only to a
server that says it takes one: stable-diffusion.cpp lists `end_image` under `features_by_mode.vid_gen` in its
capabilities. For a server that does not list it (or does not answer the question) the video is not made, and its
frame says so in plain words; the picture is never dropped by the portal, because a video that ends somewhere else
than you asked is not the video you wanted. **That is all the check can promise.** The server reports `end_image` for
every video model it runs, and **only some models use it**: one that does not (a text-to-video model, say) makes the
clip without the last frame and says nothing, so look at the end of the clip. A video made with a last frame shows
it in its Details, and **Run again** needs the pictures to be in the gallery still.

In the [viewer](/guide/sessions#looking-at-a-picture) of a picture, **Make a video from it** (while video
generation is on) opens the form for videos with that picture as the first frame.

### While a video is made

Each video that is being made is a tile of its own, in the place it will have, with how long
it has taken and where it is: **Waiting its turn on the server** (with its place, when the
server says it), or **Being made on the server**. A stable-diffusion.cpp server makes one video
at a time and queues the others, so a request may wait a while before it begins.

At most **four** videos are being made at once — a guard against a click that costs more than
meant, not a measure of what a server can do. **Stop** on a video that is being made ends the
portal's wait and makes no video of it. A video that is still waiting in the server's queue is
taken out of it; **one the server has begun cannot be stopped there** (its API has no way to), and
goes on to its end — which a hosted endpoint may still charge for. A video that is not made says
why in its frame, in the server's words, and **Dismiss** takes it off the page. A restart of the
portal ends the videos that were being made; nothing is made of them, though the server may finish
them.

A video has as long as the **Time limit** of the [video endpoint](/guide/features#the-video-endpoint)
gives it, from the request to the file, the wait in the server's queue included: **half an hour**
unless you set another, from 30 to 14400 seconds. When it runs out the frame says so, and the
message names **Media** in Settings, where the limit is raised for a slow or local model.

Videos made on this page are kept until you delete them. Where you want a ceiling, the **Disk
limit** of the video model in Settings is how many megabytes they may take together: at the limit
**no new video is made on the page** — the form says why — until some are deleted or the limit is
raised. Nothing is ever deleted for it. **kept from this page**, in the header, shows what they take
of the disk (and the limit, when there is one); the agent's videos are in their chats' folders and are
not counted.

## The gallery

The gallery is the main part of the page: every picture and video of **this page**, every one the agent made
in a **chat** with `generate_image`, `edit_image` or `generate_video`, and every one that lies in the folders
those tools write into, newest first, in one grid that is two columns on a phone. Under each, its description (the
file's name for one that was found in a folder), where it is from (the chat's title for one the agent made, the
folder for one that was found, how it was made for the others), a video's length, and how long ago. A video's tile
shows its first frame, with a mark that it plays.

- **Both, or one.** Where both kinds are made, *Show* is **All**, **Pictures** or **Videos**; where only one is,
  that is all the page shows, and there is no choice. Choosing one kind also opens its form, until you choose
  the other. A picture or a video started while the filters would leave it out — the other kind is shown, or a
  kind or an origin it does not have — lets go of them, so that the one being made has its tile.
- **Together.** The portal keeps a list of pictures and a list of videos, and the page asks for a page of each
  and shows them as one, in the order of the time each was made. Where a list has more than has been loaded,
  nothing older than its last item is shown yet, so that nothing is left out between: **Show more**, and nearing
  the end of the grid, read on in the list that stopped first.
- **Filters.** *Where from*: all, made here, from chats, from folders. *How it was made*: the kinds there are of
  what is shown. With both shown they are made, changed, from a picture, from this computer and not known; a
  kind that only pictures have (changed, from this computer) leaves the videos out, and one that only videos
  have (from a picture) leaves the pictures out. Pictures alone have made, changed, from this computer and not
  known; videos alone, from a description, from a picture and not known. All of it is in the address, so a link
  keeps it and **Back** goes through it.
- **Looking at one.** A click on a tile, or `Enter` on it, opens it in the viewer of its kind and never does
  anything else. A picture opens in the [picture viewer](/guide/sessions#looking-at-a-picture), a video in
  the video viewer, and each steps through the ones of its kind, in the order of the grid.

### Pictures in the gallery

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
- **The viewer.** It steps through the gallery with the arrows, `←` and `→`, or a swipe, and loads
  the next page when it gets near the end. A picture that was changed has
  **Original** and **Edited version** at the top to go from one to the other, also when
  the original is further down than the gallery has been loaded.
- **A picture that is being made** is a tile of its own, in the place it will have, with
  the same wait a chat shows; a change shows the original under it. When it is made, it
  stays in the place the gallery has for it, in order of time, and the arrows of the
  viewer step through the grid in the order it shows.

### Videos in the gallery

- **Paging.** 24 at a time (a video is much heavier than a picture). The next page is loaded as you
  near the end of what is there, and **Show more** does the same.
- **Posters.** A tile shows the video's **first frame**. Where the portal can make a small
  picture of it it does so itself, the first time a tile asks, keeps it beside the gallery, and the
  tiles show that, a few kilobytes instead of megabytes; for that it needs **ffmpeg**, found on the
  `PATH` or where the `FFMPEG_PATH` environment variable says. Without ffmpeg nothing else changes:
  a tile fetches the start of its video and the browser draws the first frame, only once the tile is
  near the screen. The same is the tile of a video ffmpeg cannot make a frame of (an MP4 whose index is at the end,
  for one, cannot be read from a pipe): the video is still there and plays, it is not tried again until the file changes
  or the portal restarts, and its tile shows the first frame the browser draws. A poster that fails for a reason that is not the video's — ffmpeg gone for a moment, a full disk, a frame that took too long — is tried again by the next request. A poster is made again when the file has changed, and goes with the video. At most
  two are made at a time. A video is handed to ffmpeg on its standard input, from the file that was
  checked, and ffmpeg may open nothing else.
- **Playing one.** The viewer is a dialog with the
  browser's own player — play and pause, the slider, the volume, full screen — which starts playing
  when it opens, steps through the gallery with the arrows on its sides (or `←` and `→` while the
  player does not have the keyboard: in the player they move through the video), and loads the next
  page when it gets near the end. `Esc`, the browser's Back button, or a click beside the video
  closes it. **Open in a new tab** and **Download** are the file itself.
- **A video that is being made** is a tile of its own, with the wait; when it is made it stays in
  the place the gallery has for it, in order of time.
- **Playback in parts.** Videos are served in the parts a player asks for (HTTP range requests), so
  a video of tens of megabytes starts at once and the slider can be moved without fetching it all.

### Clips a browser cannot play

**Nothing an endpoint sends is refused or dropped.** A finished clip is stored as a file in the media folder whatever its
container is: a WebM, an MP4, an AVI, an animated WebP, a GIF, an Ogg or QuickTime file, an EBML (Matroska) file of any document
type, or a file nobody can tell the kind of. Its first bytes say what it is, never its name or what the server calls
it, and the file is named for that (`.webm`, `.avi`, `.bin` for an unknown one).

- **A WebM and an MP4 play.** A WebM is an EBML file whose document type is `webm` or `matroska`, which is how
  stable-diffusion.cpp writes the clips it makes.
- **Any other format is a tile of its own kind**, with its real type in words (**AVI**, **WebP**, **EBML (foo)**,
  **Unknown**) and a short note that a browser cannot play it here. A click opens it to be **downloaded**; **Details** says
  the format. It is sent to be saved and never shown, as the type its bytes say (`application/octet-stream` for an unknown
  file), with a content security policy that would stop it running anything. It has no poster.
- **A playable copy, where ffmpeg is there.** For a clip a browser cannot play, the viewer offers **Make a WebM copy to
  play** when the portal has an `ffmpeg` (the one that makes the posters). The copy is made on request, never
  by itself, kept beside the gallery in `video-copies`, and plays in the viewer; the original is always kept and **Download**
  still gives it. Without ffmpeg there is no such button, and the original is there to download.
- **What a copy is bounded by.** A few megabytes of video can declare pictures of many gigabytes, so ffmpeg is first asked how
  large the picture is, and a clip over **4096 by 4096 pixels** (or one whose picture ffmpeg cannot name) is refused before
  anything is converted; the original is still there to download. The copy is scaled down to fit **1280 by 1280** pixels
  (a smaller picture keeps its size, it is never enlarged) and made in 4:2:0, which every browser plays. A conversion
  decodes with one thread and encodes with two, looks only five frames ahead, may take at most **3 minutes** (a look at the picture, 20 seconds), stops at the **100 MB** a clip may have, and
  is run with at most **4 GB** of address space and no single block of memory over **512 MB**. The cap on the address
  space is set where the portal runs on Linux or macOS; on Windows only the cap on one block of memory applies.
- **The agent's clips.** `generate_video` keeps such a clip in the chat's folder too, and tells the agent that a browser
  cannot play it in the chat; the chat says so in a short line, with the format and a link to the gallery, and draws no
  player. `show_video` still plays only a WebM or an MP4.

### What the viewer adds

Beside its own buttons, the viewer of a picture has these:

| Button | Does |
| --- | --- |
| **Details** | The full description, when and how it was made, the model, the size, the file format and compression, the Stable Diffusion settings it was made with, including **Start from: Noise only** for a change, or a picture with reference pictures, that started from noise (they are listed whether or not the switch is on now), the free fields an older version sent, how many pictures an edit was made from and whether it had a mask, how many reference pictures a new picture was made with, the file's name and size, and for the agent's pictures the chat, with a link that opens it. For one that was found in a folder it says which folder, and that nothing is kept of what it was asked for. |
| **Edit it** | Puts the picture in the form, in **Edit**, to be changed, in place of any that were there. Always offered: where editing is not set up it leads to the form, which says so. While the form is already in **Edit** this button is **Use in the edit** instead, which adds the picture to the ones there, or takes it out again, and leaves the viewer open. To work from several pictures, tick them in the gallery instead. |
| **Run again** | A picture made from a description is made once more, with the model, size, file format and compression it was made with, and its Stable Diffusion settings while that switch is on: one click, one more picture. One made with reference pictures is made with the same ones, which must all still be in the gallery (it says so when they are not), and needs editing set up. With a seed that is the same picture again, as the endpoint makes it. A change is shown in the form instead, with its pictures and its description, since its mask is not kept; that is what to check before it is made again. Not for a picture you put in yourself, or one that was found in a folder, which have no description. |
| **Make a video from it** | Only while [video generation](/guide/features#video-generation) is on: opens the form for videos with this picture as the first frame of the video to be made (see [First and last frame](#first-and-last-frame)). |
| **Delete** | See below. |
| **Open in a new tab**, **Download** | The file itself. |

and the viewer of a video these:

| Button | Does |
| --- | --- |
| **Details** | The full description, when and how it was made, the model, the size, the frames and frame rate as asked and as the server made them, the length, the seed, the steps, the strength, the negative prompt, the first and the last frame (a small copy of the picture, while it is in the gallery), the file's name and size, and for the agent's videos the chat, with a link that opens it. For one found in a folder it says which folder, and that nothing is kept of what it was asked for. |
| **Run again** | A video made from a description is made once more, with the model, size, frames, frame rate and the other settings it was made with: one click, one more video (with a seed that is the same video again, as the server makes it). One made from a picture needs that picture to be in the gallery still, and says so when it is not. Not for one found in a folder, which has no description, and not for one the agent made from a picture of its own folder. |
| **Delete** | See below. |
| **Open in a new tab**, **Download** | The file itself. |

### Selecting several

The box in a tile's corner selects it: nothing to switch on first, unless the form for pictures is in **Edit**,
where the boxes of the pictures are the edit's (see [Changing a picture](#changing-a-picture)). Where a mouse can
hover the box shows when the tile is pointed at or has focus, and on a touch screen it is always
there; once one is ticked, all of them are. Pictures and videos can be ticked together. A **bar** with **n selected**
appears over the gallery for as long as something is ticked, and stays in view as you scroll:

| Button | Does |
| --- | --- |
| **Select all shown** | Takes every tile on screen. |
| **Edit** | Pictures only. Puts the selected pictures in the form, in **Edit**, in the order you ticked them, and lets go of the selection. Off where a video is selected, where the endpoint [takes one picture](#changing-a-picture) and more are selected, or more than eight; the reason is written on the bar, so that a phone and a keyboard have it too, not only in a tooltip. Not there while only videos are shown. |
| **Download** | Saves each selected picture or video as a file of its own; the browser may ask once whether this page may download several. |
| **Delete** | Takes them away after asking. |
| **Clear selection** | Lets go of the selection; so does `Esc`. |

A click on a tile opens it and does not change what is selected. In **Edit** the boxes of the pictures are the
pictures of the [edit](#changing-a-picture), a video has none, and there is no bar; a picture is deleted from the
viewer there, or after going back to **Generate**. What is selected belongs to what is shown: a change of
filter, or **Back** to another one, clears it, so that nothing that is not on screen is deleted with what
is, and so does going to **Edit**.

### Deleting

A picture or a video is deleted with its file. For one the page made that is Media's own
folder, and the question can be switched off in Settings like the others that delete. Pictures and videos
selected together are asked about once.

The agent's pictures and videos are files in the **folder a chat works in** (`generated-images`,
`generated-videos`), and they are not the page's to take lightly: deleting one removes
it from there for good, so the chats that work there and their Files panel lose it. That
is asked **every time, whatever Settings says**, with the chat or the folder named, and a
delete of several says how many of them are in a folder. One that was found in a
folder is deleted the same way.

### What the gallery lists

The page lists and serves pictures and videos only from the places the portal knows: its own folders,
`images` and `videos`, in Media's folder of the portal's data folder, and the `generated-images` and `generated-videos` folders
of the folders the agent works in — the home of every agent, the projects, and the folder of every chat. It
never opens a path the page names — a picture or video is asked for by its id — and every file is
opened with the checks a picture of a chat's folder has: a path inside the folder, no
link followed out of it, and what its bytes say it is.

#### Pictures

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

#### Videos

This is the rule for pictures, applied to videos, by the same code:

- The agent's videos are listed from the moment its tool saves them, with what they were asked for.
  **Videos that nobody listed are found as well:** the portal looks in `generated-videos` of every
  agent's home, of every project and of every folder a chat works in, and lists each file there whose
  first bytes say it is some kind of clip, of at most **100 MB**, whatever it is called: a **WebM** (an EBML file
  whose document type, read from its header, is `webm` or `matroska`, which is what stable-diffusion.cpp writes) or an
  **MP4**, which play, and an AVI, a QuickTime movie, a WebP, a GIF, an Ogg or an EBML file of another type, which are
  listed as what they are and offered as downloads (see [Clips a browser cannot play](#clips-a-browser-cannot-play)).
  A file the bytes say nothing of is listed only if it is named as the tool names such a clip, with
  the extension `.bin` (`video-20261001-101500-a1b2c3.bin`; the same name with another extension is left alone): the
  folder may hold other things. A link is never followed, and nothing else in
  those folders is looked at.
- A video that was found is *from the folder*: which chat made it cannot be told, and what it was
  asked for was not kept. It is one entry with a video the agent recorded, never two. It has no
  description, so a tile carries its file name instead, and there is no **Run again** for it.
- When a chat is **deleted**, its videos stay in the gallery, as videos of its folder with what they
  were asked for: the files are in a folder that is not the chat's to take away. A folder that cannot
  be reached for the moment, such as a drive that is not mounted, is not a file that is gone: its
  videos stay in the list and are shown again when it is back. A video whose file is gone is dropped
  from the list the next time it is loaded. While a video's file cannot be opened (its folder is out
  of reach, or the file has grown past 100 MB) it keeps the format it has (read from the start of the
  file when it is only too large, from its name when it cannot be read) instead of turning into an **Unknown** file, and its
  **Details** say why.
- **Deleting an agent** or a project with its folder takes its chats' videos with it; with **Keep its
  folder** they stay, as videos of that folder.
- The list is refreshed when you return to the tab, every half minute while it is on screen, and with
  **Refresh**; what the agent's tool saves is listed at once, while the look through the folders for
  videos nobody listed is made when the page is opened and with **Refresh**, and while the page stays
  open at most once a minute.

## What it takes from the endpoint

### Pictures

The same as the agent's tools, because it is the same code: the address, model, size and
key are read when a picture is made; the key goes to that address and nowhere else and
**never reaches the page**; a picture sent as an address is fetched only from the
endpoint's own host or over https from the public internet; what comes back must be a
PNG, JPEG, GIF or WebP by its first bytes and at most 20 MB, within the time limit (five minutes
unless you set another). See
[Opt-in features](/guide/features#what-is-accepted).

| | |
| --- | --- |
| Stored as | In Media's folder of the portal's data folder, `extension-data/pithagoras-media`: the files of the page's pictures in `images`, their small copies in `image-thumbs`, and the list in Media's own database, `media.db` (`images`). Jobs are kept in memory. |
| API | [`/api/x/pithagoras-media/images`](/reference/api#images) |

### Videos

The same as the agent's tool, because it is the same code: the address, model, size, frames, frame
rate and key are read when a video is made; the key goes to that address and nowhere else and **never
reaches the page**; and what comes back is kept **whatever it is**: a finished clip is never failed by its format. It
must be a clip at all (an answer with no video in it fails), valid base64, at most 100 MB, and within the time limit.
See [Opt-in features](/guide/features#video-generation). A job that fails says why, and its message is shown whole in
its frame.

For a stable-diffusion.cpp server the portal uses its **native job API** (`/sdcpp/v1`), because a
video takes far longer than a request should be held open:

1. `GET /sdcpp/v1/capabilities`, before anything is sent, so that a server with no video model
   loaded is told so in plain words. A server that does not answer it is asked anyway. The portal asks for a WebM; a
   server that says it cannot make one is asked for the first format it does make, and what it makes is kept.
2. `POST /sdcpp/v1/vid_gen` with `{ prompt, model?, negative_prompt?, width?, height?, video_frames?, fps?,
   seed?, sample_params?: { sample_steps }, strength?, init_image?, end_image?, output_format: "webm" }`. A field that was not
   set is left out. `init_image` is the first frame and `end_image` the last, each as a `data:` URL;
   `end_image` is sent only when the capabilities of step 1 list it under `features_by_mode.vid_gen`,
   and a request with a last frame is refused, in words, when they do not.
3. `GET /sdcpp/v1/jobs/{id}` until the job is `completed`, `failed` or `cancelled`: every second at first,
   then every three. A few failed questions in a row do not end the wait.
4. The clip is `result.b64_json`, the whole file as base64; the frames and frame rate the server says it
   made are kept with the video. A server keeps a finished clip for ten minutes (its default), which is
   long for a portal that fetches it at once.
5. `POST /sdcpp/v1/jobs/{id}/cancel`, when the wait is stopped or runs out.

The address is the server's own, such as `http://localhost:1234`, or `http://host:port/upstream/<model>` through
llama-swap; the address of the image endpoint of the same stable-diffusion.cpp server, with its `/v1`, works too (the
`/v1` is taken off). A `/v1` endpoint of another kind of server does not work. The server must have been **started with a video model** and **built
with WebM support** if you want clips that play: an AVI or an animated WebP, which it can make too, is kept as the file it is.
Other request and answer shapes are not translated; there is no other backend yet. Not supported: control frames,
reference videos and audio, LoRA and the other fields of the native API; they are not in the form.

| | |
| --- | --- |
| Stored as | In Media's folder of the portal's data folder, `extension-data/pithagoras-media`: the files of the page's videos in `videos`, the posters in `video-posters`, the playable copies in `video-copies`, and the list in Media's own database, `media.db` (`videos`). Jobs are kept in memory. |
| API | [`/api/x/pithagoras-media/videos`](/reference/api#videos) |

## The agent

The picture tools (`generate_image`, `edit_image`, `show_image`) are described in [Opt-in features](/guide/features#image-generation).

With video generation on and an address set, a chat's agent can have two more tools. Voice mode's picture window does not
show videos: while the model has `generate_video`, the voice instructions tell it that a video is not shown in a spoken
conversation, only in the chat, and that it takes minutes, so that it makes one only when asked and says it will be in the chat.

- **`generate_video(prompt, title?, size?, seconds?, path?, lastFrame?)`** makes one video and shows it. `size`
  is `WIDTHxHEIGHT`, within the limits of the form. `seconds` is how long it should play: the portal makes
  frames of it at the frame rate set for the add-on, else the server's own, else 16. `path` is a picture
  in the chat's folder to use as the first frame, and `lastFrame` one to end on, in the same way (it goes only to a
  server that says it takes one, and the call fails with the reason where it does not; whether the clip really ends
  on it depends on the model, and the agent is told that some ignore it, so it does not report more than it asked
  for); a picture only attached to
  a message is not a file in the folder, and the agent is told to ask for it to be put there. The video is saved in a `generated-videos`
  folder inside the chat's folder, under a name the portal makes
  (`video-20261001-101500-a1b2c3.webm`), never one the agent or the endpoint chose, and never over an
  existing file; nothing is written until the endpoint has answered with a real video, so a failure leaves
  no file and no folder. It is listed in the gallery with what it was asked for. The call waits for the
  video, within the time limit, and stopping the chat stops the wait.
- **`show_video(path, title?)`** shows a WebM or an MP4 that is already in the chat's folder: a video the
  agent made some other way, or downloaded. Only the chat's folder, and only what its bytes say is a video.

Both appear in the chat as a **player** under the tool line, with the tool's call under **Details**; while
`generate_video` runs, a frame holds the place of the video (in the shape of the size asked for) and says how
long it has taken. See [Sessions](/guide/sessions#videos-the-agent-makes). Like any tool that is not a plain
read, they are refused in a conversation with a teammate unless a [tool rule](/people/rules) allows them. They sit
in Media's group in the tool lists, `pithagoras-media`, with the picture tools.
