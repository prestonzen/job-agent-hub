import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy /api and /mcp to the local Pages Functions (`npm run build && npm run dev:api`, port 8788).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8788", "/mcp": "http://127.0.0.1:8788" },
  },
});
