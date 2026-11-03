import { expect, type Page, test } from "@playwright/test";

// Stage 6 in the installed Edge, on the production build (TESTING "Stage 6 acceptance tests" 11,
// 12, 14, 19): the new screens work offline, the timer and its selection survive a reload, and the
// floating control follows feature detection only. Fabricated data only.
const BASE_PATH = "/personal-productivity-system/";
const BASE_URL = `http://localhost:4173${BASE_PATH}`;

async function waitForServiceWorkerControl(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 });
}

const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("button", { name, exact: true }).click();

test("dashboard, reports, and calendar subcolumns work offline; the app-use date is recorded by viewing", async ({ page, context }) => {
  await page.goto(BASE_URL);
  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  await waitForServiceWorkerControl(page);
  await context.setOffline(true);
  await page.reload();
  await nav(page, "Dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboards" })).toBeVisible();
  await expect(page.getByTestId("dash-card").first()).toHaveAttribute("data-metric", "appUseStreak");
  await expect(page.getByTestId("metric-appUseStreak")).toContainText("1 day");
  await nav(page, "Reports");
  await expect(page.getByTestId("metric-dictionary")).toBeVisible();
  await nav(page, "Settings");
  await page.getByLabel("Time zone").fill("UTC");
  await page.getByLabel("Time zone").blur();
  await nav(page, "Calendar");
  await expect(page.getByTestId("time-grid")).toBeVisible();
  await expect(page.getByTestId("time-grid").getByText("Actual").first()).toBeVisible();
});

test("the stopwatch and the selected timer survive closing and reopening; the floating control follows feature detection", async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  const bar = page.getByTestId("timer-bar");
  await bar.locator("summary").click();
  await bar.getByRole("tab", { name: "Stopwatch" }).click();
  await bar.getByRole("button", { name: "Start" }).click();
  await expect(bar.getByTestId("timer-status")).toHaveText("Running");
  await page.waitForTimeout(1500);
  await page.reload();
  await page.getByTestId("timer-bar").locator("summary").click();
  const after = page.getByTestId("timer-bar");
  await expect(after.getByRole("tab", { name: "Stopwatch" })).toHaveAttribute("aria-selected", "true");
  await expect(after.getByTestId("timer-status")).toHaveText("Running"); // reopening changed nothing
  const supported = await page.evaluate(() => "documentPictureInPicture" in window);
  await expect(after.getByTestId("open-floating")).toHaveCount(supported ? 1 : 0);
});
