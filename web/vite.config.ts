import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5190, proxy: { "/api": "http://localhost:4100" } },
});
