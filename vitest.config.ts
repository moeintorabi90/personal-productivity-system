import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { aliases } from "./aliases.ts";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: aliases },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
    // This PC has ~8 GB RAM with little free; run test files one at a time.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
