import { defineConfig } from "@playwright/test";

// Uses the installed Microsoft Edge instead of downloading browsers (DECISIONS T-013).
// Runs against the production build served by `vite preview`, where the service worker is active,
// under the same project subpath as on GitHub Pages (apps/web/vite.config.ts, APP_BASE_PATH).
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://localhost:4173/personal-productivity-system/",
    channel: "msedge",
    headless: true,
  },
  webServer: {
    command: "npm run preview:web",
    url: "http://localhost:4173/personal-productivity-system/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
