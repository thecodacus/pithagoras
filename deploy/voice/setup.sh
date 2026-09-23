#!/usr/bin/env bash
set -euo pipefail
trap 'echo "VOICE_SETUP_ERROR: setup or service failed (line $LINENO)" >&2' ERR
export DEBIAN_FRONTEND=noninteractive
cd /voice
if [ ! -f /usr/local/share/pithagoras-voice-deps ]; then
  echo 'VOICE_STAGE: Installing build tools'
  dpkg --configure -a
  apt-get update
  apt-get install -y --no-install-recommends git cmake ninja-build build-essential curl ca-certificates python3 libssl-dev aria2
  touch /usr/local/share/pithagoras-voice-deps
fi
checkout() {
  local directory="$1" repository="$2" revision="$3"
  if [ ! -d "$directory/.git" ]; then git clone "$repository" "$directory"; fi
  git -C "$directory" checkout "$revision"
  git -C "$directory" submodule update --init --recursive
}
echo 'VOICE_STAGE: Preparing pinned audio runtime'
checkout audio https://github.com/0xShug0/audio.cpp.git efb04233dab73aeee4b2912042a90e7b36329061
if [ ! -x audio/build/portal/bin/audiocpp_gguf ] || [ ! -x audio/build/portal/bin/audiocpp_server ] || ! grep -q 'AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER:BOOL=ON' audio/build/portal/CMakeCache.txt; then
  echo 'VOICE_STAGE: Building CUDA speech runtime and quantizer'
  architecture=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '. ')
  (cd audio && bash scripts/build_linux.sh --native-model-manager --system-openssl --cuda on --cuda-arch "$architecture" --build-dir /voice/audio/build/portal --build-type Release --model-set custom --models breeze_tts --target audiocpp_server --target audiocpp_gguf --jobs 4) 2>&1 | tr '\r' '\n'
fi
echo 'VOICE_STAGE: Preparing CPU speech recognition'
checkout whisper https://github.com/ggml-org/whisper.cpp.git a2b36eb677918d4f9ab1db7b8a7ff968563ed163
if [ ! -x whisper/build/bin/whisper-server ]; then
  cmake -S whisper -B whisper/build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DWHISPER_BUILD_SERVER=ON
  cmake --build whisper/build --target whisper-server -j 4
fi
mkdir -p models
download() {
  local url="$1" destination="$2"
  if [ ! -s "$destination" ]; then
    aria2c --continue=true --max-connection-per-server=4 --split=4 --min-split-size=16M --file-allocation=none --auto-file-renaming=false --max-tries=5 --retry-wait=5 --summary-interval=10 --console-log-level=warn --checksum=sha-256=a00c9f678b4c5ae03d1dcd228f636b329352cda200823faef4e01d3bd97c0a89 --dir="$(dirname "$destination")" --out="$(basename "$destination").part" "$url" 2>&1 | tr '\r' '\n'
    mv "$destination.part" "$destination"
  fi
}
echo 'VOICE_STAGE: Downloading multilingual Whisper base'
bash whisper/models/download-ggml-model.sh base /voice/models 2>&1 | tr '\r' '\n'
if [ ! -s models/breeze-q8_0.gguf ]; then
  echo 'VOICE_STAGE: Downloading full-precision Breeze-TTS-2'
  download "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/056144d2744697c9439bd32647279674dba0c964/Breeze-TTS-2-GGUF/breeze-tts-2-bf16.gguf" models/breeze-bf16.gguf
  echo 'VOICE_STAGE: Quantizing Breeze to Q8_0 on CPU'
  audio/build/portal/bin/audiocpp_gguf --input models/breeze-bf16.gguf --output models/breeze-q8_0.partial.gguf --type q8_0 --overwrite
  audio/build/portal/bin/audiocpp_gguf --inspect models/breeze-q8_0.partial.gguf
  mv models/breeze-q8_0.partial.gguf models/breeze-q8_0.gguf
  rm models/breeze-bf16.gguf
fi
cat > /voice/server.json <<'JSON'
{"host":"127.0.0.1","port":7862,"backend":"cuda","device":0,"threads":4,"lazy_load":true,"idle_unload_ms":90000,"ui_management":true,"max_loaded_models":1,"models":[{"id":"breeze","family":"breeze_tts","path":"/voice/models/breeze-q8_0.gguf","task":"tts","mode":"streaming","session_options":{"breeze_tts.reference_cache_slots":"1"}}]}
JSON
echo 'VOICE_STAGE: Starting speech services'
whisper/build/bin/whisper-server --host 127.0.0.1 --port 8188 --model /voice/models/ggml-base.bin --language auto --threads 4 &
whisper_pid=$!
audio/build/portal/bin/audiocpp_server --config /voice/server.json &
speech_pid=$!
trap 'kill "$whisper_pid" "$speech_pid" 2>/dev/null || true; wait; exit 0' TERM INT
set +e
wait -n "$whisper_pid" "$speech_pid"
code=$?
kill "$whisper_pid" "$speech_pid" 2>/dev/null
wait
exit "$code"
