import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { aliases } from "../../aliases.ts";

const WEB_ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = path.join(WEB_ROOT, "public");
const API_TARGET = process.env.PPS_API_URL ?? "http://localhost:8787";

function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(full).isDirectory() ? listFiles(full, rel) : [rel];
  });
}

/** Emits sw.js with the exact list of built files and a content-derived cache version (DECISIONS T-008). */
function serviceWorker(): Plugin {
  return {
    name: "pps-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      const built = Object.keys(bundle)
        .filter((file) => !file.endsWith(".map"))
        .sort();
      for (const file of built) {
        const item = bundle[file]!;
        hash.update(file).update(item.type === "chunk" ? item.code : Buffer.from(item.source as string | Uint8Array));
      }
      const publicFiles = listFiles(PUBLIC_DIR).sort();
      for (const file of publicFiles) hash.update(file).update(readFileSync(path.join(PUBLIC_DIR, file)));

      const precache = ["./", ...built, ...publicFiles].map((file) => (file === "./" ? file : `./${file}`));
      const source = readFileSync(path.join(WEB_ROOT, "sw/service-worker.js"), "utf8")
        .replace("__PPS_CACHE_VERSION__", hash.digest("hex").slice(0, 16))
        .replace("__PPS_PRECACHE__", JSON.stringify(precache));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  root: WEB_ROOT,
  base: "./",
  plugins: [react(), serviceWorker()],
  resolve: { alias: aliases },
  build: {
    outDir: path.join(WEB_ROOT, "dist"),
    emptyOutDir: true,
    sourcemap: false,
  },
  // Same-origin API in development and preview: the browser talks to /v1 on the web origin.
  server: { port: 5173, strictPort: true, proxy: { "/v1": API_TARGET } },
  preview: { port: 4173, strictPort: true, proxy: { "/v1": API_TARGET } },
});
