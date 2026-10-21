/** Version vector: device ID → number of edits made on that device (docs/BACKUP_FORMAT.md, T-016). */
export type VersionVector = Record<string, number>;

export type VersionOrder = "equal" | "before" | "after" | "concurrent";

/** Compares `a` with `b`: "before" means a is contained in b (b has seen everything a has). */
export function compareVersions(a: VersionVector, b: VersionVector): VersionOrder {
  let aAhead = false;
  let bAhead = false;
  for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[device] ?? 0;
    const y = b[device] ?? 0;
    if (x > y) aAhead = true;
    if (y > x) bAhead = true;
  }
  if (aAhead && bAhead) return "concurrent";
  if (aAhead) return "after";
  if (bAhead) return "before";
  return "equal";
}

/** True when `a` is contained in `b` (equal or before). */
export function isContainedIn(a: VersionVector, b: VersionVector): boolean {
  const order = compareVersions(a, b);
  return order === "equal" || order === "before";
}

export function mergeVersions(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };
  for (const [device, counter] of Object.entries(b)) out[device] = Math.max(out[device] ?? 0, counter);
  return out;
}

/** A local edit on `deviceId`. */
export function bumpVersion(v: VersionVector, deviceId: string): VersionVector {
  return { ...v, [deviceId]: (v[deviceId] ?? 0) + 1 };
}

/** A local decision that has seen both versions: dominates both `a` and `b`. */
export function mergeAndBump(a: VersionVector, b: VersionVector, deviceId: string): VersionVector {
  return bumpVersion(mergeVersions(a, b), deviceId);
}
