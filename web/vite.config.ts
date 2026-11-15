import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
      "/install.sh": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/install-hub.sh": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/releases": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
