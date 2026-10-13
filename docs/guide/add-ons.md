# Docker add-ons

Pithagoras can install and manage **Browser** and **Voice** from **Settings → Add-ons**. Each runs in its own container on the same Docker host as Pithagoras.

The portal talks directly to the host Docker API; no Docker CLI inside the portal and no Docker-in-Docker daemon are required.

This guide covers the managed Linux Docker installation. Add-ons are separate from [pi extensions](/guide/extensions) and [channel packages](/channels/index).

The **Subagents** and **Memory** tabs beside them switch on the [opt-in features](/guide/features) — a subagent tool and Understory as the agent's memory. The portal can run Understory itself with the same Docker access; pointed at one you run, it needs none. Image generation and editing, which need no Docker at all, are set up under [Settings → Agent → Media](/guide/features#image-generation).

## Choose your next step

- **First installation:** [Docker access](#docker-access) → [GPU access](#gpu-access-for-voice) → install [Browser](#install-browser) or [Voice](#install-voice).
- **Already installed:** jump to [controls](#voice-controls-and-memory), [troubleshooting](#troubleshooting), or [updates and removal](#updates-and-removal).

## Docker access

### Check your Compose configuration

Use a Linux host with Docker Engine and Docker Compose. Keep these entries in the portal service:

```yaml
services:
  portal:
    # Keep the image/build, environment and other volumes from the shipped file.
    network_mode: host
    volumes:
      - portal-data:/data
      - /var/run/docker.sock:/var/run/docker.sock

volumes:
  portal-data:
```

::: tip Already using the shipped Compose files?
Both already mount the socket. Merge the fragment above only if you maintain your own configuration.
:::

The socket is required **even with `EXECUTOR=host`**.

The portal needs neither `privileged: true` nor its own GPU reservation. The installer requests a GPU for the separate voice container.

Host networking is part of this setup: the portal connects to add-on services at the Docker host's loopback address. In an ordinary bridge-networked portal container, `127.0.0.1` means the portal container, so those managed endpoints will not work unchanged.

### Apply the configuration

From the repository directory:

```sh
docker compose up -d --build portal
```

::: details Using Portainer instead?
1. Use `docker-compose.portainer.yml`.
2. Retain `network_mode: host` and the Docker socket mount.
3. Set the required portal password.
4. Select **Update the stack**.

The Portainer service is named `pithagoras`, not `portal`.
:::

### Verify Docker access

Run:

```sh
docker exec pithagoras curl --fail --unix-socket /var/run/docker.sock http://localhost/_ping
```

Expected response: **`OK`**.

::: details Custom users or socket paths
The official image runs as root. If you run it as a different user, grant that user access to the socket's host group instead of making the socket world-writable. A custom socket can be mounted and selected with the portal environment variable `DOCKER_SOCKET`.
:::

::: warning Docker host access
The socket grants control of the Docker host, including creating containers and mounting host files. Keep the portal authenticated and on your trusted network; see [security](/guide/security). Do not expose an unauthenticated Docker TCP endpoint.
:::

## GPU access for Voice

**Browser users can skip this section.** **Speech synthesis** (spoken replies) requires:

- A compatible NVIDIA GPU and working host driver.
- NVIDIA Container Toolkit configured for Docker.
- Enough VRAM for the voice runtime alongside your LLM.

**Kokoro** and **speech recognition** need no GPU and none of the above: on a host without one the installer sets them up on the CPU (see [No GPU](#no-gpu)). Both need at least **30 GB free disk space** during setup, and enough RAM.

### Check the host driver

On the Docker host:

```sh
nvidia-smi
```

### Configure NVIDIA Container Toolkit

Install NVIDIA Container Toolkit using [NVIDIA's distribution-specific instructions](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). After installation, configure Docker and restart its daemon (this can affect running containers):

```sh
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Verify GPU access inside Docker

Run the same CUDA image used by the installer:

```sh
docker run --rm --gpus all nvidia/cuda:12.4.1-devel-ubuntu22.04 nvidia-smi
```

Continue only when this lists your GPU.

::: details Running Docker in a VM or LXC?
In a VM or LXC, GPU access must already work inside the environment running Docker. The portal installer does not configure hypervisor passthrough or install host drivers.
:::

The first installation needs internet access for container registries, Ubuntu packages, GitHub sources, and Hugging Face models. No Hugging Face token field is needed for the public models used by this installer.

## Install Browser

1. Open **Settings → Add-ons → Browser**.
2. Enter a password for the browser web UI, or use the password generator. This is separate from the portal login password.
3. Click **Install** and wait for the image download and container startup.
4. Open the **Browser** page and verify the live browser appears. Log into sites there when needed; its profile persists.
5. Ask a session to use the browser.

::: details Browser container, storage and ports
| Item | Value |
| --- | --- |
| Image | `lscr.io/linuxserver/chromium:latest` |
| Container | `pithagoras-browser` |
| Profile volume | `pithagoras_browser-profile` (override: `BROWSER_VOLUME`) |
| Network | Host |
| Shared memory | 1 GiB |
| Chromium security option | `seccomp=unconfined` |
| HTTP / HTTPS | `3010` / `3011`, on `127.0.0.1` only (`BROWSER_BIND`) |
| Debugging port | `9222`, on `127.0.0.1` only |

Avoid port conflicts. The web page of the browser is reached through the portal's
`/browser-ui`, or from the host itself; see [the browser's own port](/guide/browser#the-browser-s-own-port)
for other machines.
:::

Environment variables on the portal adjust it; a value saved in Settings wins over
the variable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_USER` / `BROWSER_PASSWORD` | `agent` / — | Login for the browser web UI |
| `BROWSER_PORT` / `BROWSER_HTTPS_PORT` | `3010` / `3011` | Its HTTP and HTTPS ports |
| `BROWSER_BIND` | `127.0.0.1` | The IPv4 address those ports listen on; the portal reaches them on `127.0.0.1` whatever it is. `0.0.0.0` opens them to every machine that can reach this one. The shipped Compose files and the Portainer stack pass it on from `.env`. Applies when the browser is installed, so remove and install it again after changing it |
| `BROWSER_STREAM_PORT` | `8082` | The port the embedded live view reads frames from |
| `BROWSER_HOST` | `127.0.0.1` | Where the portal reaches the browser |
| `BROWSER_CDP_URL` | `http://127.0.0.1:9222` | The debugging endpoint the agent's browser tools use |
| `BROWSER_VOLUME` | `pithagoras_browser-profile` | The profile volume |
| `BROWSER_EXTERNAL` | — | `true` for a browser you run yourself (see below) |
| `BROWSER_BINARY` | — | Without a Docker socket — typically the portal run from source — the portal starts a Chrome or Chromium already on the machine, and this names its binary; the profile is kept in `$DATA_DIR/browser-profile` |

For embedded browser access, serve Pithagoras over HTTPS and follow the certificate setup in the [browser guide](/guide/browser). Voice microphone access also requires HTTPS, except on localhost.

### Browser controls

| Action | Result |
| --- | --- |
| **Stop** | Stops the browser container; keeps its profile and logins. |
| **Start** | Starts the installed container with that profile. |
| **Remove** | Deletes the container; keeps the profile volume. |
| **Install** after removal | Recreates the container and reuses a retained profile. |

Browser uses Docker's `unless-stopped` restart policy. If `BROWSER_EXTERNAL=true`, lifecycle management belongs to your external deployment; portal install/start/stop/remove actions are disabled by the server.

## Install Voice

### Choose engines, install and wait for Ready

1. Open **Settings → Add-ons → Voice**.
2. Expand **Voice service**. Under **Speech engines** the page shows the GPU it can read and what fits it. Leave **Choose for me, based on my GPU** on, or turn it off and pick the engines yourself (see [the engines](#engines-devices-and-memory) below).
3. Click **Install voice** and follow **Setup log** until the service shows **Ready**.

::: info First setup takes time
The installer downloads an image, builds the runtimes, and downloads the models of the engines you chose. A running container is not yet a ready service.
:::

Once the services are healthy, the installer enables voice and saves the endpoints automatically. If you previously used custom endpoints, click **Use installed voice** to reconnect. Before it replaces your saved endpoints, the runtime and the recognition model, and whether voice was on, the portal remembers them, so that [**Uninstall**](#remove-voice) can put them back. Your voice, speech detection and speaking instructions are not touched, and neither is your input language, with one exception: a Chatterbox install changes a language Chatterbox does not speak, such as auto-detect, to English, and uninstalling does not change it back.

### Engines, devices and memory

| | Choices | Runs on |
| --- | --- | --- |
| **Speech synthesis** | **Breeze** (English and Chinese, streams while it speaks) · **Chatterbox** (nineteen languages, clones a reference voice) · **Kokoro** (eight languages, 49 voices of its own, the least GPU memory) | The GPU; Kokoro on the CPU or the GPU, as you choose |
| **Speech recognition** | **Whisper** base or small · **Qwen3-ASR** 0.6B or 1.7B | Whisper always on the CPU; Qwen3-ASR on the CPU or the GPU, as you choose |

The default, and what every earlier installation has, is Breeze with Whisper base. Qwen3-ASR recognises more languages and is more accurate than Whisper. Beside a speech engine it is on the GPU unless you set **Speech recognition runs on** to **CPU**, which spares the card the model at the cost of CPU threads and memory. Whisper takes no GPU memory at all.

Kokoro can be put on the CPU with **Speech synthesis runs on**, which takes no GPU memory and about 0.24 seconds of computing for each second of speech on 8 threads (0.05 on an RTX 3060). Recognition beside it is then on the CPU too.

What runs on the CPU in audio.cpp (Kokoro, Qwen3-ASR) shares an audio.cpp process of its own (port `7863`); what runs on the GPU shares the GPU process (port `7862`). With the speech engine on the GPU and recognition on the CPU, the container has the GPU and the CUDA image; with nothing on the GPU it has neither (see [No GPU](#no-gpu)).

The page and the installer estimate what each combination needs: the GPU memory from the measured Breeze process and the size of the other model files, and the memory of the host for recognition on the CPU. Those are the host's own memory and CPUs, not any limit on the portal's container: recognition runs in a container of its own, which has no such limit.

| Model | GPU memory | Memory on the CPU |
| --- | --- | --- |
| Breeze | 4.5 GiB | not on the CPU |
| Chatterbox | 2.9 GiB | not on the CPU |
| Kokoro | 1.0 GiB (914 MiB measured) | 1.3 GiB |
| Whisper base / small | none | 0.4 / 0.9 GiB |
| Qwen3-ASR 0.6B | 1.4 GiB | 1.6 GiB |
| Qwen3-ASR 1.7B | 2.5 GiB | 2.9 GiB |

These are estimates, not guarantees. A combination **fits** when the GPU, or the host's memory for what runs on the CPU, has that much free now, is **tight** when it is big enough but other programs hold part of it right now (the models load only when voice is used, so it can still work), and does **not fit** when it is smaller than the combination needs. Recognition on the CPU is also judged by the threads of the host: measured on 8 threads of a desktop CPU, Qwen3-ASR 0.6B recognised speech about 5.4 times faster than it was spoken and 1.7B about 2.6 times. The page scales that by the threads the host has and warns when recognition is expected to fall behind the speaker; **Choose for me** only picks a model that stays well ahead of it, else Whisper base. Whisper's speed was not measured, so it is never called slow.

Before installing, Pithagoras reads the GPU with `nvidia-smi`. A portal in a container has no `nvidia-smi` of its own, so it asks a throwaway container of the small `ubuntu:22.04` base image, to which the NVIDIA Container Toolkit gives `nvidia-smi` as it does to any image; the multi-gigabyte CUDA image is not needed for that. The **Speech engines** block then says **GPU detected** with its name and memory, or warns **No GPU detected**; before anything could be asked it says **GPU not checked yet**. A host without `nvidia-smi`, without an NVIDIA runtime for Docker, with a driver that finds no device, or with a Docker that does not answer, has no GPU for voice: that is an answer, not an error. So does a host whose `nvidia-smi` lists a card but whose Docker has no runtime to hand it to a container (the driver without the NVIDIA Container Toolkit): Docker is asked even when `nvidia-smi` answers, and the block then names the card and says that Docker cannot use it and what to install. At install time it checks again:

- With **Choose for me**, it picks the best combination that fits: Breeze, and the largest of Whisper base, Qwen3-ASR 0.6B and 1.7B that fits next to it on the GPU; Chatterbox only when Breeze does not fit, and Kokoro only on a card too small for either of them (it cannot clone or design a voice, so a card that is merely busy right now keeps the others). Without a GPU it picks Kokoro on the CPU with the recognition that fits beside it, or recognition alone (see below). It writes what it found as the first line of the setup log.
- With your own pick, it keeps it, and refuses one that the card or the host's memory cannot hold at all, naming the combination that would fit. A tight pick installs, with that noted in the log.
- If the check finds there is no GPU, a pick with anything on the GPU is refused in one sentence (put Kokoro on the CPU, install recognition only, or add a GPU; where the host lists a card that Docker cannot use, install the NVIDIA Container Toolkit), and a pick with everything on the CPU installs. A Docker that fails to start a container that asks for a GPU is told in one plain sentence about the NVIDIA Container Toolkit, not in its own words; a driver that is too old for the CUDA image the voice container runs in is told as that. Any other error of the toolkit is shown as Docker words it.
- If it cannot tell at all (for instance the check itself failed for another reason), it installs your pick unchecked and Docker has the last word.

### No GPU

Breeze and Chatterbox need a GPU: on a CPU Breeze took about 3.5 seconds to compute each second of speech and Chatterbox about 7 (measured on 8 threads of a desktop CPU, with the model already loaded), too slow for conversation. Kokoro took about 0.24, so a host without a GPU can still speak with it, and speech recognition runs on a CPU as well:

- The **Speech engines** block warns **No GPU detected. Everything runs on the CPU: Kokoro can speak, the other speech engines need a GPU.** The speech synthesis engine offers Kokoro, on the CPU, and **No speech synthesis**; the page says how long each second of speech takes on the host's threads, and warns where it may take longer to make than to say. Recognition stays selectable: Whisper base or small, Qwen3-ASR 0.6B or 1.7B, on the CPU, each with the memory it needs and a warning where the host has too few threads.
- **Choose for me** picks Kokoro with the largest recognition that fits the host's memory beside it and keeps ahead of the speaker, or recognition alone where the host has too little memory or too few threads for Kokoro.
- **Install voice** builds a container with no GPU request, from the small base image, with a CPU-only audio.cpp build for Kokoro and Qwen3-ASR (no CUDA toolchain, no CUDA image) or only Whisper.cpp for Whisper alone. Nothing is refused and nothing fails because there is no GPU.
- With recognition alone the saved settings have no speech runtime. **Dictation** works. The voice-conversation control is not offered, because it speaks the replies, and the voice settings drop what concerns speaking (the voice, how it is generated, the speaking instructions). Where a speech engine is installed and the GPU is later gone (a driver that no longer loads), recognition alone is offered beside the engine, and **Rebuild with these engines** switches to it. A GPU added later offers speech synthesis in the same block, next to **No speech synthesis**, which an installation of recognition alone keeps showing; **Rebuild with these engines** installs the speech engine you pick.

With several GPUs, **Speech engines** shows a **GPU** menu where the engines you pick use one, with each card's free memory. **Automatic** takes the card `VOICE_GPU` names (see below); without one, installing or rebuilding takes the one with the most memory free, and the container is given that card, while a restart of an installed service keeps the card it is on. Choosing one yourself lets the session model keep the other. The choice is saved by the card's UUID, which names the same card after a reboot or a card added beside it, and it holds at once: a running service is recreated on that card, with its models kept, and a service that is stopped or not installed yet is on it from its next start. A card that cannot hold the engines installed is refused, with what would fit, as it is for a new install, and the service stays where it is. A saved card that is no longer there is ignored, and so is the card a container was given when it has been taken out: the container is then made again on a card that is there, as an install picks it, or refused where that one cannot hold the engines. When the container is recreated later with the engines it has, for instance after a portal update, it stays on its card. Settings on the portal set the defaults, as in the multilingual Compose service. Put them in `.env` (the shipped Compose files and the Portainer stack pass both on to the portal) or set them in the portal's environment:

| Variable | Meaning |
| --- | --- |
| `VOICE_GPU` | The GPU index (as `nvidia-smi` lists it) the voice container uses where no GPU is chosen on the page; a GPU chosen there wins. An index that no GPU has is ignored where the GPUs can be read; where they cannot, it is used as given. **Start voice** moves an existing container to it, unless that GPU cannot hold the engines installed. |
| `VOICE_VRAM_RESERVE_MIB` | GPU memory, in MiB, to keep free for something else on the same card, such as a model you run in the container later. Counted against every combination. |
| `NVIDIA_SMI` | The `nvidia-smi` binary to run, when it is not on the portal's `PATH`. |

To change the engines of an installed service, pick others under **Speech engines** and click **Rebuild with these engines**. The running service is stopped first, so the memory it holds is not counted against the new choice, and started again if the choice is refused. The container is recreated, with the models and builds in the volume kept; only what the new choice needs is built or downloaded, and a runtime already built for an engine is not built again. The CUDA kernels are compiled for the architecture of one card, so a different card, such as another `VOICE_GPU` or another GPU chosen on the page, rebuilds the runtime once. **Use installed voice** then points the settings at the new engines. A Chatterbox choice needs an input language (not auto-detect) and a voice with a recording, as in [voice control](/guide/voice#other-languages-chatterbox-and-qwen3-asr).

### Choose your voice settings

1. Choose a **Speaking voice** and **Input language**.
2. Choose **Fast** speech generation to start with. **Expressive** uses more compute and VRAM.
3. Keep **Lazy load · release GPU memory when voice is idle** enabled, unless you want the model kept warm.
4. Click **Save voice settings**.

### Start talking

Open a session, click the **microphone**, allow microphone access, and speak.
The first connection loads the speech model into GPU memory.

Use **Add voice** for your own designed or reference-cloned voice. Installing the runtime does not install a reference recording. See [voice control](/guide/voice) for references and speech detection settings.

::: details What the installer downloads and builds

The managed installer:

- Creates `pithagoras-voice` and the named volume `pithagoras_voice-models`, mounted at `/voice`.
- Builds audio.cpp release v0.9.0 with CUDA, with the families of the engines you chose (Breeze, Chatterbox, Kokoro, Qwen3-ASR), and Whisper.cpp without CUDA when Whisper is chosen. Without any GPU use it builds audio.cpp for the CPU alone instead, in a directory of its own, or none for Whisper alone. A build keeps every family it has been given, so switching engines back and forth compiles once. A build from an earlier pinned revision is built again once, on the first start after an update; the models are not downloaded again.
- Downloads what the choice needs: multilingual Whisper `base` or `small`; Breeze-TTS-2 BF16 GGUF, quantized to **Q8_0** on CPU, verified, and the BF16 source removed after successful conversion; the Chatterbox Multilingual and Qwen3-ASR Q8_0 GGUF files from a pinned revision of the audio.cpp repository, and Kokoro 82M Q8_0 from a later one, checked against their SHA-256. For Kokoro it also installs eSpeak NG (`libespeak-ng1` and `espeak-ng-data` from Ubuntu), which turns the text into phonemes.
- Retains source trees, compiled binaries and model files in the named volume.
- Starts the services on the portal’s loopback interface by sharing its Docker network namespace. No voice ports are published on the host.
:::

### Service addresses and health checks

| Setting | Managed value |
| --- | --- |
| Speech runtime | **Breeze audio.cpp · streaming**, **Chatterbox audio.cpp · multilingual**, **Kokoro audio.cpp · built-in voices**, or **No speech synthesis** (recognition only) |
| Speech synthesis URL | `http://127.0.0.1:7862/v1/audio/speech`; `http://127.0.0.1:7863/v1/audio/speech` for Kokoro on the CPU; none without speech synthesis |
| Speech recognition URL | Whisper: `http://127.0.0.1:8188/inference`. Qwen3-ASR: `http://127.0.0.1:7862/v1/audio/transcriptions` on the GPU, `http://127.0.0.1:7863/v1/audio/transcriptions` on the CPU |
| Speech recognition model | Whisper: empty. Qwen3-ASR: `qwen3-asr` |

Check readiness from inside the portal container. Each port answers where its service is part of the choice (`8188` Whisper, `7862` the GPU process, `7863` the CPU process for Kokoro or Qwen3-ASR on the CPU); for the default, both `8188` and `7862`:

```sh
docker exec pithagoras node -e 'Promise.all([8188,7862].map(async p => console.log(p, (await fetch(`http://127.0.0.1:${p}/health`)).status)))'
```

Voice works with either bridge or host networking for the portal. Set
`PORTAL_CONTAINER_NAME` to its Docker container name if you use a custom
hostname; the supplied Compose files set this explicitly. The add-on shares
that container’s network namespace, so `127.0.0.1` reaches the same services in
both containers. The browser add-on has its own networking requirements.

After upgrading, a running managed voice container migrates automatically at
portal startup or within 30 seconds. This replaces only the managed voice
container and keeps the model/build volume. A deliberately stopped add-on
stays stopped; its next **Start voice** performs any required migration.
Recreating the portal is also detected so voice joins its new network namespace.

Native portal installations use host networking and require Linux; on Docker
Desktop, run the portal itself in Docker.

::: tip Ready does not mean loaded
The service can be healthy while the TTS model is unloaded. GPU memory is allocated when needed.
:::

### Voice controls and memory

| Action | Result |
| --- | --- |
| **Mute** in a voice session | Stops listening; keeps the voice session and spoken replies active. |
| **End** in a voice session | Releases that tab's connection; does not stop an accepted agent task. With lazy loading, the last released connection allows the speech model to unload. |
| **Start voice** | Starts the existing managed container, reusing its models. |
| **Retry setup** | Restarts a failed container and its setup script; retained downloads/builds are reused where the script can reuse them. |
| **Stop · release VRAM** | Stops the voice processes in the container, releasing their GPU allocations. Keeps model files. |
| **Uninstall** | Asks first, then stops and removes the `pithagoras-voice` container and puts the voice settings back (see [Remove Voice](#remove-voice)). Keeps the downloaded engines and models unless you tick the box in the question. |
| **GPU** (shown when the host has more than one GPU and the engines use one) | Runs the speech engines on the chosen GPU, so the session model can keep the other. A running voice service is recreated on it at once and a stopped one on its next start; model files are kept. **Automatic** takes the GPU `VOICE_GPU` names, else the one with the most free memory when installing or rebuilding; a start keeps the GPU the service is on. A GPU that cannot hold the engines installed is refused. |
| Disable voice controls and save | Hides the session controls; the service stays installed. Use **Uninstall** to remove it. |

### When GPU memory is released

Lazy loading uses per-tab leases.

- Abandoned connections expire after **75 seconds**.
- The portal checks for expired connections every **30 seconds**.
- audio.cpp also has a **90-second** idle-unload setting.

 Do not expect a crashed tab to release memory instantly. With lazy loading off, the portal periodically requests the model remain loaded. Ending one tab does not release a model still used by another active tab.

::: warning After a reboot or service exit
The managed voice container has **no automatic Docker restart policy**. After a host reboot or service exit, use **Start voice** or **Retry setup**. Activating the microphone loads a model in a running service; it does not install or restart a stopped service.
:::

## Troubleshooting

::: details Docker unavailable / permission denied
Run the socket `_ping` check above. Verify the mount and process permissions. Socket presence alone does not prove daemon access.
:::

::: details NVIDIA driver/device error
Run the CUDA `docker run --gpus all` check. Fix host driver, toolkit or passthrough before retrying Voice. On a host without an NVIDIA GPU that Docker can use, the page says **No GPU detected** and installs Kokoro and recognition on the CPU (see [No GPU](#no-gpu)); the other speech engines need the NVIDIA Container Toolkit and a GPU.
:::

::: details Setup stays at Starting
Expand Setup log or run `docker logs --tail 100 -f pithagoras-voice`; compilation and quantization happen after container startup.
:::

::: details Port already allocated
Check for older voice/browser containers using these ports. Stop the specific conflicting service before retrying.
:::

::: details Model load fails / weight buffer allocation fails
Run `nvidia-smi` and check other LLM/TTS processes. Stop duplicate voice services, reduce the LLM's GPU/context allocation or use Fast speech generation. Restart Voice after freeing memory.
:::

::: details No microphone prompt
Use HTTPS or localhost, grant browser permission, then restart voice mode.
:::

::: details HTTP 409 during speech
Another synthesis request owns the runtime. End the competing voice session and retry.
:::

::: details Portal rebuild did not update Voice
Add-on containers are managed separately; follow the recreate steps below.
:::

### Diagnostic commands

```sh
docker ps -a --filter name=pithagoras
docker logs --tail 100 pithagoras-browser
docker logs --tail 100 pithagoras-voice
nvidia-smi
docker volume inspect pithagoras_browser-profile pithagoras_voice-models
```

Do not run the old Python Breeze/Whisper Compose overlay or systemd units alongside the managed installer unless you deliberately maintain separate endpoints and enough resources. They are alternative deployments, not prerequisites; duplicate services can consume VRAM even after you stop the managed add-on.

## Updates and removal

Rebuilding the portal does not recreate its sibling add-on containers.

### Update Browser

Browser installation reuses an existing local image; to fetch a newer image, pull it explicitly, then **Remove → Install** in Settings:

```sh
docker pull lscr.io/linuxserver/chromium:latest
```

### Recreate Voice after a portal update

Voice's setup script is captured when its container is created. To apply a newer installer after updating the portal, end voice sessions, click **Uninstall** and leave **Also delete the downloaded engines and models** unticked, then click **Install voice** again. The models and builds in `pithagoras_voice-models` are reused; recreating is not a guarantee that every cached binary is rebuilt. The installer pins its runtime revisions rather than tracking upstream automatically.

### Remove Voice

Click **Uninstall** under **Settings → Add-ons → Voice → Voice service**. It is offered once there is a container, or while the saved settings still point at the managed service after the container is gone (removed by hand, say), and asks first, naming what goes (with **Ask before deleting** turned off under [Settings](/guide/interface#confirmations), the question is skipped and the downloads are kept). Then:

- The `pithagoras-voice` container is stopped and removed. Nothing else of yours is touched: a container of that name that the portal did not make is left alone, and the Docker image the container ran in stays, since other containers may use it.
- The voice settings go back to what they were before the install: the runtime, the speech recognition and speech synthesis addresses and the recognition model, and whether voice was on, as the portal remembered them when it connected the service. The recognition side (address and model) and the speech side (address and runtime) are remembered each on its own, and again at every connect, so an address you set up after the install and then connected over comes back as that one. Your voice, language, speech detection and speaking instructions are not part of that and stay as they are.
- An address you set up yourself stays as it is. Only what points at the managed service (the ports in [Service addresses](#service-addresses-and-health-checks)) is changed, so a speech server you saved after the install is not replaced by older settings. A service installed by an older portal, which remembered nothing, has what points at it reset to a portal with nothing set up (the Compose overlay's default addresses, no recognition model, the runtime **Breeze Python**) and voice switched off; your own address beside it is kept.
- **Also delete the downloaded engines and models** is off by default. Off, the volume `pithagoras_voice-models` stays and a later **Install voice** is quick. Ticked, the volume is deleted too, and the next install downloads and builds the engines again. This cannot be undone.
- If Docker refuses to delete the volume (another container has it, say), the container is still removed and the settings are still put back; the page says why the downloads stay, and they can be removed by hand (see below).
- The GPU chosen on the page is kept: it is a choice about the host, not about the service.

Afterwards the page shows **Not installed**, as on a portal that never installed the service, and **Install voice** works again. Uninstalling something that is not installed changes nothing, and where the settings still point at the service after the container was removed by hand, it puts them right. It waits while a setup is under way. Without access to Docker the page offers no **Uninstall** (it says **Automatic voice setup requires access to Docker.**), and the API answers `Docker is unavailable`, as it does for an install.

::: tip By hand
Without the button, `docker rm -f pithagoras-voice` removes the container, and `docker volume rm pithagoras_voice-models` the downloads, **only after the container is removed**. The settings are then yours to put right.
:::

### Delete the browser profile

::: danger Delete saved logins permanently
To erase browser logins, first click **Remove** in Settings, then delete the profile volume on the Docker host (substitute your configured `BROWSER_VOLUME` if different):

```sh
# Destructive: deletes the browser profile and saved logins.
docker volume rm pithagoras_browser-profile
```
:::

The current Settings UI offers **Remove**, which preserves the profile; it does not expose the separate profile-deletion API as a button.

### Data that remains

Portal settings and uploaded voice references live separately in the portal's `/data` volume; do not delete that volume to reset an add-on.

Named add-on volumes and containers are not part of the portal Compose lifecycle, so `docker compose down` does not stop or remove them.
