# Docker add-ons

Pithagoras can install and manage **Browser** and **Voice** from **Settings → Add-ons**. Each runs in its own container on the same Docker host as Pithagoras.

The portal talks directly to the host Docker API; no Docker CLI inside the portal and no Docker-in-Docker daemon are required.

This guide covers the managed Linux Docker installation. Add-ons are separate from [pi extensions](/guide/extensions) and [channel packages](/channels/index).

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

**Browser users can skip this section.** Voice requires:

- A compatible NVIDIA GPU and working host driver.
- NVIDIA Container Toolkit configured for Docker.
- At least **30 GB free disk space** during setup.
- Enough RAM and VRAM for the voice runtime alongside your LLM.

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
| HTTP / HTTPS | `3010` / `3011` |
| Debugging port | `9222` |

Avoid port conflicts and keep browser/debugging ports private.
:::

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

### Install and wait for Ready

1. Open **Settings → Add-ons → Voice**.
2. Expand **Voice service** and click **Install voice**.
3. Follow **Setup log** until the service shows **Ready**.

::: info First setup takes time
The installer downloads an image, builds the runtimes, and downloads and quantizes the models. A running container is not yet a ready service.
:::

Once both services are healthy, the installer enables voice and saves the endpoints automatically. If you previously used custom endpoints, click **Use installed voice** to reconnect.

### Choose your voice settings

1. Choose a **Speaking voice** and **Input language**.
2. Choose **Fast** speech generation to start with. **Expressive** uses more compute and VRAM.
3. Keep **Lazy load · release GPU memory when voice is idle** enabled, unless you want the model kept warm.
4. Click **Save voice settings**.

### Start talking

Open a session, click the **microphone**, allow microphone access, and speak.
The first connection loads Breeze into GPU memory.

Use **Add voice** for your own designed or reference-cloned voice. Installing the runtime does not install a personal Aria recording. See [voice control](/guide/voice) for references and speech detection settings.

::: details What the installer downloads and builds

The managed installer:

- Creates `pithagoras-voice` and the named volume `pithagoras_voice-models`, mounted at `/voice`.
- Builds pinned audio.cpp with CUDA and Whisper.cpp without CUDA. **Whisper runs on CPU**; Breeze uses one NVIDIA GPU.
- Downloads multilingual Whisper `base` and Breeze-TTS-2 BF16 GGUF, quantizes Breeze to **Q8_0** on CPU, verifies the generated file, then removes the BF16 source file after successful conversion.
- Retains source trees, compiled binaries and model files in the named volume.
- Starts both services on the portal’s loopback interface by sharing its Docker network namespace. No voice ports are published on the host.
:::

### Service addresses and health checks

| Setting | Managed value |
| --- | --- |
| Speech runtime | **Breeze audio.cpp · streaming** |
| Whisper inference URL | `http://127.0.0.1:8188/inference` |
| Breeze speech URL | `http://127.0.0.1:7862/v1/audio/speech` |

Check readiness from inside the portal container:

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
| **End** in a voice session | Releases that tab's connection; does not stop an accepted agent task. With lazy loading, the last released connection allows Breeze to unload. |
| **Start voice** | Starts the existing managed container, reusing its models. |
| **Retry setup** | Restarts a failed container and its setup script; retained downloads/builds are reused where the script can reuse them. |
| **Stop · release VRAM** | Stops both voice processes in the container, releasing their GPU allocations. Keeps model files. |
| Disable voice controls and save | Hides the session controls; it is not a container-uninstall operation. |

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
Run the CUDA `docker run --gpus all` check. Fix host driver, toolkit or passthrough before retrying Voice.
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

Voice's setup script is captured when its container is created. To apply a newer installer after updating the portal, end voice sessions, click **Stop · release VRAM**, and run:

```sh
docker rm pithagoras-voice
```

Then click **Install voice** again. Keep `pithagoras_voice-models` to reuse the models and builds; recreating is not a guarantee that every cached binary is rebuilt. The installer pins its runtime revisions rather than tracking upstream automatically.

### Remove Voice

Voice currently has no Remove button. To uninstall it while retaining downloads, stop it, run the same `docker rm` command, disable voice controls, and save.

::: danger Delete voice downloads permanently
To also erase downloaded models, source trees and builds, run the following **only after stopping and removing the voice container**:

```sh
# Destructive: the next installation must download/build the voice runtime again.
docker volume rm pithagoras_voice-models
```
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
