"""What Smart Turn's reference preprocessing makes of pieces of jfk.wav, for tests/smart-turn.test.mts.

The browser works out the model's input itself (core/web/src/smart-turn.ts). This writes what the reference
implementation (pipecat-ai/smart-turn, inference.py) gives for the same audio, so the test can compare:
a sample of the features, their statistics, and the model's probability.

    pip install numpy onnxruntime transformers
    python tests/fixtures/smart-turn/reference.py path/to/smart-turn-v3.2-cpu.onnx > tests/fixtures/smart-turn/jfk.json

The model is the one core/web/scripts/copy-vad-assets.mjs puts into core/web/public/voice-assets.
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import WhisperFeatureExtractor

RATE = 16000
# Every 31st value of the [80, 800] features: each mel bin, at frames spread over the window.
STRIDE = 31
# Start and end, in seconds. Silero hears speech at 0.3-2.3 s ("And so my fellow Americans"), 3.3-3.8 s
# ("ask not"), 5.5-7.8 s ("what your country can do for you") and 8.7-10.7 s ("ask what you can do for
# your country").
CLIPS = {
    "complete": (0.0, 11.0),
    "pause after a phrase": (0.0, 3.95),
    "cut in a word": (0.0, 6.6),
    "short": (1.0, 2.5),
}


def truncate_audio_to_last_n_seconds(audio, n_seconds=8, sample_rate=RATE):
    """As audio_utils.py of pipecat-ai/smart-turn: the last 8 s, with silence in front of a shorter turn."""
    max_samples = n_seconds * sample_rate
    if len(audio) > max_samples:
        return audio[-max_samples:]
    if len(audio) < max_samples:
        return np.pad(audio, (max_samples - len(audio), 0), mode="constant", constant_values=0)
    return audio


def main(model_path):
    with wave.open(str(Path(__file__).parent.parent / "jfk.wav")) as f:
        assert f.getframerate() == RATE and f.getnchannels() == 1 and f.getsampwidth() == 2
        audio = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    session = ort.InferenceSession(model_path)
    extractor = WhisperFeatureExtractor(chunk_length=8)
    out = []
    for name, (start, end) in CLIPS.items():
        clip = audio[round(start * RATE):round(end * RATE)]
        features = extractor(
            truncate_audio_to_last_n_seconds(clip),
            sampling_rate=RATE,
            return_tensors="np",
            padding="max_length",
            max_length=8 * RATE,
            truncation=True,
            do_normalize=True,
        ).input_features.astype(np.float32)
        probability = float(session.run(None, {"input_features": features})[0][0].item())
        flat = features.reshape(-1)
        out.append({
            "name": name,
            "start": start,
            "end": end,
            "probability": round(probability, 6),
            "mean": round(float(flat.mean()), 6),
            "std": round(float(flat.std()), 6),
            "min": round(float(flat.min()), 6),
            "max": round(float(flat.max()), 6),
            "stride": STRIDE,
            "sample": [round(float(v), 5) for v in flat[::STRIDE]],
        })
    json.dump(out, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1])
