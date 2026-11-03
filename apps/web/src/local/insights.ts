/**
 * Stage 6 records that are not goal plans: app-use dates (T-203 to T-205), dashboards (T-197 to
 * T-201), and the loader of everything the reports read. App-use dates are append-only, one per
 * local date with a derived ID, so two devices write the same record and an import only adds.
 */
import { appUseDayId } from "../backup/derived-id.ts";
import {
  APP_USE_DAYS,
  type AppUseDayData,
  DASHBOARDS,
  type DashboardData,
  MAIN_DASHBOARD_ID,
  NAME_MAX,
  PRODUCT_REGISTRY,
  type Registry,
  TASK_ESTIMATE_CAPTURES,
  type TaskEstimateCaptureData,
} from "../backup/registry.ts";
import { SUGGESTED_MAIN_DASHBOARD } from "../insights/metrics.ts";
import type { LocalDb, RecordRow } from "./db.ts";
import { refreshWeekPlans, todayOf } from "./goal-plans.ts";
import type { Item } from "./organization.ts";
import { deleteRecord, putRecord } from "./records.ts";

export interface InsightRecords {
  appUseDates: string[];
  dashboards: Item<DashboardData>[];
  captures: Item<TaskEstimateCaptureData>[];
}

export async function loadInsightRecords(db: LocalDb): Promise<InsightRecords> {
  return db.transaction("r", db.records, async () => {
    const [days, boards, captures] = await Promise.all([APP_USE_DAYS, DASHBOARDS, TASK_ESTIMATE_CAPTURES].map((type) => db.records.where("type").equals(type).toArray()));
    const item = <T>(r: RecordRow): Item<T> => ({ id: r.id, data: r.data as T, createdAt: r.createdAt, updatedAt: r.updatedAt });
    return {
      appUseDates: days!.map((r) => (r.data as AppUseDayData).date).sort(),
      dashboards: boards!.map((r) => item<DashboardData>(r)),
      captures: captures!.map((r) => item<TaskEstimateCaptureData>(r)),
    };
  });
}

/**
 * Records today's local date as a use date once (T-203): called while the app is visible — when
 * it is first shown, when it becomes visible again, and at local midnight. The same transaction
 * starts the week's plans of running goals the first time the app runs in a week (T-225).
 * Returns the date written, or null when it was already recorded.
 */
export async function recordAppUse(db: LocalDb, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<string | null> {
  return db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const { today } = await todayOf(db, now);
    await refreshWeekPlans(db, registry, "open", now);
    const id = appUseDayId(today);
    if (await db.records.get([APP_USE_DAYS, id])) return null;
    await putRecord(db, registry, APP_USE_DAYS, id, { date: today } satisfies AppUseDayData);
    return today;
  });
}

/* ---------- dashboards (T-197 to T-201) ---------- */

export class DashboardError extends Error {
  readonly code: "NOT_FOUND" | "MAIN_CANNOT_BE_DELETED" | "INVALID_NAME";
  constructor(code: DashboardError["code"], message: string) {
    super(message);
    this.name = "DashboardError";
    this.code = code;
  }
}

/** The main dashboard as stored, or its suggested layout until it is first edited (T-198). */
export function mainDashboard(dashboards: readonly Item<DashboardData>[]): DashboardData {
  return dashboards.find((d) => d.id === MAIN_DASHBOARD_ID)?.data ?? SUGGESTED_MAIN_DASHBOARD;
}

function checkName(name: string): string {
  const n = name.trim();
  if (!n || n.length > NAME_MAX) throw new DashboardError("INVALID_NAME", "a name of 1–200 characters");
  return n;
}

/** Saves a dashboard's name and cards (the main one under its reserved ID). Cards keep their order. */
export async function saveDashboard(db: LocalDb, id: string, data: DashboardData, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await putRecord(db, registry, DASHBOARDS, id, { name: checkName(data.name), cards: data.cards.map((c) => ({ ...c })) });
}

/** Creates an optional dashboard with no cards (T-198). */
export async function createDashboard(db: LocalDb, name: string, registry: Registry = PRODUCT_REGISTRY): Promise<string> {
  const id = crypto.randomUUID();
  await putRecord(db, registry, DASHBOARDS, id, { name: checkName(name), cards: [] } satisfies DashboardData);
  return id;
}

/** Deletes an optional dashboard; the main one cannot be deleted (derived). */
export async function deleteDashboard(db: LocalDb, id: string): Promise<void> {
  if (id === MAIN_DASHBOARD_ID) throw new DashboardError("MAIN_CANNOT_BE_DELETED", "the main dashboard stays");
  if (!(await deleteRecord(db, DASHBOARDS, id))) throw new DashboardError("NOT_FOUND", "no such dashboard");
}
