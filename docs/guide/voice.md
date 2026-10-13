# Voice control

::: tip Install Voice with Docker
Open **Settings → Add-ons → Voice → Install voice**.

The [Docker add-ons guide](/guide/add-ons) covers GPU prerequisites, automatic Q8 setup, service controls and cleanup.
:::

::: info Already installed?
Start with the controls below. A manual Compose setup and a native audio.cpp unit are alternative deployments; do not run them alongside the managed installer.
:::

Enable **Voice** under **Settings → Add-ons** to talk to any open session.
Click the **microphone icon** beside Send once, then speak naturally. The browser
uses Silero V5 to detect speech and submits your turn after about one second of
silence. Whisper's transcript becomes a normal session message, and streaming
assistant text is spoken with **BreezeBlue/Breeze-TTS-2**.

The microphone stays open while the session works and speaks. Start talking to
interrupt: after roughly 256 ms of detected speech, playback and queued audio
stop, the current session response is aborted, and your new turn takes over.
Short noises are filtered out. Turn detection is based on speech and silence,
not semantic prediction of sentence completion. Echo cancellation and noise
suppression are requested from the browser; headphones work best when speaker
audio is still picked up by your microphone.

VAD runs locally in your browser. Its pinned model and WebAssembly runtime are
served by Pithagoras, with no CDN dependency or extra GPU allocation.
Whisper receives rolling snapshots while you speak (roughly every two seconds),
and a fresh snapshot after about 200 ms of silence. The voice screen shows the
latest partial transcript. At turn end, Pithagoras reuses a result only when it
covers the last detected speech; otherwise it transcribes the final recording.
This overlaps recognition with the silence window instead of starting all work
after it. The current Whisper API remains clip-based, so this is speculative
transcription rather than a token-streaming ASR model. Long turns are segmented
at 60 seconds and listening resumes automatically.

Microphone access needs HTTPS or localhost. A microphone the browser refuses — blocked
for the site, none connected, in use by another program — is said in the portal's
language, with where to change it (the site settings behind the icon left of the
address), for dictation and voice mode alike. Voice mode replaces the chat and
composer with an audio-reactive orb: by default teal for your voice and violet
for spoken replies. The screen keeps only status, the controls and live words while you
speak. Quiet synthesized sound cues mark connection, submission, mute and tool
focus; they can be turned off in the voice settings. Reduced-motion
preferences disable panel transitions.

The orb is the agent's avatar, and each [agent](/guide/agents) has its own. Its
look is set on the **Agents** page: open an agent and use the palette on its
avatar, which opens a dialog with a live preview you can try in each state
(idle, listening, speaking, muted). Choose a personality (how it moves), a colour
palette and a colour for each state, the surface (glossy or plush, and a pattern),
the motion speed, reactivity and glow, eyes, a hat and a prop. With voice
installed, the dialog also has the **Voice** the agent speaks with. **Save
avatar** stores both for that agent, and every device shows it the next time
voice mode starts. **Reset to default** puts the plain orb back in the dialog; it
only becomes the saved avatar once you press **Save avatar**. Voice mode shows
the avatar of the agent the chat is with, the first agent's for a chat in a
project.

Browser tool calls bring the live browser into a floating window and dock the
orb. Terminal calls show the agent’s actual command and streamed output on the
right, moving the orb left. With both open, the browser is larger and the terminal
sits beside it; narrow screens stack them. When the agent reads or changes a file
in the chat's folder, [Files](/guide/files) opens the same way and shows it. Minimize
any panel to reclaim space without interrupting the agent. Session option dialogs remain available when an
action needs your input.

**Mute** disables microphone capture without stopping the session or spoken
replies. **Unmute** resumes hands-free listening. **End** restores the chat and
your text draft, releases the mic, and cancels pending audio/transcription.
Leaving the session also releases these resources. Ending voice does not stop
an already accepted agent task. Existing transcript history is never read aloud
on activation. Status text shows listening, speech detection, transcription,
and playback; errors remain visible in the voice screen.

## Pictures, tool cards and controls

**Giving the agent a picture.** Choose the picture button beside the microphone
(on a phone it offers the camera too), paste a picture anywhere on the voice
screen, or drop one onto it. Pictures wait at the top as thumbnails and go with
the next thing you say, so "what is wrong with this?" arrives with the picture.
Up to eight go with one message; remove one with its ×. They are kept if you
end voice mode before speaking, and are there again when you turn it back on.
The model has to take images; if it does not, the chat says so.

**The agent showing you a picture.** The agent has a `show_image` tool: it saves
a chart, a diagram or a screenshot in the chat's folder and calls it, and a
**Pictures** window opens on it, like the browser and terminal do. Tap the
picture to see it at full size, use the arrows to go back through earlier ones,
or open it in a new tab. Outside voice mode the picture appears in the chat. With
[image generation](/guide/features#image-generation) switched on, the agent also
has `generate_image`, which makes a new picture from a description and shows it
the same way, and, with image editing switched on, `edit_image`, which changes a
picture in the chat's folder into a new one; the voice instructions mention each
only while it is there. Canvases can include pictures from the folder too (see
[Canvases](/guide/canvases)). Videos have no window here: the video tools
(`generate_video` and `show_video`, with [video generation](/guide/features#video-generation) on)
make or show a video in the chat. While the agent has `generate_video` the voice instructions tell it that a video is not
shown in a spoken conversation, only in the chat, and to make one only when asked.

**Tool cards.** The cards that fly out of the orb say what the agent is doing
in words — "Editing app.ts", "Searching for “retry”", "Opening a page ·
example.com" — and stay while the call runs, counting its time. When it ends
they say what came of it: `+12 −3` lines for an edit, "8 matches", "Nothing
found", or the first line of an error. Tap a card to open what it is about: the
file in Files, the terminal, the browser, the document or the picture. The card
of a `generate_image` or `edit_image` call has the chat's picture preview in the
place of its mark, as a small tile: a frame while the picture is made (it moves
only while the [animations](/guide/interface#animations) are on), the picture
itself once it is there, and a quiet mark where none was made.

**Controls.** Beside the microphone and End:

| | |
| --- | --- |
| **Add a picture** | As above. The number on it is how many are waiting. |
| **Repeat** | Plays the last reply again from the audio already made, at the current speed, without asking the agent. Saying "say that again", "repeat that", "sag das nochmal", "wie bitte?" and the like does the same; only a sentence that is nothing but that request counts, so "say that again, but shorter" still goes to the agent. |
| **Stop** | Shown while the agent works. Stops the task without ending voice mode. |

The buttons at the bottom right open the **conversation** — a window like Files,
with what you said as it was transcribed and what came back as written, with
its markdown (lists, code, links) rendered as in the chat, each in a speech bubble — the
canvases, Files, pictures, the browser and the terminal, and the **voice
settings**:

| Setting | |
| --- | --- |
| **Speaking speed** | 1×, 1.25×, 1.5× or 1.75×. Speech is made faster in the browser without raising the voice (WSOLA time stretching), so it works with every speech runtime and a streamed reply starts as early as before. |
| **Talking while the agent works** | **Stops it** (default): speaking interrupts the task, as before. **Adds to the task**: what you say goes into the running task after its current step, and the task carries on; use Stop to stop it. |
| **Push to talk** | Only what you say while holding <kbd>Space</kbd> (outside a text field) or the microphone button is heard; on a phone, hold the microphone button or the orb itself. A tap, or a press with no speech in it, is not sent. Useful with background noise or other people talking. |
| **Sound effects** | The cues for connection, sending, mute and panels. |

Each setting is remembered in this browser.

**Profiling.** The gauge button beside the microphone opens a latency profiler for
the voice turns you take, see [Voice latency profiling](/guide/voice-profiling).

**Resizing windows.** Drag a window's left, right or bottom edge, or a bottom
corner, to make it the size you want; the canvas panel has the same grips. A
window keeps that size until the windows are arranged differently — one opens
or closes — and then the layout places them again. On a phone the windows take
the width and cannot be resized. Without a pointer, a window's bottom corner is
reached with `Tab`: the arrow keys make the window larger or smaller (`Shift`
for bigger steps), and `Home` or `Enter` give it back to the layout.

**Reloading.** A reload keeps voice mode on in that tab. Where the browser will
not play audio before the page is touched, the voice screen says "Click or
press a key to continue voice mode" and carries on after that. Ending voice
mode, or opening another chat, ends this too.

**Keyboard shortcuts.** Everything above has a key; the tooltip of each button
names it. They work while voice mode is on, except while typing in a field, and
can be changed under **Settings → Shortcuts**.

| Key | |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>V</kbd> | Start or end voice mode, from the chat too |
| <kbd>M</kbd> | Mute or unmute the microphone |
| <kbd>Space</kbd> (held) | Talk, with push-to-talk on |
| <kbd>Esc</kbd> | Stop what the agent is doing; with nothing running, end voice mode |
| <kbd>P</kbd> / <kbd>R</kbd> | Add a picture / repeat the last reply |
| <kbd>C</kbd> <kbd>D</kbd> <kbd>F</kbd> <kbd>I</kbd> <kbd>T</kbd> <kbd>B</kbd> | Conversation, canvases, files, pictures, terminal, browser |
| <kbd>O</kbd> | Voice settings |
| <kbd>.</kbd> / <kbd>,</kbd> | Speak faster / slower |
| <kbd>A</kbd> | Switch between stopping and adding to the task |
| <kbd>H</kbd> | Push-to-talk on or off |
| <kbd>Shift</kbd>+<kbd>M</kbd> | Sound effects on or off |

## Dictation

Voice mode is a conversation. When you only want to get words into the message
box, use **dictation**: the **microphone icon** left of the waveform icon. Speak,
and what you say is transcribed and typed in; the agent never speaks back and a
run in progress is not interrupted.

It listens the same way voice mode does, with the same in-browser speech
detection and the same recognition service, so it works as soon as Voice is
enabled. Speech synthesis is not used and nothing is loaded onto the GPU for it.
While you talk, a line above the box shows whether you are being heard and the
words recognised so far. Pausing for about a second ends a phrase, and the next
phrase follows it.

Choose where the words go with the switch on that line. The choice is remembered.

| | What happens |
| --- | --- |
| **Edit first** (default) | Each phrase is typed into the box **at the cursor**, spaced like a word, and the cursor moves to the end of it. Click into the text to dictate in the middle of a sentence, correct a word by keyboard, then send with Enter as usual. Dictation keeps listening after you send. |
| **Send at once** | A message is sent once you have stopped talking and it has been transcribed. If you start speaking again while a phrase is still being transcribed, the two go out together. A draft already in the box is left alone. If sending fails, the words are put back in the box rather than lost. |

Stopping dictation still delivers a sentence you were in the middle of. Starting
voice mode turns dictation off, since both use the microphone, and leaving the
session drops anything not yet transcribed instead of sending it elsewhere: a
sentence you are still saying when you open another chat is not sent to that one.
Whisper's placeholders for silence, such as `[BLANK_AUDIO]`, are not typed.

Messages sent by dictation are ordinary text messages. Unlike voice-mode turns
they are not marked as audio and the agent is not asked to reply in speakable
style.

## Alternative: manually managed Python services

::: details Show alternative deployment details
The optional Compose overlay starts Whisper.cpp and the official Breeze runtime
on the same Linux host. Install Docker Compose with GPU support and NVIDIA
Container Toolkit first. Breeze recommends at least 12 GB GPU memory for eager
inference; allow additional memory for Whisper and any session model sharing the
GPU. The overlay uses eager inference. Its default Flash Attention architecture
is `86` (consumer Ampere, such as an RTX 3060); use `FLASH_ATTN_CUDA_ARCHS=80`
for A100 or `90` for Hopper. Match the build to your GPU
and ensure the NVIDIA driver supports the upstream containers' CUDA versions.

From the Pithagoras repository on that host:

```sh
mkdir -p voice-runtime
git clone https://github.com/ggml-org/whisper.cpp voice-runtime/whisper.cpp
git clone https://github.com/breezeblue-ai/breeze-tts voice-runtime/breeze-tts
bash voice-runtime/whisper.cpp/models/download-ggml-model.sh base voice-runtime/whisper.cpp/models
uvx --from huggingface-hub hf download BreezeBlue/Breeze-TTS-2 --local-dir voice-runtime/Breeze-TTS-2
docker compose -f docker-compose.voice.yml --profile voice up -d --build whisper breeze
```

The source checkouts are retained locally, so subsequent builds use those same
revisions until you update them. Downloading models and compiling the images
can take a while. Inspect startup with:

```sh
docker compose -f docker-compose.voice.yml --profile voice logs -f whisper breeze
curl --fail http://127.0.0.1:7860/health
```

Open **Settings → Add-ons → Voice**, leave these defaults and enable voice:

| Setting | Value |
| --- | --- |
| Whisper inference URL | `http://127.0.0.1:8178/inference` |
| Breeze speech URL | `http://127.0.0.1:7860/v1/audio/speech` |

The main Compose file uses host networking, so the portal reaches both services
at these loopback addresses. The service ports are bound only to host loopback;
the web client talks through the portal's authenticated API. For another
container network, configure addresses reachable from the portal container.
The URLs must point to the full endpoints shown above. Whisper uses the
Whisper.cpp multipart API; Breeze uses its native multipart API, not an
OpenAI-compatible JSON speech endpoint.

To speak in a voice of your own, add a reference clone with **Add voice**: a
recording and the exact words spoken in it. Choose it under **Speaking voice**,
and the portal sends the recording and its transcript to Breeze. Recordings are
kept in the portal's database on the persistent data volume and are never served
as public assets. A voice that is missing produces an error rather than silently
switching voices.

Choose **Designed voice** to generate a voice without a reference.
**Describe the speaking voice** controls delivery in either mode. Breeze supports English and Chinese speech.
Model weights and self-hosted outputs have a research/non-commercial license;
see the [model card](https://huggingface.co/BreezeBlue/Breeze-TTS-2).
:::

## Other languages: Chatterbox and Qwen3-ASR

Breeze speaks English and Chinese, and the managed installer pairs it with
Whisper. For another language, run [audio.cpp](https://github.com/0xShug0/audio.cpp)
with **Chatterbox Multilingual** for speech and **Qwen3-ASR** for recognition.
One process serves both, on one GPU, so the session model can keep the other.

Chatterbox speaks Arabic, Danish, Dutch, English, Finnish, French, German, Greek,
Hindi, Italian, Korean, Malay, Norwegian, Polish, Portuguese, Spanish, Swahili,
Swedish and Turkish. Qwen3-ASR covers those and more. Both are MIT/Apache-2.0
licensed, unlike Breeze's research-only weights.

The managed **Install voice** button in Settings builds this combination for
you: pick **Chatterbox** and **Qwen3-ASR** under **Speech engines** (see
[Docker add-ons](/guide/add-ons#engines-devices-and-memory)), and the installer
downloads both models, sets up the one audio.cpp process and points the settings
at it. The rest of this section is the alternative: running audio.cpp yourself,
as a separate deployment. It does not replace Breeze or the managed installer,
and both keep working unchanged.

### Download the models

```sh
mkdir -p voice-runtime/audio-cpp
hf download audio-cpp/audio.cpp-gguf \
  Chatterbox-GGUF/chatterbox-q8_0.gguf \
  Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf \
  --local-dir voice-runtime/audio-cpp
```

About 4.5 GB. Together the two models occupy roughly 5.5 GB of GPU memory while
both are loaded.

### Start the runtime

With Compose:

```sh
docker compose -f docker-compose.voice.yml \
  --profile voice-multilingual up -d audiocpp
curl --fail http://127.0.0.1:7871/health
```

`VOICE_GPU` is the index of the GPU the service runs on, as `nvidia-smi` lists
them, and it is `0` when unset: on a host with one GPU, leave it alone. With
more than one, name the card the session model does not use, in front of the
command or in `.env`: `VOICE_GPU=<index> docker compose …`.

`server.json` binds loopback, and Compose publishes the container's port on
`127.0.0.1:7871`: the service has no authentication, so nothing should reach it
from the network. The Chatterbox entry declares `"task": "clon"`, which is
audio.cpp's own name for voice cloning — not a truncated `"clone"`.

`deploy/voice-multilingual/` also holds a systemd unit for a native audio.cpp
build. It reads the same `server.json`, so point `/models` at your GGUF
directory — a symlink is enough — or edit the two paths in that file. Build the
server where the unit's `ExecStart` expects it:

```sh
cd /opt/audio.cpp
scripts/build_linux.sh --backend cuda --target audiocpp_server
```

The unit uses GPU 0 unless `/etc/default/pithagoras-audio-cpp-multilingual`
sets another with `VOICE_GPU=<index>`, which is what a host with two GPUs does to
leave the first to the session model.

### Point the portal at it

Open **Settings → Add-ons → Voice → Advanced connection** and set:

| Setting | Value |
| --- | --- |
| Speech runtime | **Chatterbox audio.cpp · multilingual** |
| Speech recognition URL | `http://127.0.0.1:7871/v1/audio/transcriptions` |
| Speech synthesis URL | `http://127.0.0.1:7871/v1/audio/speech` |
| Speech recognition model | `qwen3-asr` |

Then choose your **Input language** — it selects the spoken language too — and a
**Speaking voice**. Chatterbox has no detection mode, so **Auto-detect** is not
offered for it and the dropdown lists only the nineteen languages above.
Chatterbox always clones a reference recording: choose or add a voice with
a recording in the language you want to hear. A designed voice is refused when
you save, not silently replaced. Use a clean 10-second reference.

**Speech delivery** replaces Breeze's Fast/Expressive choice. It sets
Chatterbox's emotion exaggeration: calm, natural, or expressive.

Numbers are written out before synthesis for languages that have a pack
(currently German and English), because Chatterbox otherwise reads digit groups
unreliably — "4070" came back from recognition as "70". The transcript keeps the
digits; only synthesis sees the words. Each pack knows how its language groups
thousands, so German "100.000" is spoken as one number rather than as a decimal.
Dates, clock times, version strings, ranges and anything with a leading zero
keep their digits: reading them as quantities would be worse than leaving them.
So do the digits of a name such as `v20.11` or `Qwen3.5`, which are not spoken
as a number of their own.
Adding a language is one entry in `server/src/voice-numbers.ts`; a language
without a pack keeps its digits, and the add-on says so under the language.

Chatterbox has no streaming mode in audio.cpp, so each phrase arrives as one
complete WAV instead of a PCM stream. Playback is unchanged, because the browser
buffers each phrase before playing it either way, but the first audio of a reply
waits for its whole first sentence. Measured on an RTX 3060 with a German
reference: a short sentence took 1.25 s, and 14 s of speech took 5.7 s
(about 0.4× real time). Qwen3-ASR transcribed 3-second German clips in about
0.3 s. These are sample measurements, not guarantees.

Recognition uses the OpenAI transcription API, which needs the model name that
`server.json` gives it. Whisper.cpp has a single model and ignores the field, so
leaving **Speech recognition model** empty keeps the existing Whisper setup
byte for byte.

Do not run this deployment and the managed service on the same GPU unless it has
the memory for both: the Settings page shows what each combination needs, and the
managed installer reads the GPU before it installs.

### Behind llama-swap

With [llama-swap](https://github.com/mostlygeek/llama-swap) as the only gateway
on the host, audio.cpp does not need a port of its own: llama-swap starts it on
the first speech request and routes `/v1/audio/speech` and
`/v1/audio/transcriptions` to it by the request's `model`. One llama-swap entry
serves both models, with the two model ids as aliases, so the request reaches
audio.cpp with `chatterbox` or `qwen3-asr` unchanged:

```yaml
models:
  audio-cpp:
    cmd: |
      /path/to/audiocpp_server --config /path/to/server.json
      --host 127.0.0.1 --port ${PORT}
    # The GPU for speech, as nvidia-smi lists them; leave both lines out with one GPU.
    env: ["CUDA_DEVICE_ORDER=PCI_BUS_ID", "CUDA_VISIBLE_DEVICES=<index>"]
    aliases: [chatterbox, qwen3-asr]
    ttl: 900          # stop the process after 15 quiet minutes
    unlisted: true    # not a chat model, so keep it out of /v1/models
```

Breeze, the English voice, is a third model in the same `server.json`, with
`breeze` added to the aliases:

```json
{
  "id": "breeze",
  "family": "breeze_tts",
  "path": "/models/Breeze-TTS-2-GGUF/breeze-tts-2-q8_0.gguf",
  "task": "tts",
  "mode": "streaming"
}
```

Choose **Breeze audio.cpp · streaming** as the speech runtime in the portal and
it sends `model: breeze`. The audio.cpp build has to include the family: a build made with
`--model-set custom --models chatterbox,qwen3_asr` cannot load it, so add
`breeze_tts` to `--models` and rebuild. With `"max_loaded_models": 2` the server
keeps Qwen3-ASR and whichever speaking voice was used last resident, and
unloads the other. The Q8 file is published as
`Breeze-TTS-2-GGUF/breeze-tts-2-q8_0.gguf` in `audio-cpp/audio.cpp-gguf`
on Hugging Face, so no local quantizing step is needed.

audio.cpp loads lazily on its own: with `"lazy_load": true` in `server.json` a
model is read on the first request that names it, and `"idle_unload_ms"` frees
it again after that long without use. llama-swap's `ttl` is the coarser layer
above, ending the whole process and its CUDA context. A cold start through the
gateway measured 6.5 s for a first spoken sentence.

The gateway runs one model at a time unless told otherwise, so without a
`routing` section every speech request would unload the language model. Put the
audio entry in a matrix set with the LLM that leaves its GPU free. In this
example speech lives on the second of two GPUs, so it goes next to a model pinned
to the first, and a model split across both stays alone. With one GPU, the audio
entry can share a set with a model only if that model leaves the roughly 5.5 GB
the two speech models need; otherwise leave it out of the sets and the gateway
swaps them:

```yaml
routing:
  router:
    use: matrix
    settings:
      matrix:
        vars: { o: chat-model, q: large-model, a: audio-cpp }
        sets:
          pinned: "o & a"
          split: "q"
```

In the portal, use the gateway for all three URLs. **Speech recognition URL**
is `http://127.0.0.1:8080/v1/audio/transcriptions` and **Speech synthesis URL**
is `http://127.0.0.1:8080/v1/audio/speech`; the model names stay `qwen3-asr` and
`chatterbox`.

The language model is a plain provider in pi's `models.json`, not the
`pi-llama-cpp` package. That package asks `/props?model=<id>` about every model,
and llama-swap answers such a request by loading the model, so registering three
models swaps through all of them.

```json
{
  "providers": {
    "llama-swap": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [{ "id": "chat-model", "reasoning": true, "contextWindow": 262144 }]
    }
  }
}
```

## First spoken response

On the host executor with a llama.cpp provider (a llama.cpp server or a
llama-swap gateway, as set on the Providers page or as its name says), each
voice prompt disables thinking for its first model call and asks for a brief spoken answer before
tools. Later calls after tools use the session’s existing thinking setting.
A conditional rule in the system prompt asks for plain, concise speech when the
latest user message begins with `[Audio mode]`. The portal adds that prefix to
microphone submissions and typed requests sent in voice mode. The rule is part
of the prompt pi builds, so it stays when tools come and go.

While voice is switched on with a speech engine (not recognition alone), the rule
is in the system prompt of every conversation, spoken in or not. A local model
keeps a cache of the prompt it has already read, and that cache starts at the
system prompt: with the rule there from the start, the first spoken message in a
typed conversation leaves the prompt as it was, and nothing is read again before
the first spoken reply. The rule says plainly that it describes the marker and
that a message is spoken only when its own text begins with it, so typed
messages keep normal chat formatting.

With voice switched off, or left with recognition alone, the rule is only in a
conversation that has had voice. It comes in with the first spoken message,
including one sent while a typed run is still going, and typing again does not
take it out. It is left out again when a spoken message never reached the
conversation (refused, or taken by an extension) and no other spoken one is
there, and when the conversation is opened with no spoken message in what the
model is given: after a restart, a compaction, or an edit that removed the
spoken messages. Coming in, it changes the system prompt once, and a local model
reads the conversation again before that first spoken reply.
The marker stays in model conversation history, while the chat UI shows the
original user text. No temporary system messages are inserted. Ordinary text
requests have no marker and use normal chat formatting, even after voice turns.
Tool calls and file contents keep their required formats. Saved thinking
preferences are unchanged. This skips initial
reasoning latency, but prompt processing and sentence synthesis still take time.
Other providers and the container executor retain their normal thinking behavior.

**Settings → Add-ons → Voice → Voice model** names the model that answers
spoken messages, for when the chat is on a slow model and voice mode needs a
fast one. A spoken message that starts a run is answered by that model, and the
chat is back on its own once the run is over; the chat's model picker is not
changed, and a model you pick in the chat during the run stays. A spoken
message sent into a run that is already going is answered by the model that run
is on. **Same as the chat** (the default) uses the chat's model for everything.
In rare cases, a spoken message sent just as the run before it is winding down
(an extension is still finishing its work) may be answered by the chat's model.
This applies to chats the portal runs itself, not to the container executor.

**Settings → Add-ons → Voice → Reply without thinking first on** names the
providers instead, as the model menu shows them, separated by commas. Switching
thinking off goes through the llama.cpp chat template, so only llama.cpp servers
and the gateways in front of them, such as llama-swap, follow it. Until a list
is saved, the portal goes by what the Providers page says each provider is, so
a llama.cpp server with any name counts; the field then shows the usual names.
A saved list counts exactly the providers it names, each as it is or as
`name=<address>`, and an empty list keeps thinking on everywhere. **Reset to
the default list** goes back to the portal's own judgement, which follows its
updates.

### Speaking instructions

The rules for how the agent talks — one short spoken sentence before a task's
tools, then now and then a short line of what it found or is trying next while
it works (not one per tool call), plain
text without Markdown, long reports in a canvas, pictures through `show_image`,
the `(laugh)` / `(sigh)` cues — are a block of text that is part of the rule
above. **Settings → Add-ons → Voice → Speaking instructions** shows the text in
use and lets you change it: shorter or longer replies, another tone, no
announcing before tools. Save, and it applies from the next spoken message,
also in conversations that are already open; typed messages keep the prompt they
had. A local model reads the conversation again once after a change, as it
does at the first spoken message.

The built-in text comes from the portal, so a portal update improves it for
everyone who has not changed it. **Reset to default** puts it back in the
field. Saving empty text, or the built-in text unchanged, stores nothing and
keeps following the portal's own. Text can be up to 8000 characters.

What the `[Audio mode]` marker means, and that a message without it is an
ordinary chat message, is said in a fixed note around your text and is not part
of what you edit.

`VOICE_RESPONSE_INSTRUCTIONS=false` on the portal switches the speaking
instructions off as a whole, whatever is saved: no `[Audio mode]` prefix is added
and the system-prompt rule is never sent, which is what the
[sequential baseline](/guide/voice-comparison) does. The page says so, and keeps
your text for when the variable is removed. Any other value leaves them on.
`VOICE_SKIP_FIRST_THINKING=false` keeps thinking on for the first call. The
remaining `VOICE_*` variables (`VOICE_PIPELINE_MODE`, `VOICE_SENTENCE_CHUNKS`,
`VOICE_TTS_PREFETCH`, `VOICE_STATUS_SPEECH`, `VOICE_COMPARISON`) are described in
the comparison guide.

## Status lines while it works

Voice mode says a few short lines of its own while the agent is busy, so a silence
is not mistaken for a hang. They come from the portal, in the language the portal
is set to (English or German, see [Settings → Language](/guide/settings#language)),
and not from the model; they are not part of the conversation and are not added to
the transcript. The same goes for the short line that stands in for a code block
when a reply is read aloud, "Code is shown in the transcript.": the code itself is
never spoken. The lines below are given in English.

- **Thinking.** When the agent has been thinking for about two seconds and has not
  started to answer, a phrase such as "Let me think about that for a moment." is
  spoken. It is chosen from a few, never the same one twice in a row, at most once
  for each thing you say and no more often than every twenty seconds. It is
  skipped once the answer has begun, and while you are talking.
- **Compaction.** When the conversation is compacted to free context, a line
  says so ("Let me do a quick context compaction so I can keep going."), and another
  when it is over ("Context compaction is done. I'm ready to continue.") or when it
  stopped before it finished.
- **Errors.** When the model fails and the portal gives up on it, a single line
  says "An error occurred." (once, however many errors came together), and the
  Conversation window opens with the error written in it. This line is spoken
  whatever the settings below say, since otherwise a failure would pass unnoticed
  with the chat put away. It is not made when the error happens, when the speech
  model may be the very thing that is down: the portal makes it as voice mode
  starts, in the language of the interface and with the voice of the agent, and keeps it
  as a file in the `voice` folder of its data directory. A new voice, speech engine
  or interface language makes a new one at the next start. If the line is missing
  (the speech model was not ready when voice mode started), the error is shown in
  writing only, and voice mode says so. A start that finds the speech model not
  ready tries three times, about a second and then three seconds apart, and writes
  one line per failed try to the portal's log. If it still fails, the next time voice
  mode starts tries again, however long that is, without waiting for an error.
- **Talking during compaction.** What you say while it compacts is dropped, not
  sent: the agent cannot take it in until the compaction is over. The portal says
  "I'm still compacting our conversation. Please wait a moment; I'll let you know
  when I'm ready.", at most every eight seconds, so say it again afterwards.

All the other spoken lines are off in the [sequential baseline](/guide/voice-comparison),
and `VOICE_STATUS_SPEECH=false` on the portal turns them off everywhere. Only the
lines go: what you say during compaction is still dropped, with nothing said about
it.

## Speech runtimes

**Settings → Add-ons → Voice → Speech runtime** selects how speech is made, and
each runtime has its own address:

| Runtime | For | Notes |
| --- | --- | --- |
| `breeze` | A Python Breeze-TTS-2 service | Designed or cloned voices |
| `audio-cpp` | Breeze on audio.cpp, streaming — what the managed container runs | Whisper on CPU |
| `chatterbox` | Speech in another language, on audio.cpp | Needs an input language (not auto-detect) and a reference clone — a voice with a recording; see above |
| `kokoro` | Kokoro 82M on audio.cpp: small, fast, eight languages | Speaks with one of its own voices, chosen in **Speaking voice**; see [Kokoro's voices](#kokoro-s-voices) |

Recognition is Whisper by default. **Speech recognition model** takes another
model id (letters, digits, `.`, `:`, `-`, `_`), such as `qwen3-asr` behind
llama-swap. **Lazy load** and the speech-detection thresholds are saved with the
rest by **Save voice settings**.

**Dictation model** and **Dictation endpoint** name the model and the address
the microphone button of the message box transcribes with, where they should
differ from voice mode's: a conversation wants the quick model, while a message
you dictate can wait for a more accurate one, perhaps on another service. Set
only the model and both use the same **Speech recognition URL**, so that service
has to serve both models (llama-swap loads the one that is asked for). Left
empty, dictation uses **Speech recognition model** and **Speech recognition
URL**, like voice mode. Installing the managed voice service over a recognition
address of your own empties both, and uninstalling it brings back what was there
before. What you set up afterwards stays, also when you press **Start voice**;
an address of the managed service itself is cleared with the uninstall.

## Speech speed

**Speech generation → Fast** uses CFG 1, avoiding the extra guidance branch.
**Expressive** uses CFG 4 for stronger voice direction. Fast can change delivery
and voice similarity, so compare using the same reference.

## Input language and accuracy

Select **Settings → Add-ons → Voice → Input language** and save. Choosing your
spoken language sends an explicit language hint to Whisper on every turn, avoiding
automatic language guessing on short clips. Auto-detect remains available when
switching languages. Use a multilingual Whisper model for languages other than
English; the managed installer runs multilingual `base` on the CPU by default. A larger model can
improve recognition but adds processing time, so benchmark before switching.
Language selection does not translate speech or change Breeze’s supported output
languages.

## Playback and troubleshooting

Audio is not stored by the portal. The browser encodes detected speech
as mono 16 kHz WAV for Whisper. Browser playback receives Breeze’s 24 kHz PCM
stream; clients that do not request PCM still receive a buffered WAV.

Long responses are split into chunks of at most 600 characters and
played sequentially. Fragments under 20 spoken characters are grouped with the
next phrase; a final short reply is always flushed. Complete sentences and bounded phrases are queued as the
assistant text arrives, without waiting for the full reply. The portal forwards
Breeze’s PCM stream. The browser buffers each spoken sentence or bounded phrase
before playing it as one continuous buffer.

This avoids interruptions within
words when Breeze generates slower than playback. The full text response does
not need to finish.

Text, synthesis and playback have independent queues: Breeze
generates the next phrase while the current one plays, and newly arriving text
joins the synthesis queue immediately. One synthesis request runs at a time, with
at most two completed phrases waiting for playback.

Barge-in and End cancel all
three queues; Mute leaves output running.

Voice prompt submission returns at SDK
acceptance so the HTTP request does not hold playback until model completion.

Pauses can still occur when synthesis
is slower than playback. Barge-in cancels both queued audio and the upstream request.
The first sentence still needs model synthesis time before audio is available.

Code blocks are
replaced with a short spoken notice. The agent's thinking and tool output are not
read out; the portal's own [status lines](#status-lines-while-it-works) are the
only thing spoken besides the reply.

If transcription or sending fails, the error appears beside the controls; a
failed send leaves the recognized text visible for copying. If Breeze reports
HTTP 409, another request owns its single-concurrency runtime. End voice in the
other tab or wait for it to finish. Keep one active voice conversation per GPU
service. Disabling the add-on hides controls; stop its containers separately:

```sh
docker compose -f docker-compose.voice.yml --profile voice stop whisper breeze
```

## Development checks

```sh
npm run build
node --import tsx --test tests/voice.test.mts tests/voice-numbers.test.mts tests/hands-free.test.mts tests/live-transcription.test.mts tests/speech-pipeline.test.mts tests/voice-first.test.mts
npx playwright test
```

The tests run local simulated services to check multipart requests, session
validation, opt-in behavior, WAV output and speech chunking. They do not test
model inference or microphone hardware.

Runtime references: [Breeze](https://github.com/breezeblue-ai/breeze-tts),
[Whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server).

## Session prefill snapshots

`LLAMA_DISK_CACHE_MODELS` names the llama.cpp models, comma-separated, whose
prompt cache is kept per session. Set it to `my-model` and that model's chats
get per-session slot snapshots.
The llama.cpp server has to run with `--parallel 1`, one slot, because a
snapshot is always of slot 0, and with a `--slot-save-path` to write the
snapshots to, such as `/path/to/session-cache/`. A server that reports more than
one slot in its `/props` is left alone: no snapshots are taken, and chats run at
the same time as they would without the variable.
The portal serializes inference and save/restore operations for that single
model slot, saves after successful responses, and restores when changing sessions.
Filenames hash the model and session ID. Cache files persist on the llama host;
missing or incompatible files fall back to normal prompt evaluation. These files
contain model state derived from conversation content and the directory is mode 700.
Disk use grows with saved sessions; removing old `.bin` snapshots only loses the
acceleration, not conversation history.

The permanent audio rule and persisted user-message markers keep the prefix
stable across voice/text switches. A newly installed rule requires one initial
prefill; subsequent turns can reuse it. No custom chat template is needed.

## Automatic setup from Settings

On a Linux NVIDIA host with Docker and NVIDIA Container Toolkit, open
**Settings → Add-ons → Voice → Install voice**. Pithagoras creates a separate
`pithagoras-voice` container and displays the setup log. Under **Speech engines**
you choose the speech synthesis engine (Breeze, Chatterbox or Kokoro) and the speech
recognition model (Whisper base or small, Qwen3-ASR 0.6B or 1.7B), or leave the
choice to the installer, which reads the GPU and its free memory and picks the
best combination that fits; [Docker add-ons](/guide/add-ons#engines-devices-and-memory)
lists what each needs and what happens when a choice does not fit. The default is
the original combination: Breeze with Whisper base.

For that default, it builds pinned audio.cpp and Whisper.cpp revisions, downloads
the full-precision Breeze-TTS-2 GGUF package, quantizes that package locally to
Q8_0, and downloads multilingual Whisper base. The GGUF source is the audio.cpp
repack of BreezeBlue/Breeze-TTS-2. No Python TTS runtime is installed. Whisper runs
on CPU; Breeze uses the GPU. Chatterbox and Qwen3-ASR are downloaded as Q8_0 GGUF
files from a pinned revision of the same repository and verified by checksum;
audio.cpp serves them from one process, with Qwen3-ASR's recognition on
`/v1/audio/transcriptions` of the same port, and no Whisper then runs.

Allow about 30 GB free disk space during setup. First installation can take several
minutes or longer depending on compilation and download speeds. Source downloads
resume, completed models and builds are reused, and the quantized model is moved
into place only after the converter inspects it successfully. The full-precision
file is then removed. Models persist in `pithagoras_voice-models`. Choosing other
engines later recreates the container and builds or downloads only what is new;
an installation made before the choice existed is the default combination, and
keeps working unchanged.

**Without a GPU** the installer puts everything on the CPU, in the small base image rather than the
CUDA one: Kokoro for speech, which takes about a quarter of a second for each second of speech on 8
threads, and Whisper, or Qwen3-ASR in a CPU-only audio.cpp build, for recognition. A host with too
little memory or too few threads for Kokoro gets recognition alone: dictation works, and the
voice-conversation control is not offered, because it speaks its replies. Breeze and Chatterbox
take several seconds of CPU time per second of speech and need a GPU. On a GPU host Kokoro and
Qwen3-ASR can be put on the CPU too, to spare the card. See
[Docker add-ons](/guide/add-ons#no-gpu).

Once the health checks of what was installed pass, Settings connects the installed services automatically.
Existing voice choices and saved voices are preserved. A reference clone
still needs a voice with a recording, as described above.

**Stop · release VRAM** stops both managed services without deleting models.
**Start voice** reuses the installed files. The managed container does not start
automatically after a host reboot; start it in Settings when needed. Setup failures
remain visible in the log and can be retried. Whisper listens on loopback port 8188
and Breeze on 7862, inside the portal's own network namespace: the voice container
joins the portal container's network (or the host's, for a native portal) and
publishes no host ports. These differ from a manually managed setup, the Compose overlay or a native unit,
which the installer does not modify. Stop such TTS services before using the managed
service to avoid loading two copies into VRAM. A managed container made by an
earlier version is migrated automatically; see
[Docker add-ons](/guide/add-ons#service-addresses-and-health-checks).

### Lazy GPU loading

**Lazy load** is on by default for the managed service. Starting the service leaves
Breeze on disk. Activating a voice session requests a model connection before the
microphone begins listening. Each tab refreshes its connection every 25 seconds;
ending the last active session unloads the model. Mute retains the connection,
since the session can still speak. Disconnected tabs expire after 75 seconds.
Load/unload requests are serialized and the native runtime waits for active
inference before unloading. A 90-second native idle timeout also releases the
model if the portal disappears.

Turn Lazy load off and save to keep Breeze warm while the portal and managed service run.
Whisper remains on CPU in either mode. The first connection in lazy mode incurs
model-loading latency; subsequent speech in the same active session reuses the
loaded model. These lifecycle controls apply to the managed container; custom
endpoints keep their own loading policy.


### Add your own voices

Open **Settings → Add-ons → Voice → Add voice**. Give the voice a name and choose
**Reference clone** or **Designed voice**. For a clone, upload a clear recording
of 1–30 seconds (up to 20 MB) and enter the exact words spoken. The browser converts
supported audio files to mono 16 kHz WAV. For a designed voice, describe the voice
instead. Each preset stores its own voice description.

Click **Save new voice**, then **Save voice settings** to activate the selected
voice. Saved voices appear in the Speaking voice dropdown. Clones include a
reference preview and transcript.

To change a saved voice's description later, select the voice, edit **Voice
description** and click **Save description**. The change is stored at once and
applies from the next phrase spoken, for a clone as well as a designed voice;
the recording and its transcript stay as they are. **Save voice settings** also
saves a description you edited and have not saved yet, and stops with an error,
without saving the other settings, if the description cannot be saved. Breeze is
the engine that reads the description. Chatterbox takes no description: it speaks
from the recording alone, so editing the description of a voice used with
Chatterbox changes nothing you can hear.

### Kokoro's voices

Kokoro cannot clone a recording or follow a description: it speaks with one of
the voices that come with it. With **Kokoro audio.cpp** as the speech runtime,
**Speaking voice** lists those voices instead of your library, each with its
language: American and British English, Spanish, French, Hindi, Italian,
Brazilian Portuguese and Mandarin Chinese. Kokoro reads the text in the language
of the voice, whatever the input language is set to. Its Japanese voices are
not offered: they need a dictionary the packaged model does not carry.
**Speaking speed** (slower, normal, faster) takes the place of **Speech
generation**.

Your library voice stays selected for the other engines, so switching the
runtime back brings it back. An agent can have a Kokoro voice of its own, from
the voice menu under its avatar; with another engine it speaks as in the voice
settings, and a library voice given to an agent is not used while Kokoro speaks.

Kokoro has no streaming mode in audio.cpp: each phrase comes back as one WAV, as
with Chatterbox, which Kokoro's size makes quick.

Delete voice removes the preset and falls back
to the default designed voice if it was active; an [agent](/guide/agents#its-voice) that had it speaks as the voice settings say again. Presets and recordings persist in
the portal's SQLite database; they are shared across sessions and require portal
authentication to access. Adding a voice does not retrain or download another model.
