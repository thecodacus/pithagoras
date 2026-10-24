# Voice control

::: tip Give voice mode a source
Voice mode listens and speaks through an extension. **Voice**, the voice service, builds and runs speech engines in a container of its own: install it from **Settings → Extensions → Discover**, then **Install voice** on its page, **Settings → Extension settings → Voice service**, and voice mode listens and speaks through it once it is up. [The voice service](/guide/voice-service) covers GPU prerequisites, automatic Q8 setup, your voices, service controls and cleanup.

For speech servers you run yourself, install **Voice servers** instead and give it their addresses: see [Voice servers](/guide/voice-servers).
:::

With a source chosen (see [Where voice mode listens and speaks](#where-voice-mode-listens-and-speaks)),
click the **microphone icon** beside Send in any open session once, then speak
naturally. The browser uses Silero V5 to detect speech and submits your turn
after about one second of silence. The transcript becomes a normal session
message, and streaming assistant text is spoken by the source.

The microphone stays open while the session works and speaks. Start talking to
interrupt: after roughly 256 ms of detected speech, playback and queued audio
stop, the current session response is aborted, and your new turn takes over.
Short noises are filtered out. Turn detection is based on speech and silence,
not semantic prediction of sentence completion. Echo cancellation and noise
suppression are requested from the browser; headphones work best when speaker
audio is still picked up by your microphone.

VAD runs locally in your browser. Its pinned model and WebAssembly runtime are
served by Pithagoras, with no CDN dependency or extra GPU allocation.
Speech recognition receives rolling snapshots while you speak (roughly every two
seconds), and a fresh snapshot after about 200 ms of silence. The voice screen
shows the latest partial transcript. At turn end, Pithagoras reuses a result
only when it covers the last detected speech; otherwise it transcribes the final
recording. This overlaps recognition with the silence window instead of starting
all work after it. Recognition takes whole recordings, so this is speculative
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
the motion speed, reactivity and glow, eyes, a hat and a prop. While voice mode
has a source that speaks, the dialog also has the [**Voice**](/guide/agents#its-voice)
the agent speaks with. **Save avatar** stores both for that agent, and every device shows it the next time
voice mode starts. **Reset to default** puts the plain orb back in the dialog; it
only becomes the saved avatar once you press **Save avatar**. Voice mode shows
the avatar of the agent the chat is with, the first agent's for a chat in a
project.

An agent's avatar can also be one an extension offers: with such an extension
installed, the dialog has a row **Shown as** above its sections, with the orb and
each avatar the extensions offer. One chosen is set up on its extension's page in
Settings, so the orb's sections give way to a line that says so, and the preview
can show it **Thinking** as well: what voice mode shows while the agent works and
nothing is played yet. Voice mode shows the agent's orb wherever that avatar cannot
be drawn. While its extension is not installed, is switched off, could not be
loaded or no longer offers it, the dialog says it is **Not available** and keeps
the choice, so the avatar comes back when its extension does.

Browser tool calls bring the live browser into a floating window and dock the
orb, with the [Browser](/guide/browser) extension installed. Terminal calls show the agent’s actual command and streamed output on the
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

**The agent showing you a picture.** With [Media](/guide/media) installed, the
agent has a `show_image` tool: it saves a chart, a diagram or a screenshot in
the chat's folder and calls it, and a **Pictures** window opens on it, like the
browser and terminal do. A picture
any other tool [gives](/guide/extension-ui#files-a-tool-gives) is there too. Tap the
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
corner, to make it the size you want. A
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
run in progress is not interrupted. To have dictation alone, switch off **Voice
conversations** in [Voice mode's settings](#voice-mode-s-settings).

It listens the same way voice mode does, with the same in-browser speech
detection and the same source, so it works as soon as voice mode has one, also a
source that recognises speech alone. The source may send it elsewhere:
[Voice servers](/guide/voice-servers) has a dictation endpoint and model of its
own. Speech synthesis is not used and nothing is loaded onto the GPU for it.
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
What speech recognition writes for silence, such as whisper.cpp's `[BLANK_AUDIO]`,
is not typed.

Messages sent by dictation are ordinary text messages. Unlike voice-mode turns
they are not marked as audio and the agent is not asked to reply in speakable
style.

## Where voice mode listens and speaks

Voice mode has one source: an extension that recognises speech for it, speaks
its replies and names the voices it speaks with (a
[voice provider](/guide/extension-ui#voice-providers)). Two come with
Pithagoras:

| | |
| --- | --- |
| [The voice service](/guide/voice-service) (Voice) | Builds and runs speech engines in a container of its own: Breeze, Chatterbox or Kokoro to speak, Whisper or Qwen3-ASR to listen, on the GPU or the CPU. It keeps your voices, clones of a recording among them. |
| [Voice servers](/guide/voice-servers) | Speech servers you run yourself, spoken to as OpenAI's audio API is: an address to listen at, one to speak at, and the voices that server has, with voices of your own as well once custom voices are on. |

A source is chosen on its own page with **Use for voice mode**, and let go with
**Stop using**; the page says **In use for voice mode** while it is the source.
The one chosen last is the source. The voice service chooses itself once an
install or a start you began on its page is up. Voice mode is on while it has a
source: with none, the microphone buttons of voice mode and dictation are not
shown.

**Settings → Defaults → Voice mode** names the source and says how it is:
**Running**, **Recognition only** (dictation works, and replies are not spoken)
or **Not running**. **Open its page** goes to the source's page (**Open
Extensions** while its server half does not run), and **Stop using** leaves
voice mode with no source. A source removed in Settings → Extensions without its
page's own **Stop using** stays chosen until then.

Nothing else is used while the source is not running: dictation and voice mode
answer *Voice mode listens and speaks through `<name>`, which is not running:
install or start it in Settings → Extensions, or stop using it in Settings →
Defaults → Voice mode*. A source that recognises speech alone (the voice
service installed without speech synthesis, or Voice servers without a speech
synthesis address) keeps dictation working; voice mode, which speaks the
replies, is not offered then.

Every voice session holds a lease on the source: it is asked for before the
microphone begins to listen, each tab renews it every 25 seconds, and the source
is told when voice mode starts and stops being used anywhere, so that it can
load its model for the first session and let it go after the last. A source
chosen or let go while Settings is open reaches the voice controls that are open
when Settings closes.

Each agent speaks with one of the source's voices, chosen on the **Agents**
page, or with the source's own choice (see [Its voice](/guide/agents#its-voice)).

### Voice mode's settings

What does not depend on the source is at the end of **Settings → Defaults**, in
**Voice mode**. Each change is saved as it is made: a slider when you let go of
it, a text field when you leave it, and the page says **Saved**.

| | |
| --- | --- |
| **Voice conversations** | On by default: the waveform button and its shortcut start voice mode. Off, only dictation is offered, and a voice session already on ends: in this tab at once, in another when its next lease renewal is refused |
| **Voice model** | The model that answers spoken messages (see [First spoken response](#first-spoken-response)) |
| **Reply without thinking first on** | The providers whose first answer to a spoken message skips thinking |
| **Speaking instructions** | How the agent is told to talk (see [Speaking instructions](#speaking-instructions)) |
| **Speech detection** | When a turn starts and ends: the silence that ends a turn, the speech-start and speech-end thresholds, the shortest sound that counts and the audio kept from before speech. Restart voice mode to apply them. Shorter silence responds faster but can cut off pauses. **Reset speech detection** puts back the defaults. |

The first four are not shown while the source recognises speech alone, and the
three after Voice conversations are not shown while it is off. Speech detection
holds for dictation too.

## Other languages: Chatterbox and Qwen3-ASR

Breeze speaks English and Chinese. For another language the voice service builds
**Chatterbox Multilingual** for speech and **Qwen3-ASR** for recognition: pick
them under **Speech engines** on its page (see
[The voice service](/guide/voice-service#engines-devices-and-memory)).
Chatterbox speaks Arabic, Danish, Dutch, English, Finnish, French, German,
Greek, Hindi, Italian, Korean, Malay, Norwegian, Polish, Portuguese, Spanish,
Swahili, Swedish and Turkish, always in a voice cloned from a recording;
Qwen3-ASR recognises those and more. Both are MIT/Apache-2.0 licensed, unlike
Breeze's research-only weights. What Chatterbox needs, a language and a voice
with a recording, is in [Chatterbox](/guide/voice-service#chatterbox) on the
voice service's page.

A Qwen3-ASR of your own listens through [Voice servers](/guide/voice-servers)
as well, and with its [custom voices](/guide/voice-servers#custom-voices) on, a
Chatterbox or Breeze of your own speaks your voices: in audio.cpp, sent as the
voice service sends them, or as Chatterbox-TTS-Server or Breeze-TTS's own server
takes them.

## Speech servers you run

[Voice servers](/guide/voice-servers) listens and speaks at the addresses you
give it, and runs nothing itself: a speech server of your own that takes
OpenAI's audio requests, or whisper.cpp's server for recognition (see
[Servers it reaches](/guide/voice-servers#servers-it-reaches)). For speech
engines the portal builds and runs for you, with your voices, install
[the voice service](/guide/voice-service) (Voice). Do not run speech servers of
your own and the voice service on the same GPU unless it has the memory for
both: the service's page shows what each combination needs, and its installer
reads the GPU before it installs.

### Behind llama-swap

With [llama-swap](https://github.com/mostlygeek/llama-swap) as the only gateway
on the host, an [audio.cpp](https://github.com/0xShug0/audio.cpp) you run does
not need a port of its own: llama-swap starts it on the first request and routes
`/v1/audio/transcriptions` and `/v1/audio/speech` to it by the request's
`model`. One llama-swap entry serves its models, with their ids as aliases, so
the request reaches audio.cpp with `qwen3-asr` or `kokoro` unchanged:

```yaml
models:
  audio-cpp:
    cmd: |
      /path/to/audiocpp_server --config /path/to/server.json
      --host 127.0.0.1 --port ${PORT}
    # The GPU for speech, as nvidia-smi lists them; leave both lines out with one GPU.
    env: ["CUDA_DEVICE_ORDER=PCI_BUS_ID", "CUDA_VISIBLE_DEVICES=<index>"]
    aliases: [qwen3-asr, kokoro]
    ttl: 900          # stop the process after 15 quiet minutes
    unlisted: true    # not a chat model, so keep it out of /v1/models
```

`server.json` is audio.cpp's own list of models, each with the `id` a request
names, its `family`, the `path` of its GGUF file, its `task` and its `mode`.
Kokoro, which speaks the request Voice servers sends, is one entry:

```json
{
  "id": "kokoro",
  "family": "kokoro_tts",
  "path": "/models/kokoro-82m-q8_0.gguf",
  "task": "tts",
  "mode": "offline"
}
```

The audio.cpp build has to include each family: `--model-set custom --models
qwen3_asr,kokoro_tts`. Kokoro turns text into phonemes with eSpeak NG, which
audio.cpp loads from the system. The Q8 files are published in
`audio-cpp/audio.cpp-gguf` on Hugging Face, as
`Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf` and
`Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf`.

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
entry can share a set with a model only if that model leaves the memory the
speech models need (the voice service's page lists each model's); otherwise
leave it out of the sets and the gateway swaps them:

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

In [Voice servers](/guide/voice-servers), use the gateway for both addresses:
**Speech recognition URL** `http://127.0.0.1:8080/v1/audio/transcriptions` with
the model `qwen3-asr`, and **Speech synthesis URL**
`http://127.0.0.1:8080/v1/audio/speech` with the model `kokoro` and Kokoro's
voice ids, such as `af_heart`, as its voices.

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

While voice mode has a source that can speak now (not one that recognises
speech alone, and not one that is not running) and voice conversations are on,
the rule is
in the system prompt of every conversation, spoken in or not. A local model
keeps a cache of the prompt it has already read, and that cache starts at the
system prompt: with the rule there from the start, the first spoken message in a
typed conversation leaves the prompt as it was, and nothing is read again before
the first spoken reply. The rule says plainly that it describes the marker and
that a message is spoken only when its own text begins with it, so typed
messages keep normal chat formatting.

With no source, one that recognises speech alone or is not running, or voice
conversations switched off, the rule is only in a conversation that has had voice. It comes in with the first spoken message,
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

**Settings → Defaults → Voice mode → Voice model** names the model that answers
spoken messages, for when the chat is on a slow model and voice mode needs a
fast one. A spoken message that starts a run is answered by that model, and the
chat is back on its own once the run is over; the chat's model picker is not
changed, and a model you pick in the chat during the run stays. A spoken
message sent into a run that is already going is answered by the model that run
is on. **Same as the chat** (the default) uses the chat's model for everything.
In rare cases, a spoken message sent just as the run before it is winding down
(an extension is still finishing its work) may be answered by the chat's model.
This applies to chats the portal runs itself, not to the container executor.

**Settings → Defaults → Voice mode → Reply without thinking first on** names the
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
text without Markdown, the `(laugh)` / `(sigh)` cues — are a block of text that
is part of the rule above. What a tool says of itself for a spoken turn follows
that block while the chat has the tool, and is not part of the text: long
reports in a canvas while it has the canvas tools, pictures through
`show_image` while it has [Media](/guide/media)'s.
**Settings → Defaults → Voice mode → Speaking instructions** shows the text in
use and lets you change it: shorter or longer replies, another tone, no
announcing before tools. It is saved when you leave the field, and applies from
the next spoken message, also in conversations that are already open; typed messages keep the prompt they
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
  model may be the very thing that is down: the page asks the source to speak it
  as voice mode starts, in the language of the interface and with the voice of
  the agent, and keeps it until voice mode ends. If the line is missing (the
  speech model was not ready when voice mode started), the error is shown in
  writing only, and voice mode says so. A start that finds the speech model not
  ready tries three times, about a second and then three seconds apart, and the
  next start of voice mode asks again.
- **Talking during compaction.** What you say while it compacts is dropped, not
  sent: the agent cannot take it in until the compaction is over. The portal says
  "I'm still compacting our conversation. Please wait a moment; I'll let you know
  when I'm ready.", at most every eight seconds, so say it again afterwards.

All the other spoken lines are off in the [sequential baseline](/guide/voice-comparison),
and `VOICE_STATUS_SPEECH=false` on the portal turns them off everywhere. Only the
lines go: what you say during compaction is still dropped, with nothing said about
it.

## Input language and accuracy

The spoken language is the source's setting: **Input language** under
[Your voice](/guide/voice-service#your-voice) on the voice service's page, or
on the [Voice servers](/guide/voice-servers) page. Choosing your spoken language
sends an explicit language hint on every turn, avoiding automatic language
guessing on short clips. Auto-detect remains available when switching languages,
except with Chatterbox, which has no detection mode. Use a multilingual
recognition model for languages other than English; the voice service runs
multilingual Whisper `base` on the CPU by default. A larger model can improve
recognition but adds processing time, so benchmark before switching. The input
language does not translate speech or change the languages a speech engine
speaks.

## Playback and troubleshooting

Audio is not stored by the portal. The browser encodes detected speech as mono
16 kHz WAV for recognition. Spoken replies reach the browser as 24 kHz mono
PCM: a source that streams, as the voice service's Breeze does, is passed on as
it arrives, and a phrase that comes back as one WAV (Chatterbox, Kokoro, Voice
servers) is checked and sent on as PCM in one piece.

Long responses are split into chunks of at most 600 characters and
played sequentially. Fragments under 20 spoken characters are grouped with the
next phrase; a final short reply is always flushed. Complete sentences and bounded phrases are queued as the
assistant text arrives, without waiting for the full reply. The browser buffers
each spoken sentence or bounded phrase before playing it as one continuous
buffer.

This avoids interruptions within
words when speech is generated slower than playback. The full text response does
not need to finish.

Text, synthesis and playback have independent queues: the source
generates the next phrase while the current one plays, and newly arriving text
joins the synthesis queue immediately. One synthesis request runs at a time, with
at most two completed phrases waiting for playback.

Barge-in and End cancel all
three queues; Mute leaves output running.

Voice prompt submission returns at SDK
acceptance so the HTTP request does not hold playback until model completion.

Pauses can still occur when synthesis
is slower than playback. Barge-in cancels both queued audio and the request to the source.
The first sentence still needs model synthesis time before audio is available.

Code blocks are
replaced with a short spoken notice. The agent's thinking and tool output are not
read out; the portal's own [status lines](#status-lines-while-it-works) are the
only thing spoken besides the reply.

If transcription or sending fails, the error appears beside the controls; a
failed send leaves the recognized text visible for copying. The voice service's
engines make one phrase at a time, so a phrase asked for while another tab's is
being made waits for it: keep one active voice conversation per GPU service.
**Stop using** in Settings → Defaults → Voice mode hides the controls; what the
source runs is stopped on its own page.

## Development checks

```sh
npm run build
node --import tsx --test tests/voice.test.mts tests/voice-leases.test.mts tests/hands-free.test.mts tests/live-transcription.test.mts tests/speech-pipeline.test.mts tests/voice-first.test.mts extensions/voice/test/*.test.mts extensions/voice-servers/test/*.test.mts
npx playwright test
```

The tests run simulated sources and speech servers to check session validation,
the requests a source sends, WAV and PCM output and speech chunking. They do not
test model inference or microphone hardware.

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
