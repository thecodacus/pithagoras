#!/usr/bin/env bash
set -euo pipefail
trap 'echo "VOICE_SETUP_ERROR: setup or service failed (line $LINENO)" >&2' ERR
export DEBIAN_FRONTEND=noninteractive
# What to install. The portal sets these from the engines chosen in Settings.
# Without them this is the original combination: Breeze speech and Whisper base.
tts="${VOICE_TTS:-breeze}"
tts_device="${VOICE_TTS_DEVICE:-gpu}"
asr="${VOICE_ASR:-whisper}"
asr_model="${VOICE_ASR_MODEL:-base}"
threads="${VOICE_THREADS:-4}"
case "$tts" in
  breeze|chatterbox|kokoro|none) ;;
  *) echo "VOICE_SETUP_ERROR: unknown speech engine '$tts'" >&2; exit 2 ;;
esac
# Kokoro is the one speech engine small enough for the CPU.
case "$tts:$tts_device" in
  *:gpu|kokoro:cpu|none:*) ;;
  *:cpu) echo "VOICE_SETUP_ERROR: speech engine '$tts' runs on the GPU" >&2; exit 2 ;;
  *) echo "VOICE_SETUP_ERROR: unknown speech device '$tts_device'" >&2; exit 2 ;;
esac
speech_gpu=0; if [ "$tts" != none ] && [ "$tts_device" = gpu ]; then speech_gpu=1; fi
case "$asr:$asr_model" in
  whisper:base|whisper:small|qwen3-asr:0.6b|qwen3-asr:1.7b) ;;
  *) echo "VOICE_SETUP_ERROR: unknown speech recognition model '$asr:$asr_model'" >&2; exit 2 ;;
esac
# Where recognition runs. Whisper is always on the CPU. Qwen3-ASR is on the GPU next to a speech engine there
# unless it is put on the CPU, and without speech synthesis on the GPU there is no GPU to put it on.
if [ -n "${VOICE_ASR_DEVICE:-}" ]; then asr_device="$VOICE_ASR_DEVICE"
elif [ "$asr" = qwen3-asr ] && [ "$speech_gpu" = 1 ]; then asr_device=gpu
else asr_device=cpu; fi
case "$asr_device" in
  cpu) ;;
  gpu) if [ "$asr" = whisper ] || [ "$speech_gpu" = 0 ]; then echo "VOICE_SETUP_ERROR: recognition with '$asr' or without speech synthesis on the GPU runs on the CPU" >&2; exit 2; fi ;;
  *) echo "VOICE_SETUP_ERROR: unknown recognition device '$asr_device'" >&2; exit 2 ;;
esac
# Does anything of this choice need the GPU, and does anything run in audio.cpp on the CPU: Kokoro or Qwen3-ASR put there.
gpu=0; if [ "$speech_gpu" = 1 ] || [ "$asr_device" = gpu ]; then gpu=1; fi
cpu_server=0; if { [ "$asr" = qwen3-asr ] && [ "$asr_device" = cpu ]; } || { [ "$tts" != none ] && [ "$tts_device" = cpu ]; }; then cpu_server=1; fi
cd /voice
if [ -n "${VOICE_PLAN:-}" ]; then echo "VOICE_STAGE: $VOICE_PLAN"; fi
if [ ! -f /usr/local/share/pithagoras-voice-deps ]; then
  echo 'VOICE_STAGE: Installing build tools'
  dpkg --configure -a
  apt-get update
  apt-get install -y --no-install-recommends git cmake ninja-build build-essential curl ca-certificates python3 libssl-dev aria2
  touch /usr/local/share/pithagoras-voice-deps
fi
# Kokoro turns text into phonemes with eSpeak NG, which audio.cpp loads from the system library and its data.
if [ "$tts" = kokoro ] && ! dpkg -s libespeak-ng1 espeak-ng-data >/dev/null 2>&1; then
  echo 'VOICE_STAGE: Installing eSpeak NG for Kokoro'
  apt-get update
  apt-get install -y --no-install-recommends libespeak-ng1 espeak-ng-data
fi
checkout() {
  local directory="$1" repository="$2" revision="$3"
  if [ ! -d "$directory/.git" ]; then git clone "$repository" "$directory"; fi
  # A clone from an earlier pin has not seen this revision yet.
  if ! git -C "$directory" cat-file -e "$revision^{commit}" 2>/dev/null; then git -C "$directory" fetch origin; fi
  git -C "$directory" checkout "$revision"
  # A submodule may be named by an SSH address; the container has no SSH, and GitHub serves the same over HTTPS.
  git -C "$directory" -c url.https://github.com/.insteadOf=git@github.com: submodule update --init --recursive
}
# The audio.cpp model families this choice needs. Speech comes from audio.cpp for every engine; recognition
# does only for Qwen3-ASR, Whisper is a process of its own. Qwen3-ASR on the CPU runs from the GPU build too,
# so its family is in that build whichever device it is on. Kokoro on the CPU has nothing on the GPU beside it.
families=()
if [ "$tts" = breeze ]; then families+=(breeze_tts); fi
if [ "$tts" = chatterbox ]; then families+=(chatterbox); fi
if [ "$tts" = kokoro ]; then families+=(kokoro_tts); fi
if [ "$asr" = qwen3-asr ]; then families+=(qwen3_asr); fi
# The audio.cpp release everything is built from: v0.9.0, the first with Kokoro.
audio_revision=795c45fbde0a7d29c93b22199728ff5caaec02e5
# Builds audio.cpp into $1 (CUDA on or off in $2) for the families after them, unless a build there already
# holds them. A build keeps every family it was given, so switching engines back and forth compiles once. The
# kernels of a CUDA build are compiled for this card's architecture alone, and the card the container gets can
# change between installs. A build from another revision is built again.
build_audio() {
  local dir="$1" cuda="$2" have models architecture='' built_architecture=''
  shift 2
  local built="$dir/pithagoras-families"
  # A build from before this was written down is from the earlier pin.
  local built_revision
  built_revision=$(cat "$dir/pithagoras-revision" 2>/dev/null || true)
  # A volume from before engines could be chosen was built for Breeze alone.
  if [ -f "$built" ]; then have=$(cat "$built"); elif [ "$cuda" = on ] && [ -x "$dir/bin/audiocpp_server" ]; then have=breeze_tts; else have=; fi
  models=$(printf '%s,' "$have" "$@" | tr ',' '\n' | sed '/^$/d' | sort -u | paste -sd, -)
  if [ "$cuda" = on ]; then
    architecture=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '. ')
    # A volume from before this was written down has it in the CMake cache.
    built_architecture=$(cat "$dir/pithagoras-architecture" 2>/dev/null || sed -n 's/^CMAKE_CUDA_ARCHITECTURES:[A-Z]*=//p' "$dir/CMakeCache.txt" 2>/dev/null || true)
  fi
  if [ "$models" != "$have" ] || [ "$built_revision" != "$audio_revision" ] || { [ -n "$built_architecture" ] && [ "$built_architecture" != "$architecture" ]; } || [ ! -x "$dir/bin/audiocpp_server" ] || { [ "$cuda" = on ] && [ ! -x "$dir/bin/audiocpp_gguf" ]; } || ! grep -q 'AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER:BOOL=ON' "$dir/CMakeCache.txt" 2>/dev/null; then
    if [ "$cuda" = on ]; then
      echo "VOICE_STAGE: Building CUDA speech runtime and quantizer ($models, sm_$architecture)"
      (cd audio && bash scripts/build_linux.sh --native-model-manager --system-openssl --cuda on --cuda-arch "$architecture" --build-dir "/voice/$dir" --build-type Release --model-set custom --models "$models" --target audiocpp_server --target audiocpp_gguf --jobs 4) 2>&1 | tr '\r' '\n'
      echo "$architecture" > "$dir/pithagoras-architecture"
    else
      echo "VOICE_STAGE: Building CPU audio runtime ($models)"
      (cd audio && bash scripts/build_linux.sh --native-model-manager --system-openssl --cuda off --build-dir "/voice/$dir" --build-type Release --model-set custom --models "$models" --target audiocpp_server --jobs 4) 2>&1 | tr '\r' '\n'
    fi
    echo "$models" > "$built"
    echo "$audio_revision" > "$dir/pithagoras-revision"
  fi
}
# No audio.cpp at all for Whisper alone. Without a GPU it is a CPU build of its own, with no CUDA toolchain.
audio_gpu=audio/build/portal
audio_cpu=$audio_gpu
if [ "$gpu" = 1 ] || [ "$cpu_server" = 1 ]; then
  echo 'VOICE_STAGE: Preparing pinned audio runtime'
  checkout audio https://github.com/0xShug0/audio.cpp.git "$audio_revision"
  if [ "$gpu" = 1 ]; then build_audio "$audio_gpu" on "${families[@]}"
  else audio_cpu=audio/build/portal-cpu; build_audio "$audio_cpu" off "${families[@]}"; fi
fi
if [ "$asr" = whisper ]; then
  echo 'VOICE_STAGE: Preparing CPU speech recognition'
  checkout whisper https://github.com/ggml-org/whisper.cpp.git a2b36eb677918d4f9ab1db7b8a7ff968563ed163
  if [ ! -x whisper/build/bin/whisper-server ]; then
    cmake -S whisper -B whisper/build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DWHISPER_BUILD_SERVER=ON
    cmake --build whisper/build --target whisper-server -j 4
  fi
fi
mkdir -p models
download() {
  local url="$1" destination="$2" checksum="$3"
  if [ ! -s "$destination" ]; then
    aria2c --continue=true --max-connection-per-server=4 --split=4 --min-split-size=16M --file-allocation=none --auto-file-renaming=false --max-tries=5 --retry-wait=5 --summary-interval=10 --console-log-level=warn --checksum=sha-256="$checksum" --dir="$(dirname "$destination")" --out="$(basename "$destination").part" "$url" 2>&1 | tr '\r' '\n'
    mv "$destination.part" "$destination"
  fi
}
if [ "$asr" = whisper ]; then
  echo "VOICE_STAGE: Downloading multilingual Whisper $asr_model"
  bash whisper/models/download-ggml-model.sh "$asr_model" /voice/models 2>&1 | tr '\r' '\n'
fi
# Chatterbox and Qwen3-ASR come from one pinned revision of the audio.cpp GGUF repository, Kokoro from a later one,
# each checked against its SHA-256.
gguf=https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/6d5436fc85f7a20c2e9f4e472b7f3a532f686444
if [ "$asr" = qwen3-asr ]; then
  case "$asr_model" in
    0.6b) folder=Qwen3-ASR-0.6B-GGUF; checksum=6c44ec2fb4cee513892d7863c1fcc3ea6b699ffa4d899b0ef4ab19956d9544f7 ;;
    1.7b) folder=Qwen3-ASR-1.7B-GGUF; checksum=da4fc2ac7f24dee784d1684eb1f35836cdbf559519452ae11777670734c0a4f8 ;;
  esac
  echo "VOICE_STAGE: Downloading Qwen3-ASR $asr_model"
  download "$gguf/$folder/qwen3-asr-$asr_model-q8_0.gguf" "models/qwen3-asr-$asr_model-q8_0.gguf" "$checksum"
fi
if [ "$tts" = chatterbox ]; then
  echo 'VOICE_STAGE: Downloading Chatterbox Multilingual'
  download "$gguf/Chatterbox-GGUF/chatterbox-q8_0.gguf" models/chatterbox-q8_0.gguf d586dd1aa59613cab8046176fb7ca5ba191c02a9b10ffa5b0d892ed22b470656
fi
if [ "$tts" = kokoro ]; then
  echo 'VOICE_STAGE: Downloading Kokoro 82M'
  download "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/351dbab8d8534675ee29440bb402e348b09e55e2/Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf" models/kokoro-82m-q8_0.gguf 5d800fd204029302c10313daeafdb31c875c7c29ae31974d0d156cc7f512d1d0
fi
if [ "$tts" = breeze ] && [ ! -s models/breeze-q8_0.gguf ]; then
  echo 'VOICE_STAGE: Downloading full-precision Breeze-TTS-2'
  download "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/056144d2744697c9439bd32647279674dba0c964/Breeze-TTS-2-GGUF/breeze-tts-2-bf16.gguf" models/breeze-bf16.gguf a00c9f678b4c5ae03d1dcd228f636b329352cda200823faef4e01d3bd97c0a89
  echo 'VOICE_STAGE: Quantizing Breeze to Q8_0 on CPU'
  audio/build/portal/bin/audiocpp_gguf --input models/breeze-bf16.gguf --output models/breeze-q8_0.partial.gguf --type q8_0 --overwrite
  audio/build/portal/bin/audiocpp_gguf --inspect models/breeze-q8_0.partial.gguf
  mv models/breeze-q8_0.partial.gguf models/breeze-q8_0.gguf
  rm models/breeze-bf16.gguf
fi
# The portal sends the configs for the choice. Without them, only the original combination is known here.
if [ "$gpu" = 1 ]; then
  if [ -n "${VOICE_SERVER_CONFIG:-}" ]; then
    printf '%s\n' "$VOICE_SERVER_CONFIG" > server.json
  elif [ "$tts" = breeze ] && [ "$asr" = whisper ]; then
    cat > server.json <<'JSON'
{"host":"127.0.0.1","port":7862,"backend":"cuda","device":0,"threads":4,"lazy_load":true,"idle_unload_ms":90000,"ui_management":true,"max_loaded_models":1,"models":[{"id":"breeze","family":"breeze_tts","path":"/voice/models/breeze-q8_0.gguf","task":"tts","mode":"streaming","session_options":{"breeze_tts.reference_cache_slots":"1"}}]}
JSON
  else
    echo 'VOICE_SETUP_ERROR: VOICE_SERVER_CONFIG is missing' >&2
    exit 2
  fi
fi
if [ "$cpu_server" = 1 ]; then
  if [ -z "${VOICE_CPU_CONFIG:-}" ]; then echo 'VOICE_SETUP_ERROR: VOICE_CPU_CONFIG is missing' >&2; exit 2; fi
  printf '%s\n' "$VOICE_CPU_CONFIG" > server-cpu.json
fi
echo 'VOICE_STAGE: Starting speech services'
pids=()
if [ "$asr" = whisper ]; then
  whisper/build/bin/whisper-server --host 127.0.0.1 --port 8188 --model "/voice/models/ggml-$asr_model.bin" --language auto --threads "$threads" &
  pids+=($!)
fi
if [ "$gpu" = 1 ]; then
  "$audio_gpu/bin/audiocpp_server" --config /voice/server.json &
  pids+=($!)
fi
if [ "$cpu_server" = 1 ]; then
  # Beside a speech engine on the GPU this process is for the CPU alone: it must not take a CUDA context of its own.
  CUDA_VISIBLE_DEVICES= "$audio_cpu/bin/audiocpp_server" --config /voice/server-cpu.json &
  pids+=($!)
fi
trap 'kill "${pids[@]}" 2>/dev/null || true; wait; exit 0' TERM INT
set +e
wait -n "${pids[@]}"
code=$?
kill "${pids[@]}" 2>/dev/null
wait
exit "$code"
