# Voice servers

**Voice servers** (`extensions/voice-servers`, the package
`pithagoras-voice-servers`) lets [voice mode](/guide/voice) listen and speak
through speech servers you run yourself: a speech recognition server and a
speech synthesis server, spoken to as OpenAI's audio API is. It runs nothing of
its own and needs no Docker. For speech servers the portal builds and runs for
you, with a library of voices and clones of your own, see
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
| **Voice** | Its own choice: what an agent speaks with that has no voice of its own, or one this list no longer has. Empty, no voice is sent and the server picks. |

**Save** keeps them all. Leaving the page with changes not saved asks first.
Each address is `http:` or `https:`, with no user name, password or `#` in it;
a model is up to 100 letters, digits, `.`, `_`, `:` and `-`; at most 500 voices.

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
**Voices**, and **Voice** otherwise.

The answer has to be a WAV of **mono 24 kHz 16-bit** audio. The portal reads it
whole, checks it and plays it as one piece; anything else is refused, and voice
mode shows *Expected mono 24 kHz 16-bit audio from Voice servers*. Nothing is
resampled. A WAV says its own rate, so only WAV is asked for.

It sends no key and no `Authorization` header: the servers are expected on your
own network, as a speech server you run yourself is.

## Servers it reaches

- **whisper.cpp's server**: the speech recognition URL is its `/inference`
  (for example `http://127.0.0.1:8178/inference`), with no model.
- **audio.cpp** with Qwen3-ASR: `…/v1/audio/transcriptions` with the model
  `qwen3-asr`. Its Kokoro speaks the OpenAI request and answers 24 kHz WAV:
  `…/v1/audio/speech` with the model `kokoro`, and Kokoro's voice ids, such as
  `af_heart`, as the voices.
- **A gateway in front of them**, such as llama-swap, which starts the server for
  the `model` a request names (see
  [Behind llama-swap](/guide/voice#behind-llama-swap)).

What it does not speak: Chatterbox, which needs a recording of the voice with
every phrase, and Breeze-TTS-2, whether its own Python service or on audio.cpp,
which is spoken to in a form of its own. The voice service speaks both, with
your library of voices.

## Its routes

The page talks to its server half under `/api/x/pithagoras-voice-servers`,
behind the portal's login: see [Voice servers](/reference/api#voice-servers) in
the API reference.
