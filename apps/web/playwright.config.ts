import { defineConfig } from "@playwright/test";

// Uses the installed Microsoft Edge instead of downloading browsers (DECISIONS T-013).
// Runs against the production build served by `vite preview`, where the service worker is active.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://localhost:4173",
    channel: "msedge",
    headless: true,
  },
  webServer: {
    command: "npm run preview:web",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
