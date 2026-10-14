import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { apiProxyBoundaryPlugin, viewerApiProxy } from "./vite-api-proxy";

const viewerRoot = fileURLToPath(new URL(".", import.meta.url));

// The bundled viewer server gates /api/* behind a random HttpOnly session cookie that it only
// sets while serving its own index.html. In dev, Vite serves index.html instead, so scripts/
// dev-viewer.mjs borrows a session up front and hands it over as EXPLORE_DEV_COOKIE; we replay
// it only after validating the original local request's host and origin.
const apiTarget = process.env.EXPLORE_API_ORIGIN ?? "http://127.0.0.1:4319";
const sessionCookie = process.env.EXPLORE_DEV_COOKIE;

export default defineConfig({
  root: viewerRoot,
  plugins: [
    apiProxyBoundaryPlugin(),
    react({
      babel: {
        // React Compiler must run before every other Babel transform. Its default infer mode
        // compiles compatible components incrementally and leaves unsupported code untouched.
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
  ],
  build: {
    outDir: resolve(viewerRoot, "../dist/viewer"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: Number(process.env.EXPLORE_DEV_PORT ?? 5199),
    strictPort: true,
    proxy: {
      "/api": viewerApiProxy({ target: apiTarget, ...(sessionCookie ? { sessionCookie } : {}) }),
    },
  },
});
