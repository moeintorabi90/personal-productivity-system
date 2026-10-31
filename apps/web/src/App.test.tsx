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
import { createGoal, defaultStartDate, loadGoals } from "./local/goals.ts";
import { defaultColorOf } from "./planning/colors.ts";
import { createProject, createTask, createWorkstream, loadOrganization, updateProject } from "./local/organization.ts";
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
  it("renders English LTR with Home, Today, Calendar, Inbox, Projects, Goals, Settings, Backup only; no sync UI; engine not started", async () => {
    const start = vi.spyOn((await import("./sync/sync-engine.ts")).SyncEngine.prototype, "start");
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Welcome" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dir).toBe("ltr"));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Home", "Today", "Work", "Calendar", "Inbox", "Projects", "Goals", "Settings", "Backup"]);
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
    // Each component follows its own preferences query: wait for each one's Persian text under load.
    expect(await screen.findByRole("navigation", { name: "اصلی" })).toBeTruthy();
    expect((await getDeviceSettings(services.db)).language).toBe("fa");
    expect(await getSharedPreferences(services.db)).not.toHaveProperty("language");
    fireEvent.change(await screen.findByLabelText("زبان"), { target: { value: "en" } });
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
    expect(screen.getByTestId("conflict-current").textContent).toContain("Sunday");
    expect(screen.queryByTestId("conflict-snapshot")).toBeNull();

    // Edited after the conflict was found: the card shows the CURRENT version, plus the earlier one.
    await act(() => updateSharedPreferences(services.db, { weekStart: 3 }));
    await waitFor(() => expect(screen.getByTestId("conflict-current").textContent).toContain("Wednesday"));
    const earlier = await screen.findByTestId("conflict-snapshot");
    expect(earlier.textContent).toContain("Sunday");
    expect(earlier.textContent).toContain("kept in Replaced versions");
    expect(earlier.textContent).toContain("found on This device"); // new conflicts name the device that found them

    fireEvent.click(within(screen.getByTestId("backup-conflict")).getByRole("button", { name: "Keep this device's version" }));
    await waitFor(() => expect(screen.queryByTestId("backup-conflict")).toBeNull());
    expect((await getSharedPreferences(services.db)).weekStart).toBe(3);
    // The backup's version and the earlier snapshot are both kept for undo.
    expect(await services.db.replacedVersions.count()).toBe(2);
  });

  it("a conflict stored by the first Stage 1B build (no detectedOn) says the device is unknown and names no device", async () => {
    renderApp();
    await goTo("Backup");
    await screen.findByTestId("pending-conflicts");
    await services.db.meta.put({ key: "device", value: { id: crypto.randomUUID(), name: "Desk" } });
    await updateSharedPreferences(services.db, { weekStart: 0 });
    const other = new LocalDb(`other-${++dbCounter}`);
    await other.meta.put({ key: "device", value: { id: crypto.randomUUID(), name: "Laptop" } });
    await updateSharedPreferences(other, { weekStart: 2 });
    const backup = await createBackup(other, PRODUCT_REGISTRY);
    other.close();
    fireEvent.change(screen.getByLabelText("Choose a backup file"), { target: { files: [new File([backup.text], "b.json")] } });
    fireEvent.click(within(await screen.findByTestId("import-preview")).getByRole("button", { name: "Import" }));
    await screen.findByTestId("backup-conflict");

    // Rewrite the row as that build stored it, then edit so the snapshot differs.
    const [row] = await services.db.pendingConflicts.toArray();
    const { detectedOn: _notStoredThen, ...legacy } = row!;
    await act(async () => {
      await services.db.pendingConflicts.put(legacy);
      await updateSharedPreferences(services.db, { weekStart: 3 });
    });
    const earlier = await screen.findByTestId("conflict-snapshot");
    expect(earlier.textContent).toContain("Which device that was is not known");
    expect(earlier.textContent).toContain("Sunday");
    expect(earlier.textContent).not.toContain("Desk");
    expect(earlier.textContent).not.toContain("Laptop");
    expect(earlier.textContent).not.toContain("This device");

    fireEvent.click(within(screen.getByTestId("backup-conflict")).getByRole("button", { name: "Keep this device's version" }));
    await waitFor(() => expect(screen.queryByTestId("backup-conflict")).toBeNull());
    expect(await services.db.replacedVersions.count()).toBe(2);
  });

  it("a project conflict shows readable fields and offers no 'Keep both' (linked record)", async () => {
    const other = new LocalDb(`other-${++dbCounter}`);
    await other.meta.put({ key: "device", value: { id: crypto.randomUUID(), name: "Laptop" } });
    const projectId = await createProject(other, { name: "Thesis" });
    const first = await createBackup(other, PRODUCT_REGISTRY);

    renderApp();
    await goTo("Backup");
    const input = (await screen.findByLabelText("Choose a backup file")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([first.text], "a.json")] } });
    fireEvent.click(within(await screen.findByTestId("import-preview")).getByRole("button", { name: "Import" }));
    await screen.findByTestId("import-done");

    await updateProject(services.db, projectId, { name: "Thesis (here)" });
    await updateProject(other, projectId, { name: "Thesis (laptop)" });
    const second = await createBackup(other, PRODUCT_REGISTRY);
    other.close();
    fireEvent.change(screen.getByLabelText("Choose a backup file"), { target: { files: [new File([second.text], "b.json")] } });
    fireEvent.click(within(await screen.findByTestId("import-preview")).getByRole("button", { name: "Import" }));

    const card = await screen.findByTestId("backup-conflict");
    expect(within(card).getByRole("heading", { level: 3 }).textContent).toBe("Project");
    // Field labels (the ":" is added by CSS) instead of raw field names.
    expect(within(card).getByTestId("conflict-current").textContent).toContain("NameThesis (here)");
    expect(within(card).getByTestId("conflict-incoming").textContent).toContain("NameThesis (laptop)");
    expect(within(card).getByTestId("conflict-current").textContent).toContain("ArchivedNot archived");
    expect(card.textContent).not.toContain("archivedAt");
    expect(within(card).queryByRole("button", { name: "Keep both" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Use the backup's version" }));
    await waitFor(() => expect(screen.queryByTestId("backup-conflict")).toBeNull());
    expect((await loadOrganization(services.db)).projects[0]!.data.name).toBe("Thesis (laptop)");
  });

  /** A session, its output, and two correction records, emptied from the trash on another device; its backup is imported here. */
  async function importSessionDeletions() {
    const { addOutputs, correctOutputValue, createOutputDefinition, deleteSession, purgeTrash, recordPastSession } = await import("./local/work.ts");
    const other = new LocalDb(`other-${++dbCounter}`);
    await other.meta.put({ key: "device", value: { id: crypto.randomUUID(), name: "Laptop" } });
    await updateSharedPreferences(other, { timeZone: "Asia/Tehran" });
    const definition = await createOutputDefinition(other, { name: "Pages", unit: "pages" });
    const session = await recordPastSession(other, { date: "2026-10-01", startTime: "08:00", durationMinutes: 30 });
    const [output] = await addOutputs(other, session, [{ definitionId: definition, value: 5 }]);
    await correctOutputValue(other, output!, 6, "typo");
    const first = await createBackup(other, PRODUCT_REGISTRY);

    renderApp();
    await goTo("Backup");
    const input = (await screen.findByLabelText("Choose a backup file")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([first.text], "a.json")] } });
    fireEvent.click(within(await screen.findByTestId("import-preview")).getByRole("button", { name: "Import" }));
    await screen.findByTestId("import-done");

    await deleteSession(other, session);
    await purgeTrash(other, { emptyNow: true });
    const second = await createBackup(other, PRODUCT_REGISTRY);
    other.close();
    fireEvent.change(screen.getByLabelText("Choose a backup file"), { target: { files: [new File([second.text], "b.json")] } });
    fireEvent.click(within(await screen.findByTestId("import-preview")).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getAllByTestId("backup-conflict")).toHaveLength(4));
  }

  it("deletions of a session and what belongs to it: blockers listed first, a refusal names them and changes nothing", async () => {
    await importSessionDeletions();
    const headings = () => screen.getAllByTestId("backup-conflict").map((c) => within(c).getByRole("heading", { level: 3 }).textContent);
    expect(headings()).toEqual(["Correction record", "Correction record", "Output", "Session"]);
    const sessionCard = screen.getAllByTestId("backup-conflict")[3]!;
    const blocked = within(sessionCard).getByTestId("conflict-blocked");
    expect(blocked.textContent).toContain("after the 3 item(s)");
    expect(within(blocked).getAllByRole("button", { name: "Go to its decision" })).toHaveLength(3);

    // Choosing the session first: refused next to it, naming the count; nothing changed.
    const before = await services.db.records.count();
    fireEvent.click(within(sessionCard).getByRole("button", { name: "Delete it here too" }));
    expect((await within(sessionCard).findByRole("alert")).textContent).toContain("3 item(s) on this device still belong to it");
    expect(await services.db.records.count()).toBe(before);
    expect(screen.getAllByTestId("backup-conflict")).toHaveLength(4);

    // From the top of the list, each choice goes through.
    for (let left = 4; left > 0; left--) {
      fireEvent.click(within(screen.getAllByTestId("backup-conflict")[0]!).getByRole("button", { name: "Delete it here too" }));
      await waitFor(() => expect(screen.queryAllByTestId("backup-conflict")).toHaveLength(left - 1));
    }
    expect(await services.db.tombstones.where("type").anyOf("sessions", "outputRecords", "corrections").count()).toBe(4);
  });

  it("an output kept here although the backup deleted it: the session's blocker message states only that it is still here", async () => {
    await importSessionDeletions();
    const card = (heading: string) =>
      screen.getAllByTestId("backup-conflict").find((c) => within(c).getByRole("heading", { level: 3 }).textContent === heading)!;
    fireEvent.click(within(card("Output")).getByRole("button", { name: "Keep it here" }));
    await waitFor(() => expect(screen.getAllByTestId("backup-conflict")).toHaveLength(3));

    const items = within(within(card("Session")).getByTestId("conflict-blocked")).getAllByRole("listitem");
    const output = items.find((li) => li.textContent!.startsWith("Output"))!;
    expect(output.textContent).toBe(
      "Output — still on this device and blocks deleting this item. To delete this item, first delete that one separately; otherwise keep this item.",
    );
    expect(output.textContent).not.toContain("not deleted");
    expect(within(output).queryByRole("button", { name: "Go to its decision" })).toBeNull();
    // The corrections still have their own decisions.
    expect(items.filter((li) => li.textContent!.includes("also deleted in this backup"))).toHaveLength(2);
  });

  it("a deleted block whose saved versions name two tasks: the Backup screen asks which task, sets the other aside, and the block can be restored (T-172)", async () => {
    const { createBlock } = await import("./local/planning.ts");
    const { makeEnvelope, nowIso } = await import("./backup/envelope.ts");
    renderApp();
    await goTo("Backup");
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    const write = await createTask(services.db, { title: "Write article" });
    const read = await createTask(services.db, { title: "Read book" });
    const block = await createBlock(services.db, { taskId: write, date: "2026-11-03", startTime: "09:00", durationMinutes: 30 });
    // As data from before T-171 could have left it: archived versions for both tasks, the block deleted here.
    const row = (await services.db.records.get(["calendarBlocks", block]))!;
    for (const taskId of [write, read]) {
      const entry = { deleted: false as const, envelope: makeEnvelope(block, { ...row.data, taskId }, { [crypto.randomUUID()]: 1 }, nowIso()) };
      await services.db.replacedVersions.put({ replacedId: crypto.randomUUID(), type: "calendarBlocks", id: block, entry, replacedAt: nowIso(), reason: "notChosen" });
    }
    await services.db.records.delete(["calendarBlocks", block]);
    await services.db.tombstones.put({ type: "calendarBlocks", id: block, deletedAt: nowIso(), version: { ...row.version, [crypto.randomUUID()]: 1 } });

    const card = await screen.findByTestId("inconsistent-history");
    expect(card.textContent).toContain("Which task does this planned block belong to?");
    await waitFor(() => expect(within(screen.getByTestId("inconsistent-history")).getAllByRole("button")).toHaveLength(2));
    expect(within(screen.getByTestId("inconsistent-history")).getAllByRole("button").map((b) => b.textContent).sort()).toEqual([
      "It belongs to Read book (1 saved version(s))",
      "It belongs to Write article (1 saved version(s))",
    ]);

    fireEvent.click(within(screen.getByTestId("inconsistent-history")).getByRole("button", { name: "It belongs to Write article (1 saved version(s))" }));
    await waitFor(() => expect(screen.queryByTestId("inconsistent-histories")).toBeNull());
    const setAside = await screen.findByTestId("set-aside-versions");
    expect(within(setAside).getAllByRole("article")).toHaveLength(1);
    expect(await services.db.replacedVersions.count()).toBe(1);

    fireEvent.click(within(screen.getByTestId("replaced-versions")).getByRole("button", { name: "Restore this version" }));
    await waitFor(async () => expect((await services.db.records.get(["calendarBlocks", block]))?.data.taskId).toBe(write));
  });

  it("a goal update that outputs here would not fit: the preview names them, the rest imports without updates, and with updates the import is refused whole", async () => {
    const { createOutputDefinition, deleteOutput, linkGoalDefinition, recordPastSession } = await import("./local/work.ts");
    const { putRecord } = await import("./local/records.ts");
    const { openBackupFile } = await import("./backup/read.ts");
    const { applyImport } = await import("./backup/merge.ts");
    const { loadConflictViews, resolveConflict } = await import("./backup/conflicts.ts");
    const importDirect = async (db: LocalDb, text: string) =>
      applyImport(db, await openBackupFile(new Blob([text]), PRODUCT_REGISTRY), PRODUCT_REGISTRY, { applyUpdates: false, applyDisplaySettings: false });

    // A (the other device) and B (this app) link the same earlier goal to different definitions;
    // A keeps its own version in the conflict, so A's goal version is newer than B's.
    const other = new LocalDb(`other-${++dbCounter}`);
    await other.meta.put({ key: "device", value: { id: crypto.randomUUID(), name: "Laptop" } });
    await updateSharedPreferences(other, { timeZone: "Asia/Tehran" });
    const goal = crypto.randomUUID();
    await putRecord(other, PRODUCT_REGISTRY, "goals", goal, {
      name: "Reading", description: "", projectId: null, startDate: "2026-10-01", deadline: null,
      kind: "output", target: 100, unit: "pages", status: "active", archivedAt: null,
    });
    renderApp();
    await goTo("Backup");
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    await importDirect(services.db, (await createBackup(other, PRODUCT_REGISTRY)).text);
    await linkGoalDefinition(other, goal, await createOutputDefinition(other, { name: "Pages", unit: "pages" }));
    const pagesHere = await createOutputDefinition(services.db, { name: "Book pages", unit: "pages" });
    await linkGoalDefinition(services.db, goal, pagesHere);
    await importDirect(other, (await createBackup(services.db, PRODUCT_REGISTRY)).text);
    const [view] = await loadConflictViews(other, PRODUCT_REGISTRY);
    await resolveConflict(other, PRODUCT_REGISTRY, view!.conflict.conflictId, "keepDevice", view!.token);
    await recordPastSession(services.db, { date: "2026-10-05", startTime: "10:00", durationMinutes: 30, outputs: [{ definitionId: pagesHere, value: 7, goalIds: [goal] }] });
    await recordPastSession(services.db, { date: "2026-10-06", startTime: "11:00", durationMinutes: 30, outputs: [{ definitionId: pagesHere, value: 4, goalIds: [goal] }] });
    const trashed = (await services.db.records.where("type").equals("outputRecords").toArray()).find((o) => o.data.value === 4)!.id;
    await deleteOutput(services.db, trashed);
    const garden = await createProject(other, { name: "Garden" }); // new data in the same file
    const backup = await createBackup(other, PRODUCT_REGISTRY);
    other.close();
    const definitionOfGoal = async () => ((await services.db.records.get(["goals", goal]))!.data as { definitionId?: string }).definitionId;
    const before = await services.db.records.count();

    // The preview is shown (not an error), with the update choice and the outputs that block it.
    fireEvent.change(screen.getByLabelText("Choose a backup file"), { target: { files: [new File([backup.text], "b.json")] } });
    const preview = await screen.findByTestId("import-preview");
    expect(screen.queryByTestId("import-error")).toBeNull();
    const warning = within(preview).getByTestId("import-updates-blocked");
    expect(warning.textContent).toContain("With the updates applied, the import is refused");
    const listed = within(await within(warning).findByTestId("blocking-outputs"))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(listed).toHaveLength(2);
    expect(listed.filter((text) => text!.startsWith("7 pages · Book pages, in the session started ") && !text!.includes("in the trash"))).toHaveLength(1);
    expect(listed.filter((text) => text!.startsWith("4 pages · Book pages") && text!.endsWith("(in the trash: restore it to change its goal)"))).toHaveLength(1);

    // With the updates applied: refused as a whole, the outputs named, nothing written; the preview stays.
    const updates = within(preview).getByRole("checkbox", { name: /Apply 1 newer version/ }) as HTMLInputElement;
    fireEvent.click(updates);
    expect(updates.checked).toBe(true);
    fireEvent.click(within(preview).getByRole("button", { name: "Import" }));
    const error = await screen.findByTestId("import-error");
    expect(error.textContent).toContain("outputs on this device count toward that goal with a different definition");
    expect(error.textContent).toContain("Nothing on this device was changed.");
    expect(within(await within(error).findByTestId("blocking-outputs")).getAllByRole("listitem")).toHaveLength(2);
    expect(await services.db.records.count()).toBe(before);
    expect(await services.db.records.get(["projects", garden])).toBeUndefined();
    expect(await definitionOfGoal()).toBe(pagesHere);

    // Without the updates: the new data is imported and the goal keeps this device's definition.
    fireEvent.click(updates);
    fireEvent.click(within(screen.getByTestId("import-preview")).getByRole("button", { name: "Import" }));
    await screen.findByTestId("import-done");
    expect(await services.db.records.get(["projects", garden])).toBeDefined();
    expect(await definitionOfGoal()).toBe(pagesHere);
    expect(((await services.db.records.where("type").equals("outputRecords").toArray()).map((o) => o.data.goalIds))).toEqual([[goal], [goal]]);
  });
});

describe("Stage 2: inbox, projects, workstreams, tasks", () => {
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

  it("captures into the inbox, organizes into a project's workstream, and shows the grouped project detail", async () => {
    renderApp();
    await goTo("Projects");
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
    fireEvent.change(field("Name"), { target: { value: "Thesis" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Thesis" })).toBeTruthy();
    fireEvent.change(field("Workstream name"), { target: { value: "Writing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add workstream" }));
    await screen.findByLabelText("New task in Writing");
    fireEvent.change(field("New task in Thesis"), { target: { value: "Meet supervisor" } });
    fireEvent.click(within(screen.getByTestId("direct-tasks")).getByRole("button", { name: "Add task" }));
    await within(screen.getByTestId("direct-tasks")).findByText("Meet supervisor");

    await goTo("Inbox");
    fireEvent.change(await screen.findByLabelText("Capture a task or idea"), { target: { value: "  Draft chapter 2 " } });
    fireEvent.click(screen.getByRole("button", { name: "Add to inbox" }));
    expect(await within(screen.getByTestId("inbox-list")).findByText("Draft chapter 2")).toBeTruthy();
    expect(screen.getByText("Added to the inbox: Draft chapter 2")).toBeTruthy();

    const org = await loadOrganization(services.db);
    const project = org.projects[0]!;
    const workstream = org.workstreams[0]!;
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Draft chapter 2" }));
    fireEvent.change(field("Project"), { target: { value: project.id } });
    fireEvent.change(await screen.findByLabelText("Workstream"), { target: { value: workstream.id } });
    fireEvent.change(field("Next action"), { target: { value: "Outline section 1" } });
    fireEvent.change(field("Estimate (minutes)"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The inbox is empty.")).toBeTruthy();

    await goTo("Projects");
    fireEvent.click(await screen.findByRole("button", { name: "Open project: Thesis" }));
    const ws = await screen.findByTestId("workstream");
    expect(within(ws).getByRole("heading", { level: 2 }).textContent).toContain("Writing");
    expect(ws.textContent).toContain("Draft chapter 2");
    expect(ws.textContent).toContain("Next: Outline section 1");
    expect(ws.textContent).toContain("Estimate: 45 min");
    const direct = screen.getByTestId("direct-tasks");
    expect(direct.textContent).toContain("Meet supervisor");
    expect(direct.textContent).not.toContain("Draft chapter 2");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("archives without deleting, filters by status, and searches across projects, workstreams, and tasks", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    const thesis = await createProject(services.db, { name: "Thesis" });
    await createProject(services.db, { name: "Garden" });
    const ws = await createWorkstream(services.db, { projectId: thesis, name: "Writing" });
    await createTask(services.db, { title: "Draft chapter", projectId: thesis, workstreamId: ws });

    await goTo("Projects");
    fireEvent.click(await screen.findByRole("button", { name: "Open project: Garden" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive: Garden" }));
    expect(await screen.findByText(/This project is archived/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← All projects" }));

    const list = await screen.findByTestId("project-list");
    await waitFor(() => expect(within(list).queryByText("Garden")).toBeNull());
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "archived" } });
    await waitFor(() => expect(within(screen.getByTestId("project-list")).getByText("Garden")).toBeTruthy());
    expect(within(screen.getByTestId("project-list")).getByText("Archived")).toBeTruthy();
    expect((await loadOrganization(services.db)).projects).toHaveLength(2); // archived, not deleted

    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "active" } });
    fireEvent.change(screen.getByLabelText("Search projects, workstreams, and tasks"), { target: { value: "WRIT" } });
    expect(within(await screen.findByTestId("workstream-results")).getByText("Writing")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search projects, workstreams, and tasks"), { target: { value: "draft" } });
    const tasks = await screen.findByTestId("task-results");
    await waitFor(() => expect(tasks.textContent).toContain("Draft chapter"));
    expect(tasks.textContent).toContain("Thesis");
  });

  it("is fully translated in Persian (RTL)", async () => {
    renderApp();
    await goTo("Settings");
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "fa" } });
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    const nav = screen.getByRole("navigation", { name: "اصلی" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["خانه", "امروز", "کار", "تقویم", "صندوق ورودی", "پروژه‌ها", "اهداف", "تنظیمات", "پشتیبان"]);
    fireEvent.click(within(nav).getByRole("button", { name: "صندوق ورودی" }));
    expect(await screen.findByLabelText("ثبت سریع کار یا ایده")).toBeTruthy();
    fireEvent.click(within(nav).getByRole("button", { name: "پروژه‌ها" }));
    expect(await screen.findByRole("heading", { level: 1, name: "پروژه‌ها" })).toBeTruthy();
  });
});

describe("Stage 3: calendar, Today, recurrence, capacity", () => {
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
  // Monday 2026-11-02, 09:30 in Tehran. Only Date is faked; timers and IndexedDB stay real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T06:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  async function blocks() {
    return services.db.records.where("type").equals("calendarBlocks").toArray();
  }

  it("6. without a time zone the planning screens ask for one, write nothing, and only suggest the device zone", async () => {
    renderApp();
    await goTo("Calendar");
    expect(await screen.findByTestId("zone-prompt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add a planned block/ })).toBeNull();
    await goTo("Today");
    expect(await screen.findByTestId("zone-prompt")).toBeTruthy();
    expect((await getSharedPreferences(services.db)).timeZone).toBeNull();
    expect(await blocks()).toHaveLength(0);
    await goTo("Inbox");
    const task = await createTask(services.db, { title: "Gym" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit task: Gym" }));
    expect(field("Repeats every week on selected days").disabled).toBe(true);
    expect(screen.getByText(/Set a time zone in Settings to make a task repeat/)).toBeTruthy();
    expect((await services.db.records.get(["taskDefinitions", task]))!.data).not.toHaveProperty("recurrence");
  });

  it("16. Settings explains that a zone change may move displayed block times or dates (English and Persian); capacity is optional", async () => {
    renderApp();
    await goTo("Settings");
    expect((await screen.findByTestId("zone-change-note")).textContent).toContain("may change the displayed time or date of existing planned blocks");
    fireEvent.change(field("Daily capacity (minutes)"), { target: { value: "1441" } });
    expect(screen.getByText(/Enter whole minutes from 1 to/)).toBeTruthy();
    fireEvent.change(field("Daily capacity (minutes)"), { target: { value: "300" } });
    fireEvent.blur(field("Daily capacity (minutes)"));
    await waitFor(async () => expect((await getSharedPreferences(services.db)).dailyCapacityMinutes).toBe(300));
    await waitFor(() => expect(field("Daily capacity (minutes)").value).toBe("300"));
    fireEvent.change(field("Daily capacity (minutes)"), { target: { value: "" } });
    fireEvent.blur(field("Daily capacity (minutes)"));
    await waitFor(async () => expect(await getSharedPreferences(services.db)).not.toHaveProperty("dailyCapacityMinutes"));
    fireEvent.change(field("Language"), { target: { value: "fa" } });
    await waitFor(() => expect(screen.getByTestId("zone-change-note").textContent).toContain("تغییر منطقهٔ زمانی ممکن است ساعت یا تاریخ"));
  });

  it("7–8, 18. a recurring task appears on Today; scheduling needs a user-entered start time; cancel and restore", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    await createTask(services.db, { title: "Gym", estimateMinutes: 45 });

    await goTo("Inbox");
    fireEvent.click(await screen.findByRole("button", { name: "Edit task: Gym" }));
    await waitFor(() => expect(field("Repeats every week on selected days").disabled).toBe(false)); // zone loaded
    fireEvent.click(field("Repeats every week on selected days"));
    expect(field("Starts on").value).toBe("2026-11-02"); // today in the configured zone
    expect(field("Ends on (optional)").value).toBe("");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true); // no weekday yet
    fireEvent.click(field("Monday"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Repeats: Mon · from/)).toBeTruthy();

    await goTo("Today");
    const today = await screen.findByTestId("day-panel");
    expect(screen.getByTestId("today-date").textContent).toContain("Monday");
    expect(within(today).getByTestId("unscheduled-row").textContent).toContain("Gym");
    fireEvent.click(within(today).getByRole("button", { name: "Schedule: Gym" }));
    const form = await screen.findByRole("form", { name: "Schedule: Gym" });
    expect((within(form).getByLabelText("Start time") as HTMLInputElement).value).toBe(""); // never pre-filled
    expect((within(form).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-11-02");
    expect((within(form).getByLabelText("Duration (minutes)") as HTMLInputElement).value).toBe("45");
    expect(within(form).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(form).getByLabelText("Start time"), { target: { value: "18:30" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    const row = await screen.findByTestId("block-row");
    expect(row.textContent).toContain("18:30–19:15");
    expect(screen.queryByTestId("unscheduled-row")).toBeNull();
    const [stored] = await blocks();
    expect(stored!.data).toMatchObject({ startsAt: "2026-11-02T15:00:00.000Z", occurrenceDate: "2026-11-02", status: "planned" });

    fireEvent.click(within(row).getByRole("button", { name: "Cancel planned block: Gym" }));
    expect(await screen.findByTestId("unscheduled-row")).toBeTruthy(); // cancelled blocks are hidden; the item is back
    await goTo("Calendar");
    fireEvent.change(await screen.findByLabelText("View"), { target: { value: "day" } });
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "list" } }); // the list layout stays (follow-up)
    fireEvent.click(screen.getByLabelText("Show cancelled blocks"));
    const cancelled = await screen.findByTestId("block-row");
    expect(cancelled.textContent).toContain("Cancelled");
    expect(cancelled.textContent).not.toContain("Planned"); // one status label per block
    fireEvent.click(within(cancelled).getByRole("button", { name: "Restore planned block: Gym" }));
    await waitFor(() => expect(screen.queryByTestId("unscheduled-row")).toBeNull());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("13, 15, 19–20. quick add, week and month views, navigation, go to date, filters, capacity warning that never blocks saving", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran", dailyCapacityMinutes: 60 });
    const project = await createProject(services.db, { name: "Thesis" });
    await createTask(services.db, { title: "Draft chapter", projectId: project });

    await goTo("Calendar");
    fireEvent.change(await screen.findByLabelText("Layout"), { target: { value: "list" } }); // the list layout stays (follow-up)
    const week = await screen.findByTestId("week-view");
    expect(within(week).getAllByTestId("day-panel").map((p) => p.dataset.date)).toEqual([
      "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
    ]); // Saturday week start
    const monday = within(week).getAllByTestId("day-panel")[2]!;
    fireEvent.click(within(monday).getByRole("button", { name: /Add a planned block on/ }));
    const form = await within(monday).findByRole("form", { name: "New planned block" });
    fireEvent.change(within(form).getByLabelText("Title of the new task"), { target: { value: "Call the bank" } });
    fireEvent.change(within(form).getByLabelText("Start time"), { target: { value: "10:00" } });
    fireEvent.change(within(form).getByLabelText("Duration (minutes)"), { target: { value: "90" } });
    expect((await within(form).findByTestId("form-capacity-warning")).textContent).toContain("more than your capacity");
    fireEvent.click(within(form).getByRole("button", { name: "Save" })); // allowed after the warning
    await waitFor(() => expect(within(monday).getByTestId("block-row").textContent).toContain("Call the bank"));
    expect(within(monday).getByTestId("capacity").dataset.capacity).toBe("warning");
    expect((await loadOrganization(services.db)).tasks.find((t) => t.data.title === "Call the bank")!.data.projectId).toBeNull();

    // A second block for an existing task, then filters.
    fireEvent.click(within(monday).getByRole("button", { name: /Add a planned block on/ }));
    const second = await within(monday).findByRole("form", { name: "New planned block" });
    const draft = (await loadOrganization(services.db)).tasks.find((t) => t.data.title === "Draft chapter")!;
    fireEvent.change(within(second).getByLabelText("Task"), { target: { value: draft.id } });
    fireEvent.change(within(second).getByLabelText("Start time"), { target: { value: "14:00" } });
    fireEvent.change(within(second).getByLabelText("Duration (minutes)"), { target: { value: "30" } });
    fireEvent.click(within(second).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(monday).getAllByTestId("block-row")).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: project } });
    await waitFor(() => expect(within(monday).getAllByTestId("block-row").map((r) => r.textContent)).toEqual([expect.stringContaining("Draft chapter")]));
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "inbox" } });
    await waitFor(() => expect(within(monday).getAllByTestId("block-row").map((r) => r.textContent)).toEqual([expect.stringContaining("Call the bank")]));
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Search by task title"), { target: { value: "bank" } });
    await waitFor(() => expect(within(monday).getAllByTestId("block-row")).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Search by task title"), { target: { value: "" } });

    // Month view (Gregorian display): November 2026, with counts and the over-capacity marker.
    fireEvent.change(screen.getByLabelText("View"), { target: { value: "month" } });
    const month = await screen.findByTestId("month-view");
    expect(within(month).getByRole("heading", { level: 2 }).textContent).toBe("November 2026");
    const cell = month.querySelector('[data-date="2026-11-02"]')!;
    expect(cell.textContent).toContain("2 planned");
    expect(cell.textContent).toContain("Over capacity");
    expect(month.querySelectorAll(".month-cell")).toHaveLength(30);
    const navigation = screen.getByRole("group", { name: "Move through the calendar" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Next" }));
    expect(await within(screen.getByTestId("month-view")).findByText("December 2026")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Go to date"), { target: { value: "2027-02-14" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await within(screen.getByTestId("month-view")).findByText("February 2027")).toBeTruthy();
    fireEvent.click(within(navigation).getByRole("button", { name: "Today" }));
    expect(await within(screen.getByTestId("month-view")).findByText("November 2026")).toBeTruthy();
    // Opening a day from the month view.
    fireEvent.click(within(screen.getByTestId("month-view")).getByRole("button", { name: /Monday,? 2 November 2026: 2 planned block/ }));
    expect((await screen.findByTestId("day-panel")).dataset.date).toBe("2026-11-02");
    expect(await blocks()).toHaveLength(2);
  });

  it("26. Persian RTL with Jalali display: Jalali month, Jalali date entry, correct weekdays", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran", calendarDisplay: "jalali" });
    await goTo("Settings");
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "fa" } });
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    await goTo("تقویم");
    fireEvent.change(await screen.findByLabelText("نما"), { target: { value: "month" } });
    const month = await screen.findByTestId("month-view");
    expect(within(month).getByRole("heading", { level: 2 }).textContent).toContain("آبان"); // 2 Nov 2026 = 11 Aban 1405
    const cells = [...month.querySelectorAll<HTMLElement>(".month-cell")];
    expect(cells[0]!.dataset.date).toBe("2026-10-23"); // 1 Aban 1405
    expect(cells).toHaveLength(30);
    // Jalali date entry in "go to date": 1 Farvardin 1406 = 21 March 2027.
    const goTo2 = await screen.findByRole("group", { name: "رفتن به تاریخ" }); // after the display preference loads
    // The field's own labels follow its own preferences query, which can resolve after the legend
    // (passed in already translated) under load: wait for them.
    fireEvent.change(await within(goTo2).findByLabelText("سال"), { target: { value: "1406" } });
    fireEvent.change(within(goTo2).getByLabelText("ماه"), { target: { value: "1" } });
    fireEvent.change(within(goTo2).getByLabelText("روز"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "برو" }));
    await waitFor(() => expect(screen.getByTestId("month-view").querySelector(".month-cell")!.getAttribute("data-date")).toBe("2027-03-21"));
    fireEvent.change(screen.getByLabelText("نما"), { target: { value: "day" } });
    fireEvent.change(await screen.findByLabelText("چیدمان"), { target: { value: "list" } }); // the list layout stays (follow-up)
    expect((await screen.findByTestId("day-panel")).textContent).toContain("یکشنبه"); // 21 March 2027 is a Sunday
  });
});

describe("Stage 4: goals and milestones (TESTING.md Stage 4 item 11)", () => {
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
  const goalsNav = () => within(screen.getByRole("navigation")).getByRole("button", { name: "Goals" });

  it("creates an output goal with today's default start, shows no progress, and walks the status and archive lifecycle", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    const project = await createProject(services.db, { name: "Thesis" });
    fireEvent.click(goalsNav());
    expect(await screen.findByText("No goals yet. Create one below.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create goal" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(field("Name"), { target: { value: "Write the book" } });
    fireEvent.change(field("Target (whole number)"), { target: { value: "2.5" } });
    expect(await screen.findByText("Enter a whole number from 1 to 1,000,000,000.")).toBeTruthy();
    fireEvent.change(field("Target (whole number)"), { target: { value: "300" } });
    // From Stage 5 an output goal tracks an output definition, created here with the goal (T-151, T-154).
    fireEvent.change(field("Name of the output definition"), { target: { value: "Pages written" } });
    fireEvent.change(field("Unit (for example pages or words)"), { target: { value: "pages" } });
    await waitFor(() => expect(field("Project (optional)").querySelectorAll("option")).toHaveLength(2));
    fireEvent.change(field("Project (optional)"), { target: { value: project } });
    const today = defaultStartDate("Asia/Tehran");
    await waitFor(() => expect(field("Start date").value).toBe(today));
    fireEvent.change(field("Deadline (optional)"), { target: { value: "2099-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Create goal" }));

    expect(await screen.findByRole("heading", { level: 1, name: /Write the book/ })).toBeTruthy();
    const goal = (await loadGoals(services.db)).goals[0]!;
    expect(goal.data).toMatchObject({ kind: "output", target: 300, projectId: project, startDate: today, deadline: "2099-12-31", status: "active" });
    expect(goal.data).not.toHaveProperty("unit"); // the unit comes from the definition (T-161)
    expect(goal.data.definitionId).toBeTruthy();
    expect(screen.getByText(/Progress is calculated from recorded work sessions/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/%/);
    // The unit comes from the output definition, read by its own live query (T-154).
    await waitFor(() => expect(document.body.textContent).toContain("300 pages"));

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await screen.findByRole("button", { name: "Resume" });
    fireEvent.click(screen.getByRole("button", { name: "Mark complete" })); // directly from paused (T-062)
    fireEvent.click(await screen.findByRole("button", { name: "Reopen" })); // T-060
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await screen.findByRole("button", { name: "Resume" });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByText(/This goal is archived/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add milestone" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByRole("button", { name: "Resume" }); // back to its pre-archive status: paused (T-065)
    expect((await loadGoals(services.db)).goals[0]!.data).toMatchObject({ status: "paused", archivedAt: null, startDate: today, deadline: "2099-12-31" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("time targets use hours and minutes; the type is fixed when editing", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    fireEvent.click(goalsNav());
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Study" } });
    fireEvent.change(field("Type"), { target: { value: "time" } });
    fireEvent.change(await screen.findByLabelText("Hours"), { target: { value: "40" } });
    fireEvent.change(field("Minutes"), { target: { value: "75" } });
    expect(await screen.findByText(/minutes 0–59/)).toBeTruthy();
    fireEvent.change(field("Minutes"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create goal" }));
    await screen.findByRole("heading", { level: 1, name: /Study/ });
    expect((await loadGoals(services.db)).goals[0]!.data).toMatchObject({ kind: "time", target: 2430 });
    expect(document.body.textContent).toContain("40 h 30 min");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("form", { name: "Edit goal: Study" });
    expect(within(editor).queryByLabelText("Type")).toBeNull();
    expect(editor.textContent).toContain("The type cannot be changed");
    fireEvent.change(within(editor).getByLabelText("Hours"), { target: { value: "2" } });
    fireEvent.change(within(editor).getByLabelText("Minutes"), { target: { value: "0" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await loadGoals(services.db)).goals[0]!.data.target).toBe(120));
  });

  it("milestones: deadline within the goal, independent completion, date-clash message, delete after confirmation", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    const goal = await createGoal(services.db, { name: "Book", startDate: "2026-11-01", deadline: "2026-12-31", kind: "taskCount", target: 20 });
    fireEvent.click(goalsNav());
    fireEvent.click(await screen.findByRole("button", { name: "Open goal: Book" }));
    const section = await screen.findByTestId("milestones");
    expect(section.textContent).toContain("No milestones yet.");
    fireEvent.change(within(section).getByLabelText("Milestone name"), { target: { value: "Late" } });
    fireEvent.change(within(section).getByLabelText("Deadline (optional)"), { target: { value: "2027-01-15" } });
    fireEvent.click(within(section).getByRole("button", { name: "Add milestone" }));
    expect((await within(section).findByRole("alert")).textContent).toContain("must be on or after the goal's start date");
    fireEvent.change(within(section).getByLabelText("Deadline (optional)"), { target: { value: "2026-12-20" } });
    fireEvent.click(within(section).getByRole("button", { name: "Add milestone" }));
    await within(section).findByText("Late");
    fireEvent.change(within(section).getByLabelText("Milestone name"), { target: { value: "Outline" } });
    fireEvent.click(within(section).getByRole("button", { name: "Add milestone" }));
    await within(section).findByText("Outline");

    fireEvent.click(within(section).getByRole("button", { name: "Mark milestone complete: Outline" }));
    await within(section).findByRole("button", { name: "Mark milestone incomplete: Outline" });
    expect(within(section).getByRole("button", { name: "Mark milestone complete: Late" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("form", { name: "Edit goal: Book" });
    fireEvent.change(within(editor).getByLabelText("Deadline (optional)"), { target: { value: "2026-12-10" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect((await within(editor).findByRole("alert")).textContent).toBe(
      "These dates would put milestone deadlines outside the goal: Late. Change those milestones first.",
    );
    expect((await loadGoals(services.db)).goals[0]!.data.deadline).toBe("2026-12-31");
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));

    fireEvent.click(within(section).getByRole("button", { name: "Delete milestone: Late" }));
    const dialog = await within(section).findByRole("alertdialog", { name: "Delete milestone: Late" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(within(section).getByText("Late")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Delete milestone: Late" }));
    fireEvent.click(within(await within(section).findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(section).queryByText("Late")).toBeNull());
    const { milestones } = await loadGoals(services.db);
    expect(milestones.map((m) => m.data.name)).toEqual(["Outline"]);
    expect(milestones[0]!.data.goalId).toBe(goal);
  });

  it("is translated in Persian (RTL) with Jalali date entry", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran", calendarDisplay: "jalali" });
    await goTo("Settings");
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "fa" } });
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    // Each component loads the device language and display calendar on its own (a live query per
    // hook), so every Persian or Jalali element is awaited, never read synchronously.
    fireEvent.click(await within(screen.getByRole("navigation")).findByRole("button", { name: "اهداف" }));
    expect(await screen.findByRole("heading", { level: 1, name: "اهداف" })).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("نام"), { target: { value: "مطالعه" } });
    fireEvent.change(await screen.findByLabelText("نوع"), { target: { value: "taskCount" } });
    fireEvent.change(await screen.findByLabelText("تعداد کارهای انجام‌شده‌ی هدف"), { target: { value: "12" } });
    const start = await screen.findByRole("group", { name: "تاریخ شروع" });
    fireEvent.change(await within(start).findByLabelText("سال"), { target: { value: "1405" } });
    fireEvent.change(await within(start).findByLabelText("ماه"), { target: { value: "8" } });
    fireEvent.change(await within(start).findByLabelText("روز"), { target: { value: "11" } });
    fireEvent.click(await screen.findByRole("button", { name: "ساختن هدف" }));
    await screen.findByRole("heading", { level: 1, name: /مطالعه/ });
    expect((await loadGoals(services.db)).goals[0]!.data).toMatchObject({ kind: "taskCount", startDate: "2026-11-02", target: 12 });
    expect(await screen.findByText(/پیشرفت از جلسه‌های کار/)).toBeTruthy();
    // 2 Nov 2026 = 11 Aban 1405: wait until the date line uses the Jalali display calendar.
    await waitFor(() => expect(document.body.textContent).toContain("آبان"));
  });
});

describe("Stage 3 follow-up: time grid, project colors, undo (TESTING.md follow-up items 1, 2, 4, 4a, 4b, 5, 6)", () => {
  // Monday 2026-11-02, 09:30 in Tehran. Only Date is faked; timers and IndexedDB stay real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T06:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  const HOUR_PX = 64; // TimeGrid.tsx
  const COLUMN_PX = 100;

  /** jsdom has no layout: grid columns get a 24 × 64 px height, side by side, 100 px wide. */
  function layoutGrid() {
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "grid-column") {
        const columns = [...document.querySelectorAll<HTMLElement>('[data-testid="grid-column"]')];
        const left = columns.indexOf(this) * COLUMN_PX;
        return { top: 0, bottom: 24 * HOUR_PX, height: 24 * HOUR_PX, left, right: left + COLUMN_PX, width: COLUMN_PX, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return real.call(this);
    });
    // jsdom has no PointerEvent; a MouseEvent with a pointer ID and type is enough here.
    if (!("PointerEvent" in window)) {
      class PointerEventPolyfill extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? "mouse";
        }
      }
      vi.stubGlobal("PointerEvent", PointerEventPolyfill);
    }
  }

  const y = (h: number, m = 0) => (h * 60 + m) * (HOUR_PX / 60);
  const pointer = (clientY: number, clientX = 250) => ({ clientX, clientY, pointerId: 1, pointerType: "mouse", button: 0, bubbles: true });

  async function gridWeek() {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    layoutGrid();
    await goTo("Calendar");
    return screen.findByTestId("grid-week-view");
  }

  it("5–6. a project's color is chosen from 8 named colors or the derived default; changing it writes only the project", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await goTo("Projects");
    const colorSelect = (await screen.findByLabelText("Color")) as HTMLSelectElement;
    expect([...colorSelect.options].map((o) => o.value)).toEqual(["", "blue", "teal", "green", "amber", "orange", "red", "pink", "purple"]);
    expect([...colorSelect.options].slice(1).map((o) => o.textContent)).toEqual(["Blue", "Teal", "Green", "Amber", "Orange", "Red", "Pink", "Purple"]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Thesis" } });
    fireEvent.change(colorSelect, { target: { value: "teal" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByTestId("project-color")).textContent).toContain("Color: Teal");
    const project = (await loadOrganization(services.db)).projects[0]!;
    expect(project.data.color).toBe("teal");

    const task = await createTask(services.db, { title: "Write", projectId: project.id });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    const { createBlock } = await import("./local/planning.ts");
    await createBlock(services.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
    const blockBefore = (await services.db.records.where("type").equals("calendarBlocks").toArray())[0]!;

    fireEvent.click(screen.getByRole("button", { name: "Edit project: Thesis" }));
    fireEvent.change(await screen.findByLabelText("Color"), { target: { value: "" } }); // back to the default
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await loadOrganization(services.db)).projects[0]!.data).not.toHaveProperty("color"));
    // The view follows the database through a live query: wait for it instead of reading once.
    await waitFor(async () => expect((await screen.findByTestId("project-color")).textContent).toMatch(/\(default\)/));
    expect((await services.db.records.where("type").equals("calendarBlocks").toArray())[0]).toEqual(blockBefore);

    await goTo("Today");
    const row = await screen.findByTestId("block-row");
    expect(row.dataset.color).toBe(defaultColorOf(project.id));
    expect(row.textContent).toContain("Planned"); // a visible non-color cue
  });

  it("4a, 1. a tap on empty time pre-fills 09:00–09:30 in the form; nothing is written until Save; a drag selection pre-fills its range", async () => {
    const week = await gridWeek();
    const columns = within(week).getAllByTestId("grid-column");
    expect(columns.map((c) => c.dataset.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
    const monday = columns[2]!;
    fireEvent.pointerDown(monday, pointer(y(9, 7)));
    fireEvent.pointerUp(monday, pointer(y(9, 7)));
    let form = await screen.findByRole("form", { name: "New planned block" });
    expect((within(form).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-11-02");
    expect((within(form).getByLabelText("Start time") as HTMLInputElement).value).toBe("09:00");
    expect((within(form).getByLabelText("Duration (minutes)") as HTMLInputElement).value).toBe("30");
    expect(await services.db.records.where("type").equals("calendarBlocks").count()).toBe(0);
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(await services.db.records.where("type").equals("calendarBlocks").count()).toBe(0);

    fireEvent.pointerDown(monday, pointer(y(13, 5)));
    fireEvent.pointerMove(monday, pointer(y(14, 40)));
    expect((await within(monday).findByTestId("grid-preview")).textContent).toContain("13:00");
    fireEvent.pointerUp(monday, pointer(y(14, 40)));
    form = await screen.findByRole("form", { name: "New planned block" });
    expect((within(form).getByLabelText("Start time") as HTMLInputElement).value).toBe("13:00");
    expect((within(form).getByLabelText("Duration (minutes)") as HTMLInputElement).value).toBe("105");
    fireEvent.change(within(form).getByLabelText("Title of the new task"), { target: { value: "Read" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    const block = await within(monday).findByTestId("grid-block");
    expect(block.textContent).toContain("13:00–14:45");
    expect(block.dataset.color).toBe("neutral"); // an inbox task has no project
    expect(block.textContent).toContain("Planned");
  });

  it("2, 4b. a drag-move snaps to 15 minutes, changes only that block, and offers Undo without a confirmation; Undo restores the times", async () => {
    const week = await gridWeek();
    const project = await createProject(services.db, { name: "Thesis", color: "purple" });
    const task = await createTask(services.db, { title: "Write", projectId: project });
    const { createBlock, setBlockCancelled } = await import("./local/planning.ts");
    const moved = await createBlock(services.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
    const other = await createBlock(services.db, { taskId: task, date: "2026-11-02", startTime: "16:00", durationMinutes: 30 });
    const otherBefore = await services.db.records.get(["calendarBlocks", other]);
    const monday = within(week).getAllByTestId("grid-column")[2]!;
    await waitFor(() => expect(within(monday).getAllByTestId("grid-block")).toHaveLength(2));
    const block = within(monday).getAllByTestId("grid-block").find((b) => b.dataset.blockId === moved)!;
    expect(block.dataset.color).toBe("purple");

    // Grab at 09:30, drop 1 h 22 min lower → start 10:22 → snaps to 10:15.
    fireEvent.pointerDown(block, pointer(y(9, 30)));
    fireEvent.pointerMove(block, pointer(y(10, 52)));
    fireEvent.pointerUp(block, pointer(y(10, 52)));
    const undo = await screen.findByTestId("undo-bar");
    expect(undo.textContent).toContain("Moved: Write");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(async () => expect((await services.db.records.get(["calendarBlocks", moved]))!.data.startsAt).toBe("2026-11-02T06:45:00.000Z")); // 10:15 Tehran
    expect(await services.db.records.get(["calendarBlocks", other])).toEqual(otherBefore);

    fireEvent.click(within(undo).getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await services.db.records.get(["calendarBlocks", moved]))!.data.startsAt).toBe("2026-11-02T05:30:00.000Z"));
    await waitFor(() => expect(screen.queryByTestId("undo-bar")).toBeNull());

    // A cancelled block is never dragged.
    await setBlockCancelled(services.db, other, true);
    fireEvent.click(screen.getByLabelText("Show cancelled blocks"));
    const cancelled = await waitFor(() => {
      const found = within(monday).getAllByTestId("grid-block").find((b) => b.dataset.blockId === other && b.dataset.status === "cancelled");
      if (!found) throw new Error("cancelled block not shown yet");
      return found;
    });
    const cancelledBefore = await services.db.records.get(["calendarBlocks", other]);
    fireEvent.pointerDown(cancelled, pointer(y(16, 10)));
    fireEvent.pointerMove(cancelled, pointer(y(18, 10)));
    fireEvent.pointerUp(cancelled, pointer(y(18, 10)));
    expect(await services.db.records.get(["calendarBlocks", other])).toEqual(cancelledBefore);
  });

  it("4b. Undo closes after another edit that keeps the times (version changed), so no stale undo is offered", async () => {
    const week = await gridWeek();
    const task = await createTask(services.db, { title: "Write" });
    const { createBlock, setBlockCancelled } = await import("./local/planning.ts");
    const id = await createBlock(services.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
    const monday = within(week).getAllByTestId("grid-column")[2]!;
    const block = await within(monday).findByTestId("grid-block");
    fireEvent.pointerDown(block, pointer(y(9, 30)));
    fireEvent.pointerMove(block, pointer(y(11, 30)));
    fireEvent.pointerUp(block, pointer(y(11, 30)));
    await screen.findByTestId("undo-bar");
    await waitFor(async () => expect((await services.db.records.get(["calendarBlocks", id]))!.data.startsAt).toBe("2026-11-02T07:30:00.000Z")); // 11:00
    // Cancel and restore: the same times and status, but a new version.
    await setBlockCancelled(services.db, id, true);
    await setBlockCancelled(services.db, id, false);
    await waitFor(() => expect(screen.queryByTestId("undo-bar")).toBeNull());
    expect((await services.db.records.get(["calendarBlocks", id]))!.data.startsAt).toBe("2026-11-02T07:30:00.000Z");
  });

  it("T-030 on the grid: a block in the repeated hour shows its offset, and a drag within its own slot writes nothing", async () => {
    vi.setSystemTime(new Date("2026-11-01T16:00:00.000Z")); // Sunday 1 Nov 2026, New York falls back at 02:00
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "America/New_York" });
    layoutGrid();
    const task = await createTask(services.db, { title: "Night shift" });
    const { createBlock } = await import("./local/planning.ts");
    await createBlock(services.db, { taskId: task, date: "2026-11-01", startTime: "00:00", durationMinutes: 15 }); // a valid block to copy fields from
    const { putRecord } = await import("./local/records.ts");
    const blocksNow = await services.db.records.where("type").equals("calendarBlocks").toArray();
    // A block in the SECOND 01:30 (EST, UTC−05:00), as a drag or an import may leave it.
    const id = crypto.randomUUID();
    await putRecord(services.db, PRODUCT_REGISTRY, "calendarBlocks", id, {
      ...blocksNow[0]!.data,
      startsAt: "2026-11-01T06:30:00.000Z",
      endsAt: "2026-11-01T07:00:00.000Z",
      localDate: "2026-11-01",
      timeZone: "America/New_York",
    });
    const before = await services.db.records.get(["calendarBlocks", id]);
    await goTo("Calendar");
    const week = await screen.findByTestId("grid-week-view");
    const sunday = within(week).getAllByTestId("grid-column").find((c) => c.dataset.date === "2026-11-01")!;
    const block = await waitFor(() => {
      const found = within(sunday).getAllByTestId("grid-block").find((b) => b.dataset.blockId === id);
      if (!found) throw new Error("not shown yet");
      return found;
    });
    expect(block.textContent).toContain("01:30 (UTC−05:00)");
    const x = Number(sunday.getBoundingClientRect().left) + 50;
    fireEvent.pointerDown(block, pointer(y(1, 35), x));
    fireEvent.pointerMove(block, pointer(y(1, 41), x));
    fireEvent.pointerUp(block, pointer(y(1, 41), x));
    await new Promise((r) => setTimeout(r, 50));
    expect(await services.db.records.get(["calendarBlocks", id])).toEqual(before);
    expect(screen.queryByTestId("undo-bar")).toBeNull();
  });

  it("4. keyboard path: each day has Add, and a block opens its row (edit, cancel) with Enter", async () => {
    const week = await gridWeek();
    const task = await createTask(services.db, { title: "Gym" });
    const { createBlock } = await import("./local/planning.ts");
    await createBlock(services.db, { taskId: task, date: "2026-11-03", startTime: "07:00", durationMinutes: 45 });
    const blockButton = await within(week).findByRole("button", { name: /^Gym, 07:00–07:45, 45 min, Planned$/ });
    fireEvent.click(blockButton, { detail: 0 }); // keyboard activation
    const opened = await screen.findByTestId("opened-block");
    expect(within(opened).getByRole("button", { name: "Change planned block: Gym" })).toBeTruthy();
    fireEvent.click(within(week).getByRole("button", { name: /Add a planned block on 3 Nov 2026/ }));
    const form = await screen.findByRole("form", { name: "New planned block" });
    expect((within(form).getByLabelText("Start time") as HTMLInputElement).value).toBe(""); // typed by the user
  });

  it("4a. on a phone-sized screen the week shows two days, and Previous/Next days reach every day", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 560px)", media: query, addEventListener() {}, removeEventListener() {} }));
    const week = await gridWeek();
    const shownDays = () => within(week).getAllByTestId("grid-column").map((c) => c.dataset.date);
    expect(shownDays()).toEqual(["2026-11-02", "2026-11-03"]); // starts at today
    const seen = new Set(shownDays());
    const next = screen.getByRole("button", { name: "Next days" });
    while (!(next as HTMLButtonElement).disabled) {
      fireEvent.click(next);
      shownDays().forEach((d) => seen.add(d));
    }
    expect(shownDays()).toEqual(["2026-11-05", "2026-11-06"]);
    const previous = screen.getByRole("button", { name: "Previous days" });
    while (!(previous as HTMLButtonElement).disabled) {
      fireEvent.click(previous);
      shownDays().forEach((d) => seen.add(d));
    }
    expect([...seen].sort()).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
  });
});

describe("Stage 5: actual work sessions and outputs (TESTING.md Stage 5 items 1, 5, 6, 8a, 11)", () => {
  it("a definition referenced only by an archived version asks the history question; keeping it leaves the earlier label (T-107, T-167)", async () => {
    const { createOutputDefinition, definitionLabel } = await import("./local/work.ts");
    const { makeEnvelope, nowIso } = await import("./backup/envelope.ts");
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    const def = await createOutputDefinition(services.db, { name: "Pages", unit: "pages" });
    const output = crypto.randomUUID();
    const entry = { deleted: false as const, envelope: makeEnvelope(output, { definitionId: def, revision: 0 }, { [crypto.randomUUID()]: 1 }, nowIso()) };
    await services.db.replacedVersions.put({ replacedId: crypto.randomUUID(), type: "outputRecords", id: output, entry, replacedAt: nowIso(), reason: "notChosen" });

    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Work" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit output definition: Pages" }));
    const form = await screen.findByRole("form", { name: "Edit output definition: Pages" });
    const keep = (await within(form).findByRole("radio", { name: "Keep the previous name and unit on earlier records" })) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Read pages" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Edit output definition: Read pages" });
    const saved = (await services.db.records.get(["outputDefinitions", def]))!.data as Parameters<typeof definitionLabel>[0];
    expect(definitionLabel(saved, 0)).toEqual({ name: "Pages", unit: "pages" });
    expect(definitionLabel(saved)).toEqual({ name: "Read pages", unit: "pages" });
  });

  const navTo = async (name: string) => fireEvent.click(await within(screen.getByRole("navigation")).findByRole("button", { name }));

  it("starts, pauses, resumes, and ends a session with an output and a rating; the recorded session uses the strong color treatment with a label", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    const { createOutputDefinition, loadWork } = await import("./local/work.ts");
    const content = await createOutputDefinition(services.db, { name: "Content covered", unit: "minutes" });
    await navTo("Work");
    expect(await screen.findByRole("heading", { level: 1, name: "Work" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    const current = await screen.findByTestId("current-session");
    fireEvent.click(await within(current).findByRole("button", { name: "Pause" }));
    fireEvent.click(await within(current).findByRole("button", { name: "Resume" }));
    // A second start is not offered while a session is open (T-092, T-117).
    expect(await screen.findByText(/A session is open on this device/)).toBeTruthy();
    fireEvent.click(await within(current).findByRole("button", { name: "End…" }));
    const form = await screen.findByTestId("end-form");
    fireEvent.click(within(form).getByRole("button", { name: "Add an output" }));
    const row = await within(form).findByTestId("output-row");
    fireEvent.change(within(row).getByLabelText("Output definition"), { target: { value: content } });
    fireEvent.change(within(row).getByLabelText("Amount"), { target: { value: "15" } });
    fireEvent.change(within(form).getByLabelText("Energy (1–5)"), { target: { value: "4" } });
    fireEvent.click(within(form).getByRole("button", { name: "End session" }));

    await waitFor(async () => expect((await loadWork(services.db)).sessions[0]!.data.endedAt).not.toBeNull());
    const work = await loadWork(services.db);
    expect(work.sessions[0]!.data).toMatchObject({ energy: 4, taskId: null });
    expect(work.sessions[0]!.data.pauses).toHaveLength(1);
    expect(work.outputs.map((o) => o.data.value)).toEqual([15]);
    const history = await screen.findByTestId("session-history");
    const recorded = await within(history).findByTestId("session-row");
    await waitFor(() => expect(recorded.textContent).toContain("15 minutes · Content covered"));
    expect(recorded.classList.contains("session-row")).toBe(true);
    expect(recorded.dataset.color).toBe("neutral");
    expect(recorded.textContent).toContain("Actual"); // a visible non-color cue (T-069)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("completes and reopens today's occurrence of a recurring task from Today (T-118, T-133, T-134, T-155)", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    const { setRecurrence } = await import("./local/planning.ts");
    const task = await createTask(services.db, { title: "Daily vocab" });
    await setRecurrence(services.db, task, { kind: "weekdays", weekdays: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-01-01", endDate: null });
    await navTo("Today");
    const item = await screen.findByTestId("unscheduled-row");
    fireEvent.click(await within(item).findByRole("button", { name: "Mark complete: Daily vocab" }));
    const done = await screen.findByTestId("completed-row");
    expect(done.textContent).toContain("Daily vocab");
    await waitFor(() => expect(screen.queryByTestId("unscheduled-row")).toBeNull());
    fireEvent.click(within(done).getByRole("button", { name: "Reopen: Daily vocab" }));
    expect(await screen.findByTestId("unscheduled-row")).toBeTruthy();
  });

  it("links a legacy output goal: an unknown pair asks the T-169 question; no leaves it unlinked, only yes links it", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    const { putRecord } = await import("./local/records.ts");
    const { createOutputDefinition } = await import("./local/work.ts");
    const goalId = crypto.randomUUID();
    await putRecord(services.db, PRODUCT_REGISTRY, "goals", goalId, { name: "Lift", description: "", projectId: null, startDate: "2026-10-01", deadline: null, kind: "output", target: 500, unit: "kgs", status: "active", archivedAt: null });
    const words = await createOutputDefinition(services.db, { name: "Writing", unit: "words" });
    const kg = await createOutputDefinition(services.db, { name: "Lifting", unit: "kg" });
    await navTo("Goals");
    fireEvent.click(await screen.findByRole("button", { name: "Open goal: Lift" }));
    const migration = await screen.findByTestId("goal-migration");
    const select = within(migration).getByLabelText("Output definition") as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(3)); // definitions load through a live query
    fireEvent.change(select, { target: { value: words } });
    fireEvent.click(within(migration).getByRole("button", { name: "Connect" }));
    // "kgs" and "words" are not listed forms of one unit and not in different scripts: the owner is asked.
    let question = await within(migration).findByTestId("unit-question");
    expect(question.textContent).toContain("only the singular and plural forms of the same unit");
    fireEvent.click(within(question).getByRole("button", { name: "No" }));
    expect((await within(migration).findByRole("alert")).textContent).toContain("Not connected");
    expect((await loadGoals(services.db)).goals[0]!.data).not.toHaveProperty("definitionId");

    fireEvent.change(within(migration).getByLabelText("Output definition"), { target: { value: kg } });
    fireEvent.click(within(migration).getByRole("button", { name: "Connect" }));
    question = await within(migration).findByTestId("unit-question");
    expect(question.textContent).toContain("not for a translation, a synonym, or a different or convertible unit");
    fireEvent.click(within(question).getByRole("button", { name: "Yes, the same unit" }));
    await waitFor(async () => expect((await loadGoals(services.db)).goals[0]!.data).toMatchObject({ definitionId: kg, unit: "kgs", target: 500 }));
    await waitFor(() => expect(screen.queryByTestId("goal-migration")).toBeNull());
  });

  it("the Work screen is translated in Persian (RTL)", async () => {
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await updateSharedPreferences(services.db, { timeZone: "Asia/Tehran" });
    await goTo("Settings");
    fireEvent.change(await screen.findByLabelText("Language"), { target: { value: "fa" } });
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
    await navTo("کار");
    expect(await screen.findByRole("heading", { level: 1, name: "کار" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "شروع جلسه" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "تعریف‌های خروجی" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "سطل بازیافت" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "شروع" }));
    expect(await screen.findByRole("heading", { name: "جلسه‌ی جاری" })).toBeTruthy();
    expect(await screen.findByText("در حال اجرا")).toBeTruthy();
  });
});
