# Voice servers

**Voice servers** (`extensions/voice-servers`, the package
`pithagoras-voice-servers`) lets [voice mode](/guide/voice) listen and speak
through speech servers you run yourself: a speech recognition server and a
speech synthesis server, spoken to as OpenAI's audio API is. It runs nothing of
its own and needs no Docker. With [custom voices](#custom-voices) switched on,
it keeps voices of your own as well, cloned from a recording or designed from a
description, for a speech server that runs Breeze-TTS-2 or Chatterbox. For speech
servers the portal builds and runs for you, see
[The voice service](/guide/voice-service).

Optional. It is not installed by default: install it from **Settings →
Extensions → Discover → Comes with Pithagoras → Voice servers**. Its page is
**Settings → Extension settings → Voice servers**
(`/settings/x/pithagoras-voice-servers`). A portal that listened and spoke at
addresses of its own before voice mode's sources were extensions left them for
it: see [Upgrading](/guide/upgrading#voice-s-service-is-an-extension).

## Its page

| Field | What it is |
| --- | --- |
| **Speech recognition URL** | Where a recording is sent to be written down: an OpenAI-style `…/v1/audio/transcriptions`, or whisper.cpp's `…/inference`. Voice mode needs it. |
| **Speech recognition model** | Sent as `model` where it is set. whisper.cpp has one model and ignores it; audio.cpp's Qwen3-ASR is `qwen3-asr`. |
| **Input language** | The spoken language, as a two- or three-letter code such as `de`, sent as `language`. Empty: the server detects it. |
| **Dictation endpoint** and **Dictation model** | Where the message box's microphone sends its recordings, and with which model, where they should differ from voice mode's: a conversation wants the quick model, while a message you dictate can wait for a more accurate one. Empty, dictation uses the speech recognition URL and model above; a model alone goes to the speech recognition URL, so that server has to serve both. |
| **Speech synthesis URL** | Where a reply is sent to be spoken: an OpenAI-style `…/v1/audio/speech`. Empty: recognition alone, so dictation works and replies are not spoken. |
| **Speech synthesis model** | Sent as `model` where it is set, such as `kokoro`. |
| **Voices** | The voices the speech server has, one per line: its id, or `id = Name`. These are what an agent's voice is chosen from on the Agents page. |
| **Read voices from the server** | Fills **Voices** from the list the speech server gives at `…/audio/voices`, beside a speech synthesis URL that ends in `/audio/speech` (the shape Kokoro-FastAPI answers, `{ voices: [...] }`). The list is shown, not saved, until you save. A server that has not answered within 10 seconds is said to have failed. |
| **Voice** | Its own choice: what an agent speaks with that has no voice of its own, or one this list no longer has. **The server's own** sends no voice, and the server picks. |

**Save** keeps them all. Leaving the page with changes not saved asks first.
Each address is `http:` or `https:`, with no user name, password or `#` in it;
a model is up to 100 letters, digits, `.`, `_`, `:` and `-`; at most 500 voices.

**Custom voices**, under **Save**, is off: see [Custom voices](#custom-voices).

**Use for voice mode** makes it voice mode's source, once a speech recognition
URL is saved, and **Stop using** stops that; the page says **In use for voice
mode** while it is. Voice mode has one source, the one chosen last, and the
person can stop using it in **Settings → Defaults → Voice mode** as well (see
[Where voice mode listens and speaks](/guide/voice#where-voice-mode-listens-and-speaks)).

## What it sends

**Recognition.** Each recording, a WAV of 16 kHz mono 16-bit audio, goes to the
speech recognition URL (or the dictation endpoint, for dictation) as
`multipart/form-data`:

| Field | Value |
| --- | --- |
| `file` | The recording, as `recording.wav`, `audio/wav` |
| `response_format` | `json` |
| `model` | Only where a model is set |
| `language` | Only where an input language is set |

This is the form whisper.cpp's `/inference` and OpenAI's
`/v1/audio/transcriptions` both take. The answer's `text` is the transcript.

**Speech.** Each phrase goes to the speech synthesis URL as JSON,
`{ model, input, voice, response_format: "wav" }`, with `model` and `voice` left
out where they are empty. The voice is the agent's own where it is one of
**Voices**, and **Voice** otherwise. This is OpenAI's request, the one sent
while custom voices are off and for a server with fixed voices; for Breeze and
Chatterbox see [Custom voices](#custom-voices).

The answer has to be a WAV of **mono 24 kHz 16-bit** audio. The portal reads it
whole, checks it and plays it as one piece; anything else is refused, and voice
mode shows *Expected mono 24 kHz 16-bit audio from Voice servers*. Nothing is
resampled. A WAV says its own rate, so only WAV is asked for.

It sends no key and no `Authorization` header: the servers are expected on your
own network, as a speech server you run yourself is.

## Custom voices

**Custom voices** is a switch under the page's fields, off for every
installation until you switch it on. While it is off, the page, the requests
and the voice lists are as described above: OpenAI's request, the ids in
**Voices**, and nothing else.

Switching it on asks what the speech server is, under **Speech engine**:

| Speech engine | What the page shows | Voices offered |
| --- | --- | --- |
| **Fixed voices, such as Kokoro** (the first) | **Voices** and **Read voices from the server**, as with the switch off, and a line that says custom voices are not offered for such a server | The ids in **Voices** |
| **Breeze-TTS-2** | **Reached through** and [your voices](#your-voices): designed voices and clones | Your voices |
| **Chatterbox** | **Reached through** and your voices: clones only, with no description, since Chatterbox speaks from the recording alone | Your clones |

With Breeze or Chatterbox, **Voices** and **Read voices from the server** are
hidden, and the ids in them are kept for a server with fixed voices. The switch,
**Speech engine** and **Reached through** are stored as soon as you change
them, not with **Save**.

The voices offered are those in the **Voice** menu on the page and in each
agent's voice menu ([Its voice](/guide/agents#its-voice)). Switching custom
voices off hides your voices again and stops offering them. They stay on disk,
so switching it back on brings them back. An agent that has one of them keeps
it as its voice and, while it is not offered, speaks with **Voice**, as with any
voice the list no longer has. Where **Voice** was a voice the change no longer
offers (one of your voices when the switch goes off, a designed voice when you
choose Chatterbox, an id from **Voices** when you choose Breeze or Chatterbox),
it goes back to **The server's own**.

### Your voices

**Add voice** adds one. Give it a name; for Breeze, choose **Clone from a
recording** or **Design from a description**, and for Chatterbox it is a clone.
For a clone, choose a clear recording of 1–30 seconds (up to 20 MB) and type the
exact words spoken in it. The browser converts any audio file it can play to
mono 16 kHz WAV, and only that WAV leaves the page. For Breeze, every voice has
a description (1–1000 characters), which starts as
`Speak clearly and naturally.` in the form; a clone added for Chatterbox keeps
that one, for Breeze. These are the voice service's limits and its conversion
([Add your own voices](/guide/voice-service#add-your-own-voices)).

Click a voice in the list to open it: change its **Voice name** (and for Breeze
its **Voice description**) and click **Save voice**, play a clone's recording,
read its words, or **Delete voice**, which asks first. Each change is stored at
once and applies from the next phrase spoken; a clone's recording and its words
stay as they are. With Chatterbox, designed voices are not listed, and the page
says they are kept for Breeze.

Your voices are kept in Voice servers' folder in the data folder
(`extension-data/pithagoras-voice-servers`: `voices.json`, and a WAV in
`voices/` for each recording), which only the portal can read, and are read on
the page only behind the portal's login. A recording leaves the portal only for
the server at the speech synthesis URL: with each phrase spoken in it, or to be
stored there (Chatterbox-TTS-Server), and never after a redirect (one is
refused).

### Reached through

How Breeze or Chatterbox is reached, and so what each phrase is sent:

| Speech engine | Reached through | What it is |
| --- | --- | --- |
| Breeze-TTS-2 | **audio.cpp** (the first) | An [audio.cpp](https://github.com/0xShug0/audio.cpp) of your own with Breeze-TTS-2 loaded with `"mode": "streaming"`, as the voice service loads it. Each phrase is sent what the voice service sends it. |
| Breeze-TTS-2 | **Breeze-TTS's own server** | Breeze-TTS's own service, `python -m breeze_infer.api` from [breeze-tts](https://github.com/breezeblue-ai/breeze-tts), which takes a form with each phrase. |
| Chatterbox | **audio.cpp: the recording with each phrase** (the first) | An audio.cpp of your own with Chatterbox. The clone's recording goes with each phrase, as the voice service sends it, in the **Input language**, which has to be set: Chatterbox has no detection, so it is refused without one. |
| Chatterbox | **Chatterbox-TTS-Server: voices stored on it** | [Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server), which keeps reference recordings of its own. Each clone is stored there once, and each phrase names it. It needs a **Speech synthesis model** in each request, any name such as `chatterbox`, so it is refused without one. |

The audio.cpp forms are what the voice service sends its own audio.cpp
(`extensions/voice/src/server/speech.ts`), as of audio.cpp v0.9.0 (commit
`795c45fb`), the release the voice service builds; the Breeze form was checked
against that build. With Breeze and Chatterbox go the voice service's settings
as they start: guidance 4 (**Expressive**) and exaggeration 0.5 (**Natural**),
and a fixed seed, which keeps a voice made of a description the same from
phrase to phrase. Unlike the voice service, Voice servers sends numbers to
Chatterbox as digits, without writing them out.

#### Voices stored on Chatterbox-TTS-Server

A clone is stored on Chatterbox-TTS-Server as a reference file named after it,
`<id>.wav` (the id is the voice's in `voices.json`), posted as a form with the
WAV as `files` to `/upload_reference`, the server's own route beside the speech
synthesis URL, which has to end in `/v1/audio/speech`. That happens when you add
the clone, when you click **Store on the speech server** (or **Store again**, after
the server was installed anew, say), and before a phrase in a clone that is not
stored at the speech synthesis URL in use yet. A phrase the server answers with
404, its answer for a voice it does not have, stores the clone again and is asked
once more. A clone it would not store is still added, and the page says why.
Each clone says whether it is stored on this speech server, and since when.

The server has no way to delete a voice: deleting one here asks, and says that
the server keeps its copy, which you remove from its reference audio folder
yourself.

### What each form sends

**The server's own** sends no voice in any form, and the parts for a voice of
yours are left out.

**Breeze-TTS-2 through audio.cpp**, JSON:

```json
{
  "model": "breeze",
  "input": "…",
  "stream": true,
  "stream_format": "audio",
  "response_format": "pcm",
  "options": {
    "instruction": "<your voice's description>",
    "guidance_scale": "4",
    "seed": "42",
    "stream_frames_per_event": "8",
    "stream_lookahead_margin": "4"
  },
  "voice_ref": { "type": "base64", "data": "<the clone's recording, base64 of its WAV>" },
  "reference_text": "<the words said in it>"
}
```

`voice_ref` and `reference_text` only for a clone.

**Breeze-TTS-2 through Breeze-TTS's own server**, `multipart/form-data`:

| Field | Value |
| --- | --- |
| `text` | The phrase |
| `instruction` | Your voice's description |
| `cfg_scale` | `4` |
| `seed` | `42` |
| `ref_audio` | A clone's recording, as `reference.wav`, `audio/wav` |
| `ref_text` | The words said in it |

Both Breeze forms are answered with raw PCM (mono, 24 kHz, signed 16-bit
little-endian; audio.cpp labels it `application/octet-stream`, Breeze-TTS
`audio/pcm`), passed on to voice mode as it streams; an answer of another type,
or with an `x-sample-rate` other than 24000, is refused. A Breeze that audio.cpp
loads offline refuses the streamed request.

**Chatterbox through audio.cpp**, JSON:

```json
{
  "model": "chatterbox",
  "input": "…",
  "language": "de",
  "response_format": "wav",
  "options": { "exaggeration": "0.5", "seed": "42" },
  "voice_ref": { "type": "base64", "data": "<the clone's recording, base64 of its WAV>" }
}
```

**Chatterbox-TTS-Server**, JSON, after the clone is stored there:

```json
{ "model": "chatterbox", "input": "…", "voice": "<id>.wav", "language": "de", "response_format": "wav" }
```

`language` where an input language is set; the server uses its own otherwise.

Both Chatterbox forms ask for a WAV, which has to be mono 24 kHz 16-bit, as
above. The two audio.cpp forms and Breeze-TTS's ask again every 0.75 seconds
while the server answers 409, busy with a phrase before, until it answers
otherwise or voice mode gives up on the phrase; the others ask once.

## Servers it reaches

- **whisper.cpp's server**: the speech recognition URL is its `/inference`
  (for example `http://127.0.0.1:8178/inference`), with no model.
- **audio.cpp** with Qwen3-ASR: `…/v1/audio/transcriptions` with the model
  `qwen3-asr`. Its Kokoro speaks the OpenAI request and answers 24 kHz WAV:
  `…/v1/audio/speech` with the model `kokoro`, and Kokoro's voice ids, such as
  `af_heart`, as the voices.
- **audio.cpp with Breeze-TTS-2 or Chatterbox**, with
  [custom voices](#custom-voices) on: `…/v1/audio/speech`, with the model named
  as audio.cpp's config names it, and your voices sent as the voice service
  sends them.
- **Breeze-TTS's own server** and **Chatterbox-TTS-Server**, with custom voices
  on: their `…/v1/audio/speech` (see [Reached through](#reached-through)).
- **A gateway in front of them**, such as llama-swap, which starts the server for
  the `model` a request names (see
  [Behind llama-swap](/guide/voice#behind-llama-swap)).

What it does not speak: a server that takes a voice of your own in another form
than these. The voice service runs Breeze, Chatterbox and Kokoro for you.

## Its routes

The page talks to its server half under `/api/x/pithagoras-voice-servers`,
behind the portal's login: see [Voice servers](/reference/api#voice-servers) in
the API reference.
