// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppServices, createServices, ServicesProvider } from "./app-context.tsx";
import { App } from "./App.tsx";
import { createBackup } from "./backup/export.ts";
import { PRODUCT_REGISTRY } from "./backup/registry.ts";
import { LocalDb } from "./local/db.ts";
import { getDeviceSettings } from "./local/records.ts";
import { getSharedPreferences, updateSharedPreferences } from "./local/settings.ts";

// jsdom's `crypto` lacks SubtleCrypto; use Node's Web Crypto (same API as browsers).
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

let services: AppServices;
let dbCounter = 0;
let fetchSpy: ReturnType<typeof vi.fn>;
let downloads: { name: string; blob: Blob }[];

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
  window.dispatchEvent(new Event(value ? "online" : "offline"));
}

function renderApp(options: { syncEnabled?: boolean } = {}) {
  services = createServices({ dbName: `app-test-${++dbCounter}`, apiBaseUrl: "http://127.0.0.1:9", ...options });
  render(
    <ServicesProvider services={services}>
      <App />
    </ServicesProvider>,
  );
}

beforeEach(() => {
  setOnline(true);
  localStorage.clear();
  document.documentElement.removeAttribute("dir");
  document.documentElement.removeAttribute("data-theme");
  // Any network use by v1 would show up here (docs/TESTING.md item 18).
  fetchSpy = vi.fn(async () => {
    throw new TypeError("network disabled in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
  downloads = [];
  const blobs = new Map<string, Blob>();
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.href)! });
  });
});

afterEach(async () => {
  cleanup();
  await services.engine.stop();
  services.db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function goTo(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

describe("v1 app shell (sync frozen and hidden, D-016)", () => {
  it("renders English LTR with Home, Settings, Backup only; no sync UI; engine not started", async () => {
    const start = vi.spyOn((await import("./sync/sync-engine.ts")).SyncEngine.prototype, "start");
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Welcome" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dir).toBe("ltr"));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Home", "Settings", "Backup"]);
    expect(screen.queryByTestId("sync-status")).toBeNull();
    expect(screen.queryByText("Sync check notes")).toBeNull();
    expect((await screen.findByTestId("last-backup")).textContent).toBe("No backup yet");
    expect(screen.getByTestId("install-guide").textContent).toContain("Add to Home Screen");
    expect(start).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the frozen sync screens appear only when the build flag is on", async () => {
    renderApp({ syncEnabled: true });
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    expect(screen.getByRole("button", { name: "Account & sync" })).toBeTruthy();
    expect(await screen.findByText("Sync check notes")).toBeTruthy();
  });

  it("switches to Persian (RTL); language is a device setting, not a shared preference", async () => {
    renderApp();
    await goTo("Settings");
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "fa" } });
    expect(await screen.findByRole("heading", { level: 1, name: "تنظیمات" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    expect(screen.getByRole("navigation", { name: "اصلی" })).toBeTruthy();
    expect((await getDeviceSettings(services.db)).language).toBe("fa");
    expect(await getSharedPreferences(services.db)).not.toHaveProperty("language");
    fireEvent.change(screen.getByLabelText("زبان"), { target: { value: "en" } });
    await waitFor(() => expect(document.documentElement.dir).toBe("ltr"));
  });

  it("applies the chosen theme to the document", async () => {
    renderApp();
    await goTo("Settings");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("system"));
    fireEvent.change(await screen.findByLabelText("Theme"), { target: { value: "dark" } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect((await getDeviceSettings(services.db)).theme).toBe("dark");
  });

  it("does not silently impose a time zone; a valid one is saved as a shared preference", async () => {
    renderApp();
    await goTo("Settings");
    const input = (await screen.findByLabelText("Time zone")) as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "Not/AZone" } });
    expect(await screen.findByText(/Enter a time zone name/)).toBeTruthy();
    fireEvent.blur(input);
    expect((await getSharedPreferences(services.db)).timeZone).toBeNull();
    fireEvent.change(input, { target: { value: "Asia/Tehran" } });
    fireEvent.blur(input);
    await waitFor(async () => expect((await getSharedPreferences(services.db)).timeZone).toBe("Asia/Tehran"));
  });

  it("shows the offline state and keeps working locally", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    act(() => setOnline(false));
    expect((await screen.findByTestId("network-status")).textContent).toBe("Offline");
    expect(await screen.findByText(/Everything keeps working/)).toBeTruthy();
    await goTo("Settings");
    fireEvent.change(await screen.findByLabelText("Week starts on"), { target: { value: "1" } });
    await waitFor(async () => expect((await getSharedPreferences(services.db)).weekStart).toBe(1));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Backup screen (D-014, D-015, D-017)", () => {
  it("password protection is visible, off by default, needs two matching entries, and shows the warnings", async () => {
    renderApp();
    await goTo("Backup");
    const protect = (await screen.findByLabelText("Protect this file with a password")) as HTMLInputElement;
    expect(protect.checked).toBe(false);
    const exportButton = screen.getByRole("button", { name: "Export backup" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);

    fireEvent.click(protect);
    const warning = await screen.findByTestId("password-warning");
    expect(warning.textContent).toContain("can never be restored");
    expect(warning.textContent).toContain("password manager");
    expect(exportButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "first" } });
    fireEvent.change(screen.getByLabelText("Repeat the password"), { target: { value: "second" } });
    expect(await screen.findByText("The passwords do not match.")).toBeTruthy();
    expect(exportButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Repeat the password"), { target: { value: "first" } });
    await waitFor(() => expect(exportButton.disabled).toBe(false));

    fireEvent.click(exportButton);
    await waitFor(() => expect(screen.getByTestId("export-message").textContent).toMatch(/was created and checked/), {
      timeout: 20_000,
    });
    expect(downloads).toHaveLength(1);
    const file = JSON.parse(await downloads[0]!.blob.text());
    expect(file.encryption.keySlots).toHaveLength(1);
    expect(downloads[0]!.name).toMatch(/^pps-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    // The next export starts unprotected again; the indicator shows today's backup.
    expect((screen.getByLabelText("Protect this file with a password") as HTMLInputElement).checked).toBe(false);
    expect((await screen.findByTestId("last-backup")).textContent).toBe("Last backup: today");
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("import shows a preview; newer shared preferences apply only after confirmation; display settings never change by default", async () => {
    const other = new LocalDb(`other-${++dbCounter}`);
    await other.meta.put({ key: "device", value: { id: crypto.randomUUID(), name: "Phone" } });
    await updateSharedPreferences(other, { weekStart: 1 });
    await other.meta.put({ key: "deviceSettings", value: { language: "fa", theme: "dark" } });
    const backup = await createBackup(other, PRODUCT_REGISTRY);
    other.close();

    renderApp();
    await goTo("Backup");
    const input = (await screen.findByLabelText("Choose a backup file")) as HTMLInputElement;
    const pick = () => fireEvent.change(input, { target: { files: [new File([backup.text], backup.fileName, { type: "application/json" })] } });

    pick();
    const preview = await screen.findByTestId("import-preview");
    expect(preview.textContent).toContain("Newer versions in the backup: 1");
    const updates = within(preview).getByLabelText(/Apply 1 newer version/) as HTMLInputElement;
    const display = within(preview).getByLabelText(/Use the display settings of Phone/) as HTMLInputElement;
    expect(updates.checked).toBe(false);
    expect(display.checked).toBe(false);
    fireEvent.click(within(preview).getByRole("button", { name: "Import" }));
    expect((await screen.findByTestId("import-done")).textContent).toContain("Updated: 0");
    expect((await getSharedPreferences(services.db)).weekStart).toBe(6);
    expect(await getDeviceSettings(services.db)).toEqual({ language: "en", theme: "system" });

    pick();
    const second = await screen.findByTestId("import-preview");
    expect(second.textContent).toContain("You already imported this backup");
    fireEvent.click(within(second).getByLabelText(/Apply 1 newer version/));
    fireEvent.click(within(second).getByRole("button", { name: "Import" }));
    expect((await screen.findByTestId("import-done")).textContent).toContain("Updated: 1");
    expect((await getSharedPreferences(services.db)).weekStart).toBe(1);
    expect(await getDeviceSettings(services.db)).toEqual({ language: "en", theme: "system" });
    // The replaced version is listed for undo.
    expect(await screen.findByTestId("replaced-versions")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a refused file shows an error and changes nothing", async () => {
    renderApp();
    await goTo("Backup");
    const input = (await screen.findByLabelText("Choose a backup file")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['{"format":"pps-backup"'], "broken.json")] } });
    const error = await screen.findByTestId("import-error");
    expect(error.textContent).toContain("damaged");
    expect(error.textContent).toContain("Nothing on this device was changed");
    expect(await services.db.importLog.count()).toBe(0);
  });

  it("conflicts are shown side by side; bulk 'keep this device' asks for confirmation with the count", async () => {
    renderApp();
    await goTo("Backup");
    await screen.findByTestId("pending-conflicts");
    const local = await services.db.records.get(["preferences", "00000000-0000-4000-8000-000000000001"]);
    expect(local).toBeUndefined(); // created lazily; make a conflicting pair of edits:
    await updateSharedPreferences(services.db, { weekStart: 0 });
    const other = new LocalDb(`other-${++dbCounter}`);
    await other.meta.put({ key: "device", value: { id: crypto.randomUUID(), name: "Laptop" } });
    await updateSharedPreferences(other, { weekStart: 2 });
    const backup = await createBackup(other, PRODUCT_REGISTRY);
    other.close();

    fireEvent.change(screen.getByLabelText("Choose a backup file"), { target: { files: [new File([backup.text], "b.json")] } });
    fireEvent.click(within(await screen.findByTestId("import-preview")).getByRole("button", { name: "Import" }));
    const conflict = await screen.findByTestId("backup-conflict");
    expect(conflict.textContent).toContain("On this device");
    expect(conflict.textContent).toContain("In the backup (from Laptop");
    expect(within(conflict).queryByRole("button", { name: "Keep both" })).toBeNull();
    fireEvent.click(within(conflict).getByRole("button", { name: "Keep this device's version" }));
    await waitFor(() => expect(screen.queryByTestId("backup-conflict")).toBeNull());
    expect((await getSharedPreferences(services.db)).weekStart).toBe(0);
  });
});
