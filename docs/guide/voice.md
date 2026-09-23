# Voice control

::: tip Install Voice with Docker
Open **Settings → Add-ons → Voice → Install voice**.

The [Docker add-ons guide](/guide/add-ons) covers GPU prerequisites, automatic Q8 setup, service controls and cleanup.
:::

::: info Already installed?
Start with the controls below. Manual Compose and historical Cortex services are alternative deployments; do not run them alongside the managed installer.
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
served by Pithagoras, with no CDN dependency or extra Cortex GPU allocation.
Whisper receives rolling snapshots while you speak (roughly every two seconds),
and a fresh snapshot after about 200 ms of silence. The voice screen shows the
latest partial transcript. At turn end, Pithagoras reuses a result only when it
covers the last detected speech; otherwise it transcribes the final recording.
This overlaps recognition with the silence window instead of starting all work
after it. The current Whisper API remains clip-based, so this is speculative
transcription rather than a token-streaming ASR model. Long turns are segmented
at 60 seconds and listening resumes automatically.

Microphone access needs HTTPS or localhost. Voice mode replaces the chat and
composer with an audio-reactive orb: teal for your voice and violet for spoken
replies. The screen keeps only status, microphone/end controls and live words
while you speak. Quiet synthesized sound cues mark connection, submission, mute
and tool focus; the sound toggle remembers your preference. Reduced-motion
preferences disable panel transitions.

Browser tool calls bring the live browser into a floating window and dock the
orb. Terminal calls show the agent’s actual command and streamed output on the
right, moving the orb left. With both open, the browser is larger and the terminal
sits beside it; narrow screens stack them. Minimize either panel to reclaim space
without interrupting the agent. Session option dialogs remain available when an
action needs your input.

**Mute** disables microphone capture without stopping the session or spoken
replies. **Unmute** resumes hands-free listening. **End** restores the chat and
your text draft, releases the mic, and cancels pending audio/transcription.
Leaving the session also releases these resources. Ending voice does not stop
an already accepted agent task. Existing transcript history is never read aloud
on activation. Status text shows listening, speech detection, transcription,
and playback; errors remain visible in the voice screen.

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
session drops anything not yet transcribed instead of sending it elsewhere.
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
is RTX 3060/Ampere (`86`), matching Cortex; use `FLASH_ATTN_CUDA_ARCHS=80`
for A100 or `90` for Hopper. Match the build to your GPU
and ensure the NVIDIA driver supports the upstream containers' CUDA versions.

From the Pithagoras repository on that host:

```sh
mkdir -p voice-runtime
git clone https://github.com/ggml-org/whisper.cpp voice-runtime/whisper.cpp
git clone https://github.com/breezeblue-ai/breeze-tts voice-runtime/breeze-tts
bash voice-runtime/whisper.cpp/models/download-ggml-model.sh base voice-runtime/whisper.cpp/models
uvx --from huggingface-hub hf download BreezeBlue/Breeze-TTS-2 --local-dir voice-runtime/Breeze-TTS-2
docker compose -f docker-compose.yml -f docker-compose.voice.yml --profile voice up -d --build whisper breeze
```

The source checkouts are retained locally, so subsequent builds use those same
revisions until you update them. Downloading models and compiling the images
can take a while. Inspect startup with:

```sh
docker compose -f docker-compose.yml -f docker-compose.voice.yml --profile voice logs -f whisper breeze
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

Choose **Speaking voice → Aria · reference clone** to use Aria’s installed
reference. The portal sends `DATA_DIR/voices/aria.wav` and its exact transcript
from `DATA_DIR/voices/aria.txt` to Breeze. These files live on the persistent data
volume and are never served as public assets. A missing reference produces an
error rather than silently switching voices. Cortex has this reference installed.

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

This is a separate deployment; it does not replace Breeze or the managed
installer, and both keep working unchanged.

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

With Compose, on the GPU of your choice:

```sh
VOICE_GPU=1 docker compose -f docker-compose.yml -f docker-compose.voice.yml \
  --profile voice-multilingual up -d audiocpp
curl --fail http://127.0.0.1:7871/health
```

`server.json` binds loopback, and Compose publishes the container's port on
`127.0.0.1:7871`: the service has no authentication, so nothing should reach it
from the network. The Chatterbox entry declares `"task": "clon"`, which is
audio.cpp's own name for voice cloning — not a truncated `"clone"`.

`deploy/voice-multilingual/` also holds a systemd unit for a native audio.cpp
build. It reads the same `server.json`, so point `/models` at your GGUF
directory — a symlink is enough — or edit the two paths in that file. Build the
server where the unit expects it, next to the existing Breeze unit's binary:

```sh
cd /opt/audio.cpp
scripts/build_linux.sh --backend cuda --target audiocpp_server
```

The unit uses GPU 0 unless `/etc/default/pithagoras-audio-cpp-multilingual`
sets another, for example `VOICE_GPU=1`.

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
Chatterbox always clones a reference recording: choose Aria or add a voice with
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

The managed **Install voice** button still installs Breeze and Whisper; it does
not know about this runtime. Do not run both on the same GPU unless it has the
memory for both.

## First spoken response

On the host executor with a llama.cpp provider, each voice prompt disables
thinking for its first model call and asks for a brief spoken answer before
tools. Later calls after tools use the session’s existing thinking setting.
A permanent conditional rule in the base system prompt asks for plain, concise
speech when the latest user message begins with `[Audio mode]`. The portal adds
that prefix to microphone submissions and typed requests sent in voice mode.
The marker stays in model conversation history, while the chat UI shows the
original user text. No temporary system messages are inserted. Ordinary text
requests have no marker and use normal chat formatting, even after voice turns.
Tool calls and file contents keep their required formats. Saved thinking
preferences are unchanged. This skips initial
reasoning latency, but prompt processing and sentence synthesis still take time.
Other providers and the container executor retain their normal thinking behavior.

## Speech speed

**Speech generation → Fast** uses CFG 1, avoiding the extra guidance branch.
**Expressive** uses CFG 4 for stronger voice direction. Fast can change delivery
and voice similarity, so compare using the same reference. The Cortex runtime
also caches up to eight encoded reference clips in CPU memory, keyed by audio
content rather than temporary upload filename.

## Input language and accuracy

Select **Settings → Add-ons → Voice → Input language** and save. Choosing your
spoken language sends an explicit language hint to Whisper on every turn, avoiding
automatic language guessing on short clips. Auto-detect remains available when
switching languages. Use a multilingual Whisper model for languages other than
English; Cortex currently runs multilingual `base` on CPU. A larger model can
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
replaced with a short spoken notice. Thinking and tool output are not spoken.

If transcription or sending fails, the error appears beside the controls; a
failed send leaves the recognized text visible for copying. If Breeze reports
HTTP 409, another request owns its single-concurrency runtime. End voice in the
other tab or wait for it to finish. Keep one active voice conversation per GPU
service. Disabling the add-on hides controls; stop its containers separately:

```sh
docker compose -f docker-compose.yml -f docker-compose.voice.yml --profile voice stop whisper breeze
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

## Historical Cortex native services

::: details Show alternative deployment details
Cortex already has Breeze's source, Python environment and weights under
`/root/breeze`. The units in `deploy/cortex-voice` reuse that installation.
Whisper is built without CUDA under `/opt/pithagoras/voice-runtime/whisper.cpp`
and uses the CPU, leaving the RTX 3060 available for Breeze. Both endpoints bind
to loopback and use the same default URLs as the add-on.

Install the unit files into `/etc/systemd/system`, reload systemd, and start
`pithagoras-whisper`. Start `pithagoras-breeze` when sufficient GPU memory is
available. On Cortex, the experimental `emotion-console` container is stopped
and both voice units are enabled at boot. Breeze reserves roughly 8 GB of the
GPU; use `systemctl stop pithagoras-breeze` to release its memory, or
`systemctl disable --now pithagoras-breeze` before returning the GPU to another
service permanently. Do not run these units alongside the Compose voice services;
they use the same ports.

Browser tests use the public JFK speech sample bundled with Whisper.cpp as a
synthetic microphone stream; they do not record from your physical microphone.
:::

## Historical Cortex accelerated streaming runtime

::: details Show alternative deployment details
Cortex uses audio.cpp at commit `efb04233dab73aeee4b2912042a90e7b36329061`,
built for CUDA architecture 86 with the `breeze_tts` model. The Q8 package is
`breeze_tts_2_q8_0`, installed under `/root/breeze/audio-cpp-models`.
`pithagoras-audio-cpp.service` serves loopback port 7861; the Voice add-on uses
runtime `audio-cpp` and URL `http://127.0.0.1:7861/v1/audio/speech`.
The Aria reference and transcript are sent inline and cached by the runtime.

The player begins with 650 ms of PCM buffered, then schedules arriving audio
chunks contiguously. Synthesis stays single-file while playback runs independently.
Barge-in cancels the HTTP stream and scheduled audio. The Python runtime retains
whole-phrase buffering because its measured synthesis is slower than playback.

On the RTX 3060 with Qwen resident, a warmed Aria sample generated 4.88 seconds
of audio in 3.05 seconds, with first audio at 0.94 seconds. The prior Python
runtime took 8.40 seconds for the same text (its output duration was 4.32 seconds).
The audio.cpp process used 4414 MiB VRAM. These are sample measurements, not
latency guarantees for every input. A separate portal request produced 8 seconds
of audio in 4.94 seconds, with first bytes at 0.99 seconds.

Rollback: stop `pithagoras-audio-cpp`, start `pithagoras-breeze`, select runtime
`breeze`, and restore the speech URL to port 7860. Only one TTS unit should be
enabled at boot. Qwen and Whisper do not need to restart.
:::

## Session prefill snapshots on Cortex

`LLAMA_DISK_CACHE_MODELS=qwen36-35b-a3b-mtp` enables per-session slot snapshots.
The matching llama preset has `slot-save-path = /root/models/session-cache/`.
The portal serializes inference and save/restore operations for its single model
slot, saves after successful responses, and restores when changing sessions.
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
`pithagoras-voice` container and displays the setup log. It builds pinned audio.cpp
and Whisper.cpp revisions, downloads the full-precision Breeze-TTS-2 GGUF package,
quantizes that package locally to Q8_0, and downloads multilingual Whisper base.
The GGUF source is the audio.cpp repack of BreezeBlue/Breeze-TTS-2. No Python TTS
runtime is installed. Whisper runs on CPU; Breeze uses the GPU.

Allow about 30 GB free disk space during setup. First installation can take several
minutes or longer depending on compilation and download speeds. Source downloads
resume, completed models and builds are reused, and the quantized model is moved
into place only after the converter inspects it successfully. The full-precision
file is then removed. Models persist in `pithagoras_voice-models`.

Once both health checks pass, Settings connects the installed services automatically.
Existing voice choices and Aria reference files are preserved. A reference clone
still needs the private reference WAV and transcript described above.

**Stop · release VRAM** stops both managed services without deleting models.
**Start voice** reuses the installed files. The managed container does not start
automatically after a host reboot; start it in Settings when needed. Setup failures
remain visible in the log and can be retried. Port 8188 serves Whisper and port
7862 serves Breeze, both bound to host loopback. These differ from the older manual
systemd setup, which the installer does not modify. Stop older TTS services before
using the managed service to avoid loading two copies into VRAM. The portal must
be able to reach host loopback, as in the standard host-network Compose setup.

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
reference preview and transcript. Delete voice removes the preset and falls back
to the default designed voice if it was active. Presets and recordings persist in
the portal's SQLite database; they are shared across sessions and require portal
authentication to access. Adding a voice does not retrain or download another model.
