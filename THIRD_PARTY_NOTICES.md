# Third-party notices

Pithagoras itself is licensed under the Apache License 2.0 (see `LICENSE` and `NOTICE`).

The web app ships a few ready-made files that come from other projects. `npm run build -w web` copies them into `voice-assets/` of the web app, next to a copy of this file, and the voice mode in the browser loads them from there. They stay under their own licences, which are given in full below.

## Voice activity detection

Files: `vad.worklet.bundle.min.js` and `silero_vad_v5.onnx`, from the npm package `@ricky0123/vad-web` 0.0.30 (https://github.com/ricky0123/vad). The package is licensed under the ISC License. The model `silero_vad_v5.onnx` is the Silero VAD model (https://github.com/snakers4/silero-vad), licensed under the MIT License.

### @ricky0123/vad-web (ISC)

    ISC License

    Copyright (c) 2022-present ricky0123

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted, provided that the above
    copyright notice and this permission notice appear in all copies.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

### Silero VAD model (MIT)

    MIT License

    Copyright (c) 2020-present Silero Team

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## ONNX Runtime Web

Files: `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.wasm`, from the npm package `onnxruntime-web` 1.29.0 (https://github.com/microsoft/onnxruntime), licensed under the MIT License. The WebAssembly build also contains third-party code, whose notices are listed in https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt.

### onnxruntime-web (MIT)

    MIT License

    Copyright (c) Microsoft Corporation

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Image copies in the Media extension (sharp and libvips)

The Media extension (`extensions/media`), which the portal ships, makes the small copies of its gallery's pictures, and scales pictures down for an edit, with the npm package `sharp` 0.35.5 (https://github.com/lovell/sharp), which is licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0). It does not ship in the web app's `voice-assets/`; it is installed with the extension, from the extension's own lock file, and so it is in the Docker image.

sharp runs on libvips (https://github.com/libvips/libvips), which comes prebuilt in the npm packages `@img/sharp-libvips-<platform>` that the extension's `npm ci` installs next to it, as the shared library `libvips-cpp`. libvips is licensed under the GNU Lesser General Public License, version 3 or later (LGPL-3.0-or-later), and the library bundles other libraries, among them glib, libexif and libheif, under the LGPL 3 or compatible licences. The texts are not repeated here:

- GNU Lesser General Public License, version 3: https://www.gnu.org/licenses/lgpl-3.0.txt (it builds on the GNU General Public License, version 3: https://www.gnu.org/licenses/gpl-3.0.txt)
- the licences of the libraries inside the prebuilt libvips, and their versions: https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md
- the source code of libvips: https://github.com/libvips/libvips, and of the build: https://github.com/lovell/sharp-libvips

libvips is used unchanged and is linked dynamically: it can be replaced by another build of the library, either by installing another `@img/sharp-libvips-<platform>` package of the same major version or by pointing sharp at a libvips of the system (see https://sharp.pixelplumbing.com/install#custom-libvips).

## The browser driver of the Browser extension (playwright-core)

The Browser extension (`extensions/browser`), which comes with the portal, drives the agent's browser over its debugging port with the npm package `playwright-core` 1.63.0 (https://github.com/microsoft/playwright), which is licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0). It does not ship in the web app's `voice-assets/`; it is installed with the extension, from the extension's own lock file, and so it is in the Docker image. Its NOTICE file says:

    Playwright
    Copyright (c) Microsoft Corporation

    This software contains code derived from the Puppeteer project (https://github.com/puppeteer/puppeteer),
    available under the Apache 2.0 license (https://github.com/puppeteer/puppeteer/blob/master/LICENSE).

The package bundles other npm packages into files under its `lib/`. Their licences are in the package itself, which is used unchanged: `ThirdPartyNotices.txt`, and a `<file>.js.LICENSE` beside each bundled file with the full text of each licence.
