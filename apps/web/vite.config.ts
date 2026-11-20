import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:4000" },
  },
  // `pnpm --filter @hoosier/web preview` serves the built app (used on the shared dev server).
  preview: {
    host: true,
    port: 4001,
    allowedHosts: true,
    proxy: { "/api": "http://127.0.0.1:4000" },
  },
});
