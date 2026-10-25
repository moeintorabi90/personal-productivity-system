/**
 * Project colors (docs/TESTING.md "Stage 3 follow-up: project colors" 5 and 7; DECISIONS T-068,
 * T-088, "Contrast requirements"). The contrast checks read the app's real theme tokens and palette
 * values from styles.css, so a changed value is re-checked automatically.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultColorOf, fnv1a32, itemColor, PALETTE_IDS, projectColor } from "./colors.ts";

describe("palette and default color (T-088)", () => {
  it("has exactly the 8 stable identifiers in the documented order", () => {
    expect(PALETTE_IDS).toEqual(["blue", "teal", "green", "amber", "orange", "red", "pink", "purple"]);
  });

  it("FNV-1a 32-bit matches the reference vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("the default is index FNV-1a(lowercase project ID) mod 8: deterministic and case-insensitive", () => {
    const id = "6F9619FF-8B86-4011-B42D-00C04FC964FF";
    const expected = PALETTE_IDS[fnv1a32(id.toLowerCase()) % 8];
    expect(defaultColorOf(id)).toBe(expected);
    expect(defaultColorOf(id.toLowerCase())).toBe(expected);
    // Many IDs spread over several palette entries (not all one color).
    const seen = new Set(Array.from({ length: 64 }, (_, i) => defaultColorOf(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)));
    expect(seen.size).toBeGreaterThan(4);
  });

  it("a chosen color wins over the default; items resolve through the task's CURRENT project, else the snapshot's, else neutral", () => {
    const p1 = "11111111-1111-4111-8111-111111111111";
    const p2 = "22222222-2222-4222-8222-222222222222";
    const gone = "33333333-3333-4333-8333-333333333333";
    expect(projectColor(p1, { color: "pink" })).toBe("pink");
    expect(projectColor(p1, {})).toBe(defaultColorOf(p1));
    const projects = new Map([
      [p1, { color: "red" as const }],
      [p2, {}],
    ]);
    const tasks = new Map([
      ["t-in-p1", { projectId: p1 }],
      ["t-inbox", { projectId: null }],
    ]);
    expect(itemColor({ taskId: "t-in-p1", snapshotProjectId: p2 }, tasks, projects)).toBe("red"); // current project, not the snapshot
    expect(itemColor({ taskId: "t-inbox", snapshotProjectId: p1 }, tasks, projects)).toBe("neutral");
    expect(itemColor({ taskId: "t-missing", snapshotProjectId: p2 }, tasks, projects)).toBe(defaultColorOf(p2));
    expect(itemColor({ taskId: "t-missing", snapshotProjectId: p1 }, tasks, projects)).toBe("red");
    expect(itemColor({ taskId: "t-missing", snapshotProjectId: gone }, tasks, projects)).toBe(defaultColorOf(gone));
    expect(itemColor({ taskId: "t-missing", snapshotProjectId: null }, tasks, projects)).toBe("neutral");
  });
});

/* ---------- contrast against the real theme tokens (WCAG 2.x) ---------- */

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Custom properties declared directly in the rule whose selector starts with `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  light: tokens(":root"),
  "dark (chosen)": tokens(':root[data-theme="dark"]'),
  "dark (system)": tokens('  :root[data-theme="system"]'.trim()),
};

describe("contrast requirements (DECISIONS 'Contrast requirements'; TESTING 7)", () => {
  it("both dark rules declare the same tokens, and every palette entry plus neutral has an accent and a tint", () => {
    expect(THEMES["dark (system)"]).toEqual(THEMES["dark (chosen)"]);
    for (const theme of Object.values(THEMES)) {
      for (const key of [...PALETTE_IDS, "neutral"]) {
        expect(theme[`pal-${key}-accent`], key).toMatch(/^#/);
        expect(theme[`pal-${key}-tint`], key).toMatch(/^#/);
      }
    }
  });

  for (const [name, t] of Object.entries(THEMES)) {
    it(`${name}: text on tint ≥ 4.5:1; accents ≥ 3:1 against tint and calendar surfaces; accent text ≥ 4.5:1`, () => {
      const failures: string[] = [];
      const check = (label: string, ratio: number, min: number) => {
        if (ratio < min) failures.push(`${label}: ${ratio.toFixed(2)} < ${min}`);
      };
      for (const key of [...PALETTE_IDS, "neutral"]) {
        const accent = t[`pal-${key}-accent`]!;
        const tint = t[`pal-${key}-tint`]!;
        check(`${key} text on tint`, contrast(t.text!, tint), 4.5);
        for (const [surface, value] of [["tint", tint], ["--surface", t.surface!], ["--surface-muted", t["surface-muted"]!]] as const) {
          check(`${key} accent marker vs ${surface}`, contrast(accent, value), 3);
          check(`${key} accent text on ${surface}`, contrast(accent, value), 4.5);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
