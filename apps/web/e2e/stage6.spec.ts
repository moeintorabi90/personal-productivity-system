import { expect, type Page, test } from "@playwright/test";

// Stage 6 in the installed Edge, on the production build (TESTING "Stage 6 acceptance tests" 11,
// 12, 14, 19): the new screens work offline, the timer and its selection survive a reload, and the
// floating control follows feature detection only; the floating view follows its own window's size
// (T-238), and the countdown length is set in hours, minutes, and seconds (T-239). Fabricated data only.
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

test("the floating view turns compact when its own window is small and full again when enlarged; both views show the same timer", async ({ page }) => {
  // A real Picture-in-Picture window needs a user's own gesture, so a test window stands in for it:
  // an iframe whose own viewport is resized, while the main window keeps its size.
  await page.addInitScript(() => {
    Object.defineProperty(window, "documentPictureInPicture", {
      configurable: true,
      value: {
        requestWindow: async ({ width, height }: { width: number; height: number }) => {
          const frame = document.createElement("iframe");
          frame.id = "test-floating-window";
          frame.style.cssText = `position:fixed;inset-block-end:0;inset-inline-end:0;width:${width}px;height:${height}px;border:1px solid;z-index:9999`;
          document.body.appendChild(frame);
          return frame.contentWindow;
        },
      },
    });
  });
  await page.goto(BASE_URL);
  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  const mainSize = page.viewportSize();
  const bar = page.getByTestId("timer-bar");
  await bar.locator("summary").click();
  await bar.getByRole("tab", { name: "Stopwatch" }).click();
  await bar.getByTestId("open-floating").click();
  const floating = page.frameLocator("#test-floating-window").getByTestId("timer-view-floating");
  await expect(floating.getByRole("tab")).toHaveCount(3);
  await expect(floating).not.toHaveAttribute("data-compact", "true");

  const resize = (width: number, height: number) =>
    page.evaluate(([w, h]) => Object.assign(document.getElementById("test-floating-window")!.style, { width: `${w}px`, height: `${h}px` }), [width, height]);
  await resize(220, 120);
  await expect(floating).toHaveAttribute("data-compact", "true");
  await expect(floating.getByRole("tab")).toHaveCount(0);
  await expect(floating.getByRole("button")).toHaveText(["Start"]);
  await expect(bar.getByTestId("timer-view").getByRole("tab")).toHaveCount(3); // the main window keeps its full view
  expect(page.viewportSize()).toEqual(mainSize);

  await floating.getByRole("button", { name: "Start" }).click();
  await expect(floating.getByRole("button")).toHaveText(["Pause"]);
  await expect(bar.getByTestId("timer-status")).toHaveText("Running");
  await page.waitForTimeout(1200);
  await floating.getByRole("button", { name: "Pause" }).click();
  await expect(floating.getByRole("button")).toHaveText(["Resume"]);
  await expect(bar.getByTestId("timer-status")).toHaveText("Paused");
  const shown = await floating.getByTestId("timer-value").textContent();
  await expect(bar.getByTestId("timer-value")).toHaveText(shown!); // the same time in both views

  await resize(340, 300);
  await expect(floating).not.toHaveAttribute("data-compact", "true");
  await expect(floating.getByRole("tab", { name: "Stopwatch" })).toHaveAttribute("aria-selected", "true");
  await expect(floating.getByRole("button", { name: "Reset" })).toBeVisible();
  await expect(floating.getByTestId("timer-value")).toHaveText(shown!); // resizing changed neither timer nor selection

  // The countdown length in hours, minutes, and seconds.
  await bar.getByRole("tab", { name: "Countdown" }).click();
  await bar.getByLabel("Hours").fill("1");
  await bar.getByLabel("Minutes").fill("30");
  await bar.getByLabel("Seconds").fill("45");
  await bar.getByRole("button", { name: "Start" }).click();
  await expect(bar.getByTestId("timer-value")).toHaveText(/^1:30:4\d$/);
  await bar.getByRole("button", { name: "Pause" }).click();
  await expect(bar.getByTestId("timer-status")).toHaveText("Paused");
  await expect(floating.getByTestId("timer-status")).toHaveText("Paused");
  await expect(floating.getByTestId("timer-value")).toHaveText((await bar.getByTestId("timer-value").textContent())!);
});
