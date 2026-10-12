# Videos

**Videos** appears in the sidebar while [video generation](/guide/features#video-generation)
is switched on and has an address. It is the page for making short videos with that
endpoint **without a chat**, and for looking through every video made with it — here, and
by the agent in its chats. Nothing on it needs a model or a conversation: the page asks the
portal, the portal asks the video endpoint you set up. It is the [Images](/guide/images)
page's counterpart and works the same way wherever a video allows it.

Video generation is switched on in **Settings → Agent → Videos**, with an address. That
switch decides whether the feature exists: whether the page can make videos, and whether
the agent can have the `generate_video` and `show_video` tools at all. Whether a chat's agent
actually gets a tool is set where every tool is, in the tool lists (Settings → Agent → Tools,
a project's Tools, the tools control of a chat). The page does not depend on those lists: a
tool switched off there leaves the page as it is.

The one kind of endpoint the portal speaks to for now is a
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) server started with a
video model. How a video is asked for is a backend's business and nothing else in the portal
knows it, so another can be added later; there is none yet (see [What it takes from the
endpoint](#what-it-takes-from-the-endpoint)).

## Making a video

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

**Advanced** adds three more:

| Field | Sent as | Meaning |
| --- | --- | --- |
| **Seed** | `seed` | A whole number, 0 or more, or -1 for a random one. With several videos each takes the next seed, so that they are not the same video. A seed is not kept for the next visit. |
| **Steps** | `sample_params.sample_steps` | The sampler's steps, 1 to 100. |
| **Negative prompt** | `negative_prompt` | What the video should not show. Up to 4000 characters. |

A setting that is wrong is said when you choose **Make the video**, with the field marked and
the keyboard moved to it, and nothing is sent. A description is at most 4000 characters.

### Starting from a picture

**Start from a picture** above the settings chooses the **first frame** of the video: a
picture from the [Images](/guide/images) gallery, in a dialog of its own, or one from this
computer (it is put in the gallery, as a picture for an edit is). The description then says
what happens next. The picture is sent as `init_image`; the server brings it to the video's size
itself. **Remove** (the **×** beside it) makes the next video from the description alone again.

On the Images page, the [viewer](/guide/sessions#looking-at-a-picture) has **Make a video from
it** while video generation is on: it opens this page with that picture as the first frame.

## While a video is made

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
message names **Settings → Agent → Videos**, where the limit is raised for a slow or local model.

Videos made on this page are kept until you delete them. Where you want a ceiling, the **Disk
limit for the Videos page** in Settings is how many megabytes they may take together: at the limit
**no new video is made on the page** — the form says why — until some are deleted or the limit is
raised. Nothing is ever deleted for it. **kept from this page**, in the header, shows what they take
of the disk (and the limit, when there is one); the agent's videos are in their chats' folders and are
not counted.

## The gallery

The gallery is the main part of the page: every video of **this page**, every one the agent made
in a **chat** with `generate_video`, and every one that lies in the folders that tool writes
into, newest first, in a grid. Under each video, where it is from (the chat's title for one the
agent made, the folder for one that was found, how it was made for the others), how long it plays
and how long ago.

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
- **Filters.** *Where from*: all, made here, from chats, from folders. *How it was made*: from a
  description, from a picture, not known. They are in the address (`/videos?origin=chat&kind=animated`),
  so a link keeps them and **Back** goes through them.
- **Playing one.** A click on a tile, or `Enter` on it, opens it in the viewer: a dialog with the
  browser's own player — play and pause, the slider, the volume, full screen — which starts playing
  when it opens, steps through the gallery with the arrows on its sides (or `←` and `→` while the
  player does not have the keyboard: in the player they move through the video), and loads the next
  page when it gets near the end. `Esc`, the browser's Back button, or a click beside the video
  closes it. **Open in a new tab** and **Download** are the file itself.
- **A video that is being made** is a tile of its own, with the wait; when it is made it stays in
  the place the gallery has for it, in order of time.
- **Playback in parts.** Videos are served in the parts a player asks for (HTTP range requests), so
  a video of tens of megabytes starts at once and the slider can be moved without fetching it all.

### What the viewer adds

| Button | Does |
| --- | --- |
| **Details** | The full description, when and how it was made, the model, the size, the frames and frame rate as asked and as the server made them, the length, the seed, the steps, the negative prompt, the first frame (a small copy of the picture, while it is in the gallery), the file's name and size, and for the agent's videos the chat, with a link that opens it. For one found in a folder it says which folder, and that nothing is kept of what it was asked for. |
| **Run again** | A video made from a description is made once more, with the model, size, frames, frame rate and the other settings it was made with: one click, one more video (with a seed that is the same video again, as the server makes it). One made from a picture needs that picture to be in the gallery still, and says so when it is not. Not for one found in a folder, which has no description, and not for one the agent made from a picture of its own folder. |
| **Delete** | See below. |
| **Open in a new tab**, **Download** | The file itself. |

### Selecting several

The box in a tile's corner selects it: nothing to switch on first. Where a mouse can hover the
box shows when the tile is pointed at or has focus, and on a touch screen it is always there; once
one is ticked, all of them are. A **bar** with **n selected** appears over the gallery for as long
as something is ticked, and stays in view as you scroll, with **Select all shown**, **Download**
(each as a file of its own; the browser may ask once whether this page may download several),
**Delete** and **Clear selection** (`Esc` does the same). A click on a tile opens it and does not
change what is selected. A change of filter, or **Back** to another one, clears the selection, so
that nothing that is not on screen is deleted with what is.

### Deleting

A video is deleted with its file. For a video the page made that is the portal's own folder, and
the question can be switched off in Settings like the others that delete.

The agent's videos are files in the **folder a chat works in** (`generated-videos`), and they are
not the page's to take lightly: deleting one removes it from there for good, so the chats that work
there and their Files panel lose it. That is asked **every time, whatever Settings says**, with the
chat or the folder named, and a delete of several says how many of them are in a folder. A video that
was found in a folder is deleted the same way.

### What the gallery lists

The page lists and serves videos only from the places the portal knows: its own folder, `videos`,
under the portal's data folder, and the `generated-videos` folder of the folders the agent works in
— the home of every agent, the projects, and the folder of every chat. It never opens a path the page
names — a video is asked for by its id — and every file is opened with the checks the Files panel's
pictures have: a path inside the folder, no link followed out of it, and what its bytes say it is.
This is the [Images page's](/guide/images#what-the-gallery-lists) rule for pictures, applied to
videos, by the same code:

- The agent's videos are listed from the moment its tool saves them, with what they were asked for.
  **Videos that nobody listed are found as well:** the portal looks in `generated-videos` of every
  agent's home, of every project and of every folder a chat works in, and lists each file there whose
  first bytes say it is a **WebM** or an **MP4** (a QuickTime movie is not played by a browser, and is
  left out), of at most **100 MB**, whatever it is called. A link is never followed, a file that is no
  video is left out, and nothing else in those folders is looked at.
- A video that was found is *from the folder*: which chat made it cannot be told, and what it was
  asked for was not kept. It is one entry with a video the agent recorded, never two. It has no
  description, so a tile carries its file name instead, and there is no **Run again** for it.
- When a chat is **deleted**, its videos stay in the gallery, as videos of its folder with what they
  were asked for: the files are in a folder that is not the chat's to take away. A folder that cannot
  be reached for the moment, such as a drive that is not mounted, is not a file that is gone: its
  videos stay in the list and are shown again when it is back. A video whose file is gone is dropped
  from the list the next time it is loaded.
- **Deleting an agent** or a project with its folder takes its chats' videos with it; with **Keep its
  folder** they stay, as videos of that folder.
- The list is refreshed when you return to the tab, every half minute while it is on screen, and with
  **Refresh**; what the agent's tool saves is listed at once, while the look through the folders for
  videos nobody listed is made when the page is opened and with **Refresh**, and while the page stays
  open at most once a minute.

## What it takes from the endpoint

The same as the agent's tool, because it is the same code: the address, model, size, frames, frame
rate and key are read when a video is made; the key goes to that address and nowhere else and **never
reaches the page**; and what comes back must be a WebM or an MP4 by its first bytes and at most 100 MB,
within the time limit. See [Opt-in features](/guide/features#video-generation).

For a stable-diffusion.cpp server the portal uses its **native job API** (`/sdcpp/v1`), because a
video takes far longer than a request should be held open:

1. `GET /sdcpp/v1/capabilities`, before anything is sent, so that a server with no video model
   loaded, or one built without WebM support, is told so in plain words. A server that does not answer it
   is asked anyway.
2. `POST /sdcpp/v1/vid_gen` with `{ prompt, model?, negative_prompt?, width?, height?, video_frames?, fps?,
   seed?, sample_params?: { sample_steps }, init_image?, output_format: "webm" }`. A field that was not
   set is left out. `init_image` is the first frame as a `data:` URL.
3. `GET /sdcpp/v1/jobs/{id}` until the job is `completed`, `failed` or `cancelled`: every second at first,
   then every three. A few failed questions in a row do not end the wait.
4. The clip is `result.b64_json`, the whole file as base64; the frames and frame rate the server says it
   made are kept with the video. A server keeps a finished clip for ten minutes (its default), which is
   long for a portal that fetches it at once.
5. `POST /sdcpp/v1/jobs/{id}/cancel`, when the wait is stopped or runs out.

The address is the server's own, such as `http://localhost:1234`; the address of the image endpoint of
the same server, with its `/v1`, works too. The server must have been **started with a video model** and **built
with WebM support**: an AVI or an animated WebP, which it can make too, is not something a browser plays.
Other request and answer shapes are not translated; there is no other backend yet. Not supported: a last
frame, control frames, LoRA and the other fields of the native API; they are not in the form.

| | |
| --- | --- |
| Stored as | The files of the page's videos in `videos` under the portal's data folder, the posters in `video-posters`, and the list in the portal's own database (`videos`). Jobs are kept in memory. |
| API | [`/api/videos`](/reference/api#videos) |

## The agent

With video generation on and an address set, a chat's agent can have two tools. Voice mode's picture window does not
show videos: while the model has `generate_video`, the voice instructions tell it that a video is not shown in a spoken
conversation, only in the chat, and that it takes minutes, so that it makes one only when asked and says it will be in the chat.

- **`generate_video(prompt, title?, size?, seconds?, path?)`** makes one video and shows it. `size`
  is `WIDTHxHEIGHT`, within the limits of the form. `seconds` is how long it should play: the portal makes
  frames of it at the frame rate set for the add-on, else the server's own, else 16. `path` is a picture
  in the chat's folder to use as the first frame; a picture only attached to a message is not a file in
  the folder, and the agent is told to ask for it to be put there. The video is saved in a `generated-videos`
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
in one **Videos** group in the tool lists, apart from the **Images** group.
