/**
 * Unit matching at legacy output-goal migration (docs/TESTING.md "Stage 5 acceptance tests" 6;
 * DECISIONS T-166 to T-169, derived T-167): match, mismatch, and unknown — never a guess.
 */
import { describe, expect, it } from "vitest";
import { listedUnitForms, matchUnits, normalizeUnit } from "./units.ts";

const ZWNJ = "‌";

describe("unit matching (T-166 to T-169)", () => {
  it("(a) harmless differences match: surrounding spaces and English letter case (derived)", () => {
    expect(matchUnits(" Pages ", "pages")).toBe("match");
    expect(matchUnits("PAGES", "Pages")).toBe("match");
    expect(matchUnits("صفحه ", " صفحه")).toBe("match");
    expect(normalizeUnit("  Minutes of Content ")).toBe("minutes of content");
  });

  it("(b) singular and plural forms of the same unit match, regular and irregular, English and Persian (T-168)", () => {
    for (const [a, b] of [
      ["page", "pages"],
      ["minute", "Minutes"],
      ["foot", "feet"],
      ["person", "people"],
      ["entry", "entries"],
      ["analysis", "analyses"],
      ["صفحه", `صفحه${ZWNJ}ها`],
      ["صفحه", "صفحه ها"],
      ["صفحه", "صفحات"],
      ["درس", "دروس"],
      ["دقیقه", "دقایق"],
      ["کلمه", "کلمات"],
      ["روز", "روزها"],
      ["minute of content", "minutes of content"],
      ["new word", "new words"],
    ]) {
      expect(matchUnits(a!, b!), `${a} / ${b}`).toBe("match");
      expect(matchUnits(b!, a!), `${b} / ${a}`).toBe("match");
    }
  });

  it("(c) translations, synonyms, and different units — also convertible ones — are refused", () => {
    for (const [a, b] of [
      ["page", "صفحه"], // translation
      ["pages", "صفحات"],
      ["words", "کلمه"],
      ["کلمه", "واژه"], // synonyms
      ["page", "word"],
      ["minute", "hour"], // convertible but different
      ["kilometer", "mile"],
      ["minutes of content", "pages of content"],
    ]) {
      expect(matchUnits(a!, b!), `${a} / ${b}`).toBe("mismatch");
    }
  });

  it("(d) anything the matcher cannot classify is unknown: the owner is asked (T-169)", () => {
    for (const [a, b] of [
      ["kg", "kgs"], // abbreviations are not listed
      ["flashcard", "flash cards"], // different word counts
      ["تن", "تنها"], // not listed: never split «ها» off an unknown stem
      ["صفحه", "صفحهٔ"], // spelling variants are not normalized
      ["كلمه", "کلمات"], // Arabic kāf is not normalized to Persian kāf
      ["new word", "fresh words"], // more than one differing word
    ]) {
      expect(matchUnits(a!, b!), `${a} / ${b}`).toBe("unknown");
    }
  });

  it("the reviewed list has no form under two units and no unit mixing English and Persian", () => {
    const forms = listedUnitForms();
    expect(new Set(forms).size).toBe(forms.length);
    for (const form of forms) expect(/[A-Za-z]/.test(form) && /[؀-ۿ]/.test(form)).toBe(false);
  });
});
