import type { SessionResponse } from "@pps/shared";
import type { LocalDb } from "../local/db.ts";
import { clearSession, getDevice, loadPreferences, renameDevice, storeSession } from "../local/repository.ts";
import type { ApiClient } from "./api-client.ts";
import type { SyncEngine } from "./sync-engine.ts";

export interface Credentials {
  email: string;
  password: string;
  deviceName: string;
}

async function adoptSession(db: LocalDb, engine: SyncEngine, res: SessionResponse): Promise<void> {
  await storeSession(
    db,
    { token: res.token, expiresAt: res.expiresAt, ownerId: res.owner.id, email: res.owner.email },
    res.preferences,
  );
  await engine.refreshSession();
  engine.requestSync(0);
}

/** First-run owner setup. This device's current preferences become the account's initial preferences. */
export async function createOwnerAccount(
  db: LocalDb,
  api: ApiClient,
  engine: SyncEngine,
  input: Credentials & { setupToken?: string },
): Promise<void> {
  await renameDevice(db, input.deviceName);
  const device = await getDevice(db);
  const prefs = await loadPreferences(db);
  const res = await api.setup(
    { email: input.email, password: input.password, device, preferences: prefs.data },
    input.setupToken || undefined,
  );
  await adoptSession(db, engine, res);
}

/** Signs in an additional device. The account's preferences replace this device's local ones. */
export async function signIn(db: LocalDb, api: ApiClient, engine: SyncEngine, input: Credentials): Promise<void> {
  await renameDevice(db, input.deviceName);
  const device = await getDevice(db);
  const res = await api.login({ email: input.email, password: input.password, device });
  await adoptSession(db, engine, res);
}

/** Ends the server session (best effort) and stops syncing. Local data stays on the device. */
export async function signOut(db: LocalDb, api: ApiClient, engine: SyncEngine): Promise<void> {
  try {
    await api.logout();
  } catch {
    // Offline or already expired: the local session is still removed.
  }
  await clearSession(db);
  await engine.refreshSession();
}
