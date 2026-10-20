import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";

const BASE_URL = "http://localhost:4173/";

async function waitForServiceWorkerControl(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 });
}

test("the installed app shell opens offline", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  await waitForServiceWorkerControl(page);
  await expect(page.getByTestId("offline-readiness")).toHaveText("Ready to work offline on this device.");

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  await expect(page.getByTestId("network-status")).toHaveText("Offline");
  await expect(page.getByText(/You are offline/)).toBeVisible();

  // Local writes work with no network at all.
  await page.getByLabel("Note text").fill("written with no network");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByTestId("probe-list")).toContainText("written with no network");
});

test("a local record survives closing and reopening the browser (reopened offline)", async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "pps-e2e-"));
  try {
    const first = await chromium.launchPersistentContext(userDataDir, { channel: "msedge", headless: true });
    const page = first.pages()[0] ?? (await first.newPage());
    await page.goto(BASE_URL);
    await waitForServiceWorkerControl(page);
    await page.getByLabel("Note text").fill("survives restart");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByTestId("probe-list")).toContainText("survives restart");
    await first.close();

    const second = await chromium.launchPersistentContext(userDataDir, {
      channel: "msedge",
      headless: true,
      offline: true,
    });
    const reopened = second.pages()[0] ?? (await second.newPage());
    await reopened.goto(BASE_URL);
    await expect(reopened.getByTestId("probe-list")).toContainText("survives restart");
    await expect(reopened.getByText("Not synced yet")).toBeVisible();
    await second.close();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Persian switches the shell to right-to-left and the theme applies, both persisting after reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Language").selectOption("fa");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");
  await expect(page.getByRole("heading", { level: 1, name: "تنظیمات" })).toBeVisible();

  // In RTL the navigation starts from the right edge.
  const nav = page.getByRole("navigation", { name: "اصلی" });
  const firstItem = nav.getByRole("button").first();
  const navBox = (await nav.boundingBox())!;
  const itemBox = (await firstItem.boundingBox())!;
  expect(navBox.x + navBox.width - (itemBox.x + itemBox.width)).toBeLessThan(10);

  await page.getByLabel("پوسته").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(darkBg).toBe("rgb(18, 21, 20)");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { level: 1, name: "خوش آمدید" })).toBeVisible();
});
