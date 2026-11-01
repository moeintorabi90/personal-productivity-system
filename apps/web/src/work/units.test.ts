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

  it("«ها» joined directly is a listed form only after a letter that does not join the next one; otherwise the owner is asked (T-167, T-169)", () => {
    // Stems ending in ا د ذ ر ز ژ و: the joined spelling is the plural, as are the other two.
    for (const stem of ["روز", "سطر", "مورد", "کیلومتر", "متر", "ویدیو", "بند"]) {
      for (const plural of [`${stem}ها`, `${stem}${ZWNJ}ها`, `${stem} ها`]) {
        expect(matchUnits(stem, plural), plural).toBe("match");
        expect(matchUnits(plural, stem), plural).toBe("match");
      }
    }
    // Stems ending in a joining letter: the joined spelling is not recognized with confidence.
    for (const stem of ["صفحه", "کلمه", "هفته", "ماه", "ساعت", "سال", "درس", "کتاب", "قدم", "لیوان", "داستان", "نامه"]) {
      expect(matchUnits(stem, `${stem}ها`), `${stem}ها`).toBe("unknown");
      expect(matchUnits(`${stem}ها`, stem), `${stem}ها`).toBe("unknown");
      expect(matchUnits(stem, `${stem}${ZWNJ}ها`), stem).toBe("match");
      expect(matchUnits(stem, `${stem} ها`), stem).toBe("match");
    }
    expect(matchUnits("سالها", "روز")).toBe("unknown"); // never a confident mismatch from an unlisted form either
    expect(matchUnits("فصل درس", "فصل درسها")).toBe("unknown"); // the same inside a compound label
    const joined = listedUnitForms().filter((f) => /^[؀-ۿ]+ها$/.test(f));
    expect(joined.map((f) => f.slice(0, -2)).sort()).toEqual(["بند", "روز", "سطر", "کیلومتر", "متر", "مورد", "ویدیو"].sort());
  });

  it("the reviewed list has no form under two units and no unit mixing English and Persian", () => {
    const forms = listedUnitForms();
    expect(new Set(forms).size).toBe(forms.length);
    for (const form of forms) expect(/[A-Za-z]/.test(form) && /[؀-ۿ]/.test(form)).toBe(false);
  });
});
