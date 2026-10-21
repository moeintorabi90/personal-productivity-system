import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";

const BASE_URL = "http://localhost:4173/";

async function waitForServiceWorkerControl(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 });
}

/** Fails the test if the app sends anything to the API or to another origin (v1 is offline-only). */
function forbidNetworkUse(page: Page) {
  const offenders: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(BASE_URL).origin || url.pathname.startsWith("/v1")) offenders.push(request.url());
  });
  return offenders;
}

test("the installed app shell opens offline and keeps working", async ({ page, context }) => {
  const offenders = forbidNetworkUse(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  await waitForServiceWorkerControl(page);
  await expect(page.getByTestId("offline-readiness")).toHaveText("Ready to work offline on this device.");
  await expect(page.getByRole("button", { name: "Account & sync" })).toHaveCount(0);
  await expect(page.getByText("Sync check notes")).toHaveCount(0);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  await expect(page.getByTestId("network-status")).toHaveText("Offline");

  // Local writes work with no network at all.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Week starts on").selectOption("1");
  await expect(page.getByLabel("Week starts on")).toHaveValue("1");
  expect(offenders).toEqual([]);
});

test("local data survives closing and reopening the browser (reopened offline)", async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "pps-e2e-"));
  try {
    const first = await chromium.launchPersistentContext(userDataDir, { channel: "msedge", headless: true });
    const page = first.pages()[0] ?? (await first.newPage());
    await page.goto(BASE_URL);
    await waitForServiceWorkerControl(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Time zone").fill("Asia/Tehran");
    await page.getByLabel("Time zone").blur();
    await page.getByLabel("Week starts on").selectOption("0");
    await expect(page.getByLabel("Week starts on")).toHaveValue("0");
    await first.close();

    const second = await chromium.launchPersistentContext(userDataDir, { channel: "msedge", headless: true, offline: true });
    const reopened = second.pages()[0] ?? (await second.newPage());
    await reopened.goto(BASE_URL);
    await reopened.getByRole("button", { name: "Settings" }).click();
    await expect(reopened.getByLabel("Time zone")).toHaveValue("Asia/Tehran");
    await expect(reopened.getByLabel("Week starts on")).toHaveValue("0");
    await second.close();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Persian switches the shell to right-to-left and the theme applies, both persisting after reload", async ({ page }) => {
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

test("backup file flow: export on one device, import into a fresh one, offline, without network use", async ({ browser }) => {
  const source = await browser.newContext({ acceptDownloads: true });
  const a = await source.newPage();
  const offendersA = forbidNetworkUse(a);
  await a.goto("/");
  await a.getByRole("button", { name: "Settings" }).click();
  await a.getByLabel("Week starts on").selectOption("2");
  await a.getByLabel("Calendar display").selectOption("both");
  await source.setOffline(true);
  await a.getByRole("button", { name: "Backup" }).click();
  await expect(a.getByLabel("Protect this file with a password")).not.toBeChecked();
  const downloadPromise = a.waitForEvent("download");
  await a.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^pps-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "pps-backup-")), download.suggestedFilename());
  await download.saveAs(filePath);
  await expect(a.getByTestId("last-backup")).toHaveText("Last backup: today");

  const target = await browser.newContext();
  const b = await target.newPage();
  const offendersB = forbidNetworkUse(b);
  await b.goto("/");
  await target.setOffline(true);
  await b.getByRole("button", { name: "Backup" }).click();
  await b.getByLabel("Choose a backup file").setInputFiles(filePath);
  const preview = b.getByTestId("import-preview");
  await expect(preview).toContainText("Newer versions in the backup: 1");
  await preview.getByLabel(/Apply 1 newer version/).check();
  await preview.getByRole("button", { name: "Import" }).click();
  await expect(b.getByTestId("import-done")).toContainText("Updated: 1");
  await b.getByRole("button", { name: "Settings" }).click();
  await expect(b.getByLabel("Week starts on")).toHaveValue("2");
  await expect(b.getByLabel("Calendar display")).toHaveValue("both");

  // Importing the same file again changes nothing and creates no duplicates.
  await b.getByRole("button", { name: "Backup" }).click();
  await b.getByLabel("Choose a backup file").setInputFiles(filePath);
  await expect(b.getByTestId("import-preview")).toContainText("You already imported this backup");
  await expect(b.getByTestId("import-preview")).toContainText("Already on this device: 1");

  expect([...offendersA, ...offendersB]).toEqual([]);
  rmSync(path.dirname(filePath), { recursive: true, force: true });
  await source.close();
  await target.close();
});
