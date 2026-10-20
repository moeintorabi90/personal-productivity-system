// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppServices, createServices, ServicesProvider } from "./app-context.tsx";
import { App } from "./App.tsx";

let services: AppServices;
let dbCounter = 0;

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
  window.dispatchEvent(new Event(value ? "online" : "offline"));
}

beforeEach(() => {
  setOnline(true);
  localStorage.clear();
  document.documentElement.removeAttribute("dir");
  document.documentElement.removeAttribute("data-theme");
  // Port 9 (discard) is never listening: any accidental API call fails fast as "unreachable".
  services = createServices({ dbName: `app-test-${++dbCounter}`, apiBaseUrl: "http://127.0.0.1:9" });
  render(
    <ServicesProvider services={services}>
      <App />
    </ServicesProvider>,
  );
});

afterEach(async () => {
  cleanup();
  await services.engine.stop();
  services.db.close();
});

describe("app shell", () => {
  it("renders English, left-to-right, by default with accessible navigation", async () => {
    expect(await screen.findByRole("heading", { level: 1, name: "Welcome" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dir).toBe("ltr"));
    expect(document.documentElement.lang).toBe("en");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Home");
    expect(screen.getByTestId("sync-status").textContent).toBe("Not syncing (signed out)");
  });

  it("switches to Persian with right-to-left direction and persists the choice locally", async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "fa" } });

    expect(await screen.findByRole("heading", { level: 1, name: "تنظیمات" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    expect(document.documentElement.lang).toBe("fa");
    expect(screen.getByRole("navigation", { name: "اصلی" })).toBeTruthy();
    expect((await services.db.preferences.get("self"))?.data.language).toBe("fa");
    expect(JSON.parse(localStorage.getItem("pps-shell")!)).toMatchObject({ language: "fa" });

    fireEvent.change(screen.getByLabelText("زبان"), { target: { value: "en" } });
    await waitFor(() => expect(document.documentElement.dir).toBe("ltr"));
  });

  it("applies the chosen theme to the document", async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("system"));
    fireEvent.change(await screen.findByLabelText("Theme"), { target: { value: "dark" } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "light" } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  });

  it("does not silently impose a time zone and rejects invalid ones", async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const input = (await screen.findByLabelText("Time zone")) as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "Not/AZone" } });
    expect(await screen.findByText(/Enter a time zone name/)).toBeTruthy();
    fireEvent.blur(input);
    expect((await services.db.preferences.get("self"))?.data.timeZone ?? null).toBeNull();

    fireEvent.change(input, { target: { value: "Asia/Tehran" } });
    fireEvent.blur(input);
    await waitFor(async () => expect((await services.db.preferences.get("self"))?.data.timeZone).toBe("Asia/Tehran"));
  });

  it("shows the offline state and keeps working locally", async () => {
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    act(() => setOnline(false));
    expect((await screen.findByTestId("network-status")).textContent).toBe("Offline");
    expect(await screen.findByText(/You are offline/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Note text"), { target: { value: "offline note" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText("offline note")).toBeTruthy();
    expect(screen.getByText("Not synced yet")).toBeTruthy();
    expect(await services.db.outbox.count()).toBe(1);

    act(() => setOnline(true));
    expect((await screen.findByTestId("network-status")).textContent).toBe("Online");
  });
});
