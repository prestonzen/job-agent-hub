import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy /api to the local Worker (`npm run dev:worker`, default port 8787).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
