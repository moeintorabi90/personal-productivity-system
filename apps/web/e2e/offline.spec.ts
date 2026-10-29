import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";

// Same project subpath as the GitHub Pages site (apps/web/vite.config.ts, APP_BASE_PATH).
const BASE_PATH = "/personal-productivity-system/";
const BASE_URL = `http://localhost:4173${BASE_PATH}`;

async function waitForServiceWorkerControl(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 });
}

/**
 * Fails the test if the app sends anything to the API or to another origin (v1 is offline-only),
 * or requests a same-origin file outside the app's subpath (it would 404 on GitHub Pages).
 */
function forbidNetworkUse(page: Page) {
  const offenders: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(BASE_URL).origin || !url.pathname.startsWith(BASE_PATH)) offenders.push(request.url());
  });
  return offenders;
}

test("the app works under the GitHub Pages subpath: worker scope, manifest, and icons", async ({ page }) => {
  const offenders = forbidNetworkUse(page);
  await page.goto(BASE_URL);
  await waitForServiceWorkerControl(page);
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return { scope: registration?.scope, script: registration?.active?.scriptURL };
  });
  expect(worker).toEqual({ scope: BASE_URL, script: `${BASE_URL}sw.js` });

  const manifestHref = await page.locator('link[rel="manifest"]').evaluate((link: HTMLLinkElement) => link.href);
  expect(manifestHref).toBe(`${BASE_URL}manifest.webmanifest`);
  const manifest = await (await page.request.get(manifestHref)).json();
  for (const key of ["id", "start_url", "scope"]) expect(new URL(manifest[key], manifestHref).href).toBe(BASE_URL);
  for (const icon of manifest.icons) {
    const response = await page.request.get(new URL(icon.src, manifestHref).href);
    expect(response.status(), icon.src).toBe(200);
  }
  expect(offenders).toEqual([]);
});

test("the installed app shell opens offline and keeps working", async ({ page, context }) => {
  const offenders = forbidNetworkUse(page);
  await page.goto(BASE_URL);
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
  await page.goto(BASE_URL);
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
  await a.goto(BASE_URL);
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
  await b.goto(BASE_URL);
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

test("Stage 3 offline: zone, capacity, recurring task, scheduling, quick add, reload, and the same plan on a fresh device", async ({ browser }) => {
  const source = await browser.newContext({ acceptDownloads: true });
  const a = await source.newPage();
  const offendersA = forbidNetworkUse(a);
  await a.goto(BASE_URL);
  await waitForServiceWorkerControl(a);
  await source.setOffline(true);

  await a.getByRole("button", { name: "Settings" }).click();
  await expect(a.getByTestId("zone-change-note")).toContainText("may change the displayed time or date");
  await a.getByLabel("Time zone").fill("Asia/Tehran");
  await a.getByLabel("Time zone").blur();
  await a.getByLabel("Daily capacity (minutes)").fill("30");
  await a.getByLabel("Daily capacity (minutes)").blur();

  // A task that repeats every day, so today always has an occurrence whatever the test date.
  await a.getByRole("button", { name: "Inbox" }).click();
  await a.getByLabel("Capture a task or idea").fill("Gym");
  await a.getByRole("button", { name: "Add to inbox" }).click();
  await a.getByRole("button", { name: "Edit task: Gym" }).click();
  await a.getByLabel("Estimate (minutes)").fill("45");
  await a.getByLabel("Repeats every week on selected days").check();
  for (const day of ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) await a.getByLabel(day, { exact: true }).check();
  await a.getByRole("button", { name: "Save" }).click();
  await expect(a.getByText(/^Repeats: /)).toBeVisible();

  await a.getByRole("button", { name: "Today", exact: true }).click();
  const today = a.getByTestId("day-panel");
  await expect(today.getByTestId("unscheduled-row")).toContainText("Gym");
  await today.getByRole("button", { name: "Schedule: Gym" }).click();
  const form = a.getByRole("form", { name: "Schedule: Gym" });
  await expect(form.getByLabel("Start time")).toHaveValue("");
  await expect(form.getByLabel("Duration (minutes)")).toHaveValue("45");
  await form.getByLabel("Start time").fill("08:00");
  await expect(form.getByTestId("form-capacity-warning")).toBeVisible();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(today.getByTestId("block-row")).toContainText("08:00");
  await expect(today.getByTestId("unscheduled-row")).toHaveCount(0);
  await expect(today.getByTestId("capacity")).toHaveAttribute("data-capacity", "warning");

  await today.getByRole("button", { name: "Add a planned block" }).click();
  const quick = a.getByRole("form", { name: "New planned block" });
  await quick.getByLabel("Title of the new task").fill("Call the bank");
  await quick.getByLabel("Start time").fill("12:00");
  await quick.getByLabel("Duration (minutes)").fill("15");
  await quick.getByRole("button", { name: "Save" }).click();
  await expect(today.getByTestId("block-row")).toHaveCount(2);

  await a.reload();
  await a.getByRole("button", { name: "Today", exact: true }).click();
  await expect(a.getByTestId("day-panel").getByTestId("block-row")).toHaveCount(2);

  await a.getByRole("button", { name: "Backup" }).click();
  const downloadPromise = a.waitForEvent("download");
  await a.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "pps-backup-")), download.suggestedFilename());
  await download.saveAs(filePath);

  const target = await browser.newContext();
  const b = await target.newPage();
  const offendersB = forbidNetworkUse(b);
  await b.goto(BASE_URL);
  await target.setOffline(true);
  await b.getByRole("button", { name: "Backup" }).click();
  await b.getByLabel("Choose a backup file").setInputFiles(filePath);
  const preview = b.getByTestId("import-preview");
  await expect(preview).toContainText("New items to add: 4"); // 2 tasks, 2 blocks
  await preview.getByLabel(/Apply 1 newer version/).check(); // zone and capacity
  await preview.getByRole("button", { name: "Import" }).click();
  await expect(b.getByTestId("import-done")).toContainText("Added: 4");
  await b.getByRole("button", { name: "Today", exact: true }).click();
  const todayB = b.getByTestId("day-panel");
  await expect(todayB.getByTestId("block-row")).toHaveCount(2);
  await expect(todayB.getByTestId("block-row").first()).toContainText("08:00");
  await expect(todayB.getByTestId("capacity")).toHaveAttribute("data-capacity", "warning");

  expect([...offendersA, ...offendersB]).toEqual([]);
  rmSync(path.dirname(filePath), { recursive: true, force: true });
  await source.close();
  await target.close();
});

test("Stage 3 in Persian with the Jalali display: month view and navigation are usable right-to-left", async ({ page }) => {
  const offenders = forbidNetworkUse(page);
  await page.goto(BASE_URL);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Time zone").fill("Asia/Tehran");
  await page.getByLabel("Time zone").blur();
  await page.getByLabel("Calendar display").selectOption("jalali");
  await page.getByLabel("Language").selectOption("fa");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "تقویم" }).click();
  await page.getByLabel("نما", { exact: true }).selectOption("month");
  const month = page.getByTestId("month-view");
  const heading = await month.getByRole("heading", { level: 2 }).textContent();
  // A Jalali month name and a 29–31 day Jalali month.
  expect(heading).toMatch(/فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند/);
  const cells = await month.locator(".month-cell").count();
  expect(cells).toBeGreaterThanOrEqual(29);
  expect(cells).toBeLessThanOrEqual(31);
  await page.getByRole("group", { name: "جابه‌جایی در تقویم" }).getByRole("button", { name: "بعدی" }).click();
  await expect(month.getByRole("heading", { level: 2 })).not.toHaveText(heading!);
  // Jalali date entry: 1 Farvardin 1406 is Sunday 21 March 2027.
  const goTo = page.getByRole("group", { name: "رفتن به تاریخ" });
  await goTo.getByLabel("سال").fill("1406");
  await goTo.getByLabel("ماه").fill("1");
  await goTo.getByLabel("روز").fill("1");
  await page.getByRole("button", { name: "برو" }).click();
  await expect(month.locator(".month-cell").first()).toHaveAttribute("data-date", "2027-03-21");
  await page.getByLabel("نما", { exact: true }).selectOption("day");
  await page.getByLabel("چیدمان", { exact: true }).selectOption("list"); // the list layout stays (follow-up)
  await expect(page.getByTestId("day-panel")).toContainText("یکشنبه");
  expect(offenders).toEqual([]);
});

test("Stage 2 offline: capture, organize into a project and workstream, and carry it to a fresh device by backup", async ({ browser }) => {
  const source = await browser.newContext({ acceptDownloads: true });
  const a = await source.newPage();
  const offendersA = forbidNetworkUse(a);
  await a.goto(BASE_URL);
  await waitForServiceWorkerControl(a);
  await source.setOffline(true);

  await a.getByRole("button", { name: "Projects" }).click();
  await a.getByLabel("Name", { exact: true }).fill("Thesis");
  await a.getByRole("button", { name: "Create project" }).click();
  await expect(a.getByRole("heading", { level: 1, name: "Thesis" })).toBeVisible();
  await a.getByLabel("Workstream name").fill("Writing");
  await a.getByRole("button", { name: "Add workstream" }).click();
  await expect(a.getByLabel("New task in Writing")).toBeVisible();

  await a.getByRole("button", { name: "Inbox" }).click();
  await a.getByLabel("Capture a task or idea").fill("Draft chapter 2");
  await a.getByRole("button", { name: "Add to inbox" }).click();
  await a.getByRole("button", { name: "Edit task: Draft chapter 2" }).click();
  await a.getByLabel("Project").selectOption({ label: "Thesis" });
  await a.getByLabel("Workstream").selectOption({ label: "Writing" });
  await a.getByRole("button", { name: "Save" }).click();
  await expect(a.getByText("The inbox is empty.")).toBeVisible();

  // Survives a reload while offline (served by the service worker, data in IndexedDB).
  await a.reload();
  await a.getByRole("button", { name: "Projects" }).click();
  await a.getByRole("button", { name: "Open project: Thesis" }).click();
  await expect(a.getByTestId("workstream")).toContainText("Draft chapter 2");

  await a.getByRole("button", { name: "Backup" }).click();
  const downloadPromise = a.waitForEvent("download");
  await a.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "pps-backup-")), download.suggestedFilename());
  await download.saveAs(filePath);

  const target = await browser.newContext();
  const b = await target.newPage();
  const offendersB = forbidNetworkUse(b);
  await b.goto(BASE_URL);
  await target.setOffline(true);
  await b.getByRole("button", { name: "Backup" }).click();
  await b.getByLabel("Choose a backup file").setInputFiles(filePath);
  await expect(b.getByTestId("import-preview")).toContainText("New items to add: 3");
  await b.getByTestId("import-preview").getByRole("button", { name: "Import" }).click();
  await expect(b.getByTestId("import-done")).toContainText("Added: 3");
  await b.getByRole("button", { name: "Projects" }).click();
  await b.getByRole("button", { name: "Open project: Thesis" }).click();
  await expect(b.getByTestId("workstream")).toContainText("Writing");
  await expect(b.getByTestId("workstream")).toContainText("Draft chapter 2");

  expect([...offendersA, ...offendersB]).toEqual([]);
  rmSync(path.dirname(filePath), { recursive: true, force: true });
  await source.close();
  await target.close();
});

test("Stage 4 offline: a goal with milestones, status changes, reload, and the same goal on a fresh device by backup", async ({ browser }) => {
  const source = await browser.newContext({ acceptDownloads: true });
  const a = await source.newPage();
  const offendersA = forbidNetworkUse(a);
  await a.goto(BASE_URL);
  await waitForServiceWorkerControl(a);
  await source.setOffline(true);

  await a.getByRole("button", { name: "Goals" }).click();
  await a.getByLabel("Name", { exact: true }).fill("Write the book");
  await a.getByLabel("Target (whole number)").fill("300");
  await a.getByLabel("Name of the output definition").fill("Pages written"); // Stage 5: output goals track a definition (T-151)
  await a.getByLabel("Unit (for example pages or words)").fill("pages");
  await a.getByLabel("Start date").fill("2026-11-01");
  await a.getByLabel("Deadline (optional)").fill("2026-12-31");
  await a.getByRole("button", { name: "Create goal" }).click();
  await expect(a.getByRole("heading", { level: 1, name: /Write the book/ })).toBeVisible();
  await expect(a.getByText(/Progress is calculated from recorded work sessions/)).toBeVisible();

  const milestones = a.getByTestId("milestones");
  await milestones.getByLabel("Milestone name").fill("First draft");
  await milestones.getByLabel("Deadline (optional)").fill("2026-11-30");
  await milestones.getByRole("button", { name: "Add milestone" }).click();
  await milestones.getByRole("button", { name: "Mark milestone complete: First draft" }).click();
  await expect(milestones.getByRole("button", { name: "Mark milestone incomplete: First draft" })).toBeVisible();
  await a.getByRole("button", { name: "Pause" }).click();
  await expect(a.getByRole("button", { name: "Resume" })).toBeVisible();

  // Survives a reload while offline (served by the service worker, data in IndexedDB).
  await a.reload();
  await a.getByRole("button", { name: "Goals" }).click();
  await a.getByRole("button", { name: "Open goal: Write the book" }).click();
  await expect(a.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(a.getByTestId("milestones")).toContainText("First draft");

  await a.getByRole("button", { name: "Backup" }).click();
  const downloadPromise = a.waitForEvent("download");
  await a.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "pps-backup-")), download.suggestedFilename());
  await download.saveAs(filePath);

  const target = await browser.newContext();
  const b = await target.newPage();
  const offendersB = forbidNetworkUse(b);
  await b.goto(BASE_URL);
  await target.setOffline(true);
  await b.getByRole("button", { name: "Backup" }).click();
  await b.getByLabel("Choose a backup file").setInputFiles(filePath);
  await expect(b.getByTestId("import-preview")).toContainText("New items to add: 3"); // goal, milestone, output definition
  await b.getByTestId("import-preview").getByRole("button", { name: "Import" }).click();
  await expect(b.getByTestId("import-done")).toContainText("Added: 3");
  await b.getByRole("button", { name: "Goals" }).click();
  await b.getByRole("button", { name: "Open goal: Write the book" }).click();
  await expect(b.getByRole("button", { name: "Resume" })).toBeVisible(); // still paused
  await expect(b.getByTestId("milestones")).toContainText("First draft");
  await expect(b.getByTestId("milestones").getByText("Completed")).toBeVisible();

  expect([...offendersA, ...offendersB]).toEqual([]);
  rmSync(path.dirname(filePath), { recursive: true, force: true });
  await source.close();
  await target.close();
});

/** Today's local date in a zone (the app shows the current week). */
function todayIn(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Page coordinates of a wall time in a grid column (24 hours over the column's height). */
async function slot(column: import("@playwright/test").Locator, hours: number, minutes = 0) {
  const box = (await column.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + ((hours * 60 + minutes) / 1440) * box.height };
}

async function setTehran(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Time zone").fill("Asia/Tehran");
  await page.getByLabel("Time zone").blur();
  await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Tehran");
}

test("Stage 3 follow-up offline: project color, tap to plan, drag-move and resize with 15-minute snapping, Undo, and the color on a fresh device", async ({ browser }) => {
  test.setTimeout(90_000);
  const source = await browser.newContext({ acceptDownloads: true });
  const a = await source.newPage();
  const offendersA = forbidNetworkUse(a);
  await a.goto(BASE_URL);
  await waitForServiceWorkerControl(a);
  await source.setOffline(true);
  await setTehran(a);

  await a.getByRole("button", { name: "Projects" }).click();
  await a.getByLabel("Name", { exact: true }).fill("Thesis");
  await a.getByLabel("Color").selectOption("purple");
  await a.getByRole("button", { name: "Create project" }).click();
  await expect(a.getByTestId("project-color")).toContainText("Color: Purple");
  await a.getByLabel("New task in Thesis").fill("Write");
  await a.getByTestId("direct-tasks").getByRole("button", { name: "Add task" }).click();
  await expect(a.getByTestId("direct-tasks")).toContainText("Write");

  await a.getByRole("button", { name: "Calendar" }).click();
  await a.getByLabel("View", { exact: true }).selectOption("day");
  await expect(a.getByLabel("Layout")).toHaveValue("grid");
  const column = a.getByTestId("grid-column");
  await expect(column).toHaveAttribute("data-date", todayIn("Asia/Tehran"));
  await a.getByTestId("time-grid").locator(".tg-scroll").scrollIntoViewIfNeeded();

  // A click at 09:07 pre-fills 09:00 for 30 minutes; nothing is written until Save.
  let p = await slot(column, 9, 7);
  await a.mouse.click(p.x, p.y);
  const form = a.getByRole("form", { name: "New planned block" });
  await expect(form.getByLabel("Start time")).toHaveValue("09:00");
  await expect(form.getByLabel("Duration (minutes)")).toHaveValue("30");
  await form.getByLabel("Task", { exact: true }).selectOption({ label: "Write" });
  await form.getByRole("button", { name: "Save" }).click();
  const block = a.getByTestId("grid-block");
  await expect(block).toContainText("09:00–09:30");
  await expect(block).toHaveAttribute("data-color", "purple");
  await expect(block).toContainText("Planned");

  // Drag-move by 1 h 17 min: 10:17 snaps to 10:15. Undo appears, with no dialog, and leaves after 5 s.
  p = await slot(column, 9, 15);
  let q = await slot(column, 10, 32);
  await a.mouse.move(p.x, p.y);
  await a.mouse.down();
  await a.mouse.move(p.x, p.y + 10, { steps: 3 });
  await a.mouse.move(q.x, q.y, { steps: 8 });
  await a.mouse.up();
  await expect(block).toContainText("10:15–10:45");
  await expect(a.getByTestId("undo-bar")).toBeVisible();
  await expect(a.getByRole("dialog")).toHaveCount(0);
  await expect(a.getByTestId("undo-bar")).toBeHidden({ timeout: 8_000 });
  await expect(block).toContainText("10:15–10:45");

  // Resize the end edge from 10:45 to 11:37 → 11:30. While Undo has focus it stays past 5 s; Undo restores 10:45.
  p = await slot(column, 10, 44);
  q = await slot(column, 11, 37);
  await a.mouse.move(p.x, p.y);
  await a.mouse.down();
  await a.mouse.move(q.x, q.y, { steps: 8 });
  await a.mouse.up();
  await expect(block).toContainText("10:15–11:30");
  const undo = a.getByTestId("undo-bar").getByRole("button", { name: "Undo" });
  await undo.focus();
  await a.waitForTimeout(6_000);
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(block).toContainText("10:15–10:45");
  await expect(a.getByTestId("undo-bar")).toBeHidden();

  // The color travels in the backup (data version 5).
  await a.getByRole("button", { name: "Backup" }).click();
  const downloadPromise = a.waitForEvent("download");
  await a.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "pps-backup-")), download.suggestedFilename());
  await download.saveAs(filePath);

  const target = await browser.newContext();
  const b = await target.newPage();
  const offendersB = forbidNetworkUse(b);
  await b.goto(BASE_URL);
  await target.setOffline(true);
  await b.getByRole("button", { name: "Backup" }).click();
  await b.getByLabel("Choose a backup file").setInputFiles(filePath);
  await b.getByTestId("import-preview").getByRole("button", { name: "Import" }).click();
  await expect(b.getByTestId("import-done")).toBeVisible();
  await b.getByRole("button", { name: "Projects" }).click();
  await b.getByRole("button", { name: "Open project: Thesis" }).click();
  await expect(b.getByTestId("project-color")).toContainText("Color: Purple");

  expect([...offendersA, ...offendersB]).toEqual([]);
  rmSync(path.dirname(filePath), { recursive: true, force: true });
  await source.close();
  await target.close();
});

test("Stage 3 follow-up on a phone-sized touch screen: two days at a time, Previous/Next reach the whole week, and a tap pre-fills 30 minutes", async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 375, height: 800 }, hasTouch: true, isMobile: true });
  const page = await phone.newPage();
  const offenders = forbidNetworkUse(page);
  await page.goto(BASE_URL);
  await waitForServiceWorkerControl(page);
  await phone.setOffline(true);
  await setTehran(page);
  await page.getByRole("button", { name: "Calendar" }).click();
  const columns = page.getByTestId("grid-column");
  await expect(columns).toHaveCount(2);
  const seen = new Set<string>();
  const collect = async () => {
    for (const date of await columns.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.date!))) seen.add(date);
  };
  await collect();
  const previous = page.getByRole("button", { name: "Previous days" });
  const next = page.getByRole("button", { name: "Next days" });
  while (await previous.isEnabled()) {
    await previous.click();
    await collect();
  }
  while (await next.isEnabled()) {
    await next.click();
    await collect();
  }
  expect(seen.size).toBe(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByTestId("time-grid").locator(".tg-scroll").scrollIntoViewIfNeeded();
  const p = await slot(columns.first(), 9, 40);
  await page.touchscreen.tap(p.x, p.y);
  const form = page.getByRole("form", { name: "New planned block" });
  await expect(form.getByLabel("Start time")).toHaveValue("09:30");
  await expect(form.getByLabel("Duration (minutes)")).toHaveValue("30");
  expect(offenders).toEqual([]);
  await phone.close();
});

test("Stage 5 offline: a session with a pause and an output, a past session, reload, and an open session moved to a fresh device by backup arrives paused", async ({ browser }) => {
  const source = await browser.newContext({ acceptDownloads: true });
  const a = await source.newPage();
  const offendersA = forbidNetworkUse(a);
  await a.goto(BASE_URL);
  await waitForServiceWorkerControl(a);
  await source.setOffline(true);
  await setTehran(a);

  await a.getByRole("button", { name: "Work", exact: true }).click();
  const definitions = a.getByTestId("definitions");
  await definitions.getByLabel("Name", { exact: true }).fill("Content covered");
  await definitions.getByLabel("Unit", { exact: true }).fill("minutes");
  await definitions.getByRole("button", { name: "Add definition" }).click();
  await expect(definitions).toContainText("Content covered (minutes)");

  // A live session: start, pause, resume, end with an output of 15 and an energy rating.
  await a.getByRole("button", { name: "Start", exact: true }).click();
  const current = a.getByTestId("current-session");
  await current.getByRole("button", { name: "Pause" }).click();
  await current.getByRole("button", { name: "Resume" }).click();
  await current.getByRole("button", { name: "End…" }).click();
  const end = a.getByTestId("end-form");
  await end.getByRole("button", { name: "Add an output" }).click();
  await end.getByTestId("output-row").getByLabel("Output definition").selectOption({ label: "Content covered (minutes)" });
  await end.getByTestId("output-row").getByLabel("Amount").fill("15");
  await end.getByLabel("Energy (1–5)").selectOption("4");
  await end.getByRole("button", { name: "End session" }).click();
  const history = a.getByTestId("session-history");
  await expect(history).toContainText("15 minutes · Content covered");
  await expect(history).toContainText("energy 4/5");

  // A past session: yesterday, start plus duration.
  const today = todayIn("Asia/Tehran");
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 24 * 3600 * 1000).toISOString().slice(0, 10);
  await a.getByRole("button", { name: "Record a past session…" }).click();
  const past = a.getByTestId("past-form");
  await past.getByLabel("Date").fill(yesterday);
  await past.getByLabel("Start time").fill("08:00");
  await past.getByLabel("Duration (minutes)").fill("45");
  await past.getByRole("button", { name: "Save" }).click();
  await expect(history.getByTestId("session-row")).toHaveCount(2);
  await expect(history).toContainText("45 min");

  // Survives a reload while offline.
  await a.reload();
  await a.getByRole("button", { name: "Work", exact: true }).click();
  await expect(a.getByTestId("session-history").getByTestId("session-row")).toHaveCount(2);

  // An open session travels in the backup.
  await a.getByRole("button", { name: "Start", exact: true }).click();
  await expect(a.getByTestId("current-session")).toContainText("Running");
  await a.getByRole("button", { name: "Backup" }).click();
  const downloadPromise = a.waitForEvent("download");
  await a.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "pps-backup-")), download.suggestedFilename());
  await download.saveAs(filePath);

  const target = await browser.newContext();
  const b = await target.newPage();
  const offendersB = forbidNetworkUse(b);
  await b.goto(BASE_URL);
  await target.setOffline(true);
  await b.getByRole("button", { name: "Backup" }).click();
  await b.getByLabel("Choose a backup file").setInputFiles(filePath);
  const preview = b.getByTestId("import-preview");
  await preview.getByLabel(/Apply 1 newer version/).check(); // the shared time zone
  await preview.getByRole("button", { name: "Import" }).click();
  await expect(b.getByTestId("import-done")).toBeVisible();
  await b.getByRole("button", { name: "Work", exact: true }).click();
  await expect(b.getByTestId("session-history").getByTestId("session-row")).toHaveCount(2);
  await expect(b.getByTestId("session-history")).toContainText("15 minutes · Content covered");
  // Restored as paused on this device: its timer does not continue (T-144, T-152).
  await expect(b.getByTestId("open-session")).toHaveAttribute("data-state", "paused");
  await expect(b.getByTestId("current-session")).toContainText("Paused (from a backup)");

  expect([...offendersA, ...offendersB]).toEqual([]);
  rmSync(path.dirname(filePath), { recursive: true, force: true });
  await source.close();
  await target.close();
});
