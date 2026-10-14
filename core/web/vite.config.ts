import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  resolve: {
    // ONNX Runtime's default ES build bundles its WebAssembly as an asset of its own: a second copy of the 14 MB file
    // voice-assets already serves. This build loads it from there, as the one Silero runs on does. Smart Turn's
    // worker is what imports it (src/smart-turn-model.ts).
    conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions],
  },
  build: {
    rollupOptions: {
      output: {
        // Streamdown carries a syntax highlighter and a diagram renderer. They
        // belong in their own chunk because they change far less often than the
        // app does: a deploy that changes only the app leaves this file cached.
        // The chat draws markdown, so the chunk is fetched with the entry, not
        // after it; what loads later are the pages (see App.tsx) and the diagram
        // parts, which come when a diagram does.
        manualChunks: {
          markdown: ["streamdown"],
        },
      },
    },
  },
  plugins: [react(), {
    name: "local-voice-assets",
    configureServer(server) {
      // ORT dynamically imports its runtime. Serve these generated files as
      // static assets in development, just as the production server does.
      const assets = new Set(["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "silero_vad_v5.onnx", "smart-turn-v3.2-cpu.onnx", "vad.worklet.bundle.min.js"]);
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url || "/", "http://localhost").pathname;
        const name = path.slice("/voice-assets/".length);
        if (!path.startsWith("/voice-assets/") || !assets.has(name)) return next();
        res.setHeader("Content-Type", name.endsWith("wasm") ? "application/wasm" : name.endsWith("onnx") ? "application/octet-stream" : "text/javascript");
        const file = createReadStream(resolve(server.config.publicDir, "voice-assets", name));
        file.on("error", () => { res.statusCode = 404; res.end(); });
        file.pipe(res);
      });
    },
  }],
  // The portal's default port. A test run points it at a dead one (PITHAGORAS_API), so that a request no test
  // answered cannot reach a portal that happens to run on this machine.
  server: { port: 5190, proxy: { "/api": process.env.PITHAGORAS_API ?? "http://localhost:4100" } },
});
