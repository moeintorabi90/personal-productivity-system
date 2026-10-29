/**
 * Unit matching for legacy output-goal migration (DECISIONS T-165 to T-169; derived T-167).
 *
 * Conservative and local: no dependency, no network, no guessing. Two labels are compared after
 * removing only the harmless differences decided so far — surrounding spaces and English letter
 * case. Persian spelling variants (Arabic and Persian forms of ی/ک, a zero-width non-joiner
 * versus a space) are NOT normalized; where both spellings of a plural are common they are listed
 * as separate forms of the same unit below. A reviewed list of singular and plural forms (regular
 * and irregular, English and Persian) recognizes plurals (T-168).
 *
 * Results:
 * - `match`: equal after the harmless differences, or forms of the same listed unit;
 * - `mismatch`: recognized with confidence as different units: both are listed forms of different
 *   units (also synonyms, which are separate entries), or the labels are written in different
 *   scripts, so one cannot be the singular or plural of the other (a translation, e.g. page/صفحه);
 * - `unknown`: anything else (an unlisted or ambiguous form, an abbreviation, a compound label that
 *   cannot be analyzed): the app asks the owner the T-169 question and never guesses.
 */

export type UnitMatch = "match" | "mismatch" | "unknown";

/** English units: every form of one unit (singular first). Irregular plurals are listed explicitly. */
const ENGLISH_UNITS: readonly (readonly string[])[] = [
  ["page", "pages"],
  ["word", "words"],
  ["minute", "minutes"],
  ["hour", "hours"],
  ["second", "seconds"],
  ["day", "days"],
  ["week", "weeks"],
  ["month", "months"],
  ["year", "years"],
  ["chapter", "chapters"],
  ["lesson", "lessons"],
  ["article", "articles"],
  ["session", "sessions"],
  ["exercise", "exercises"],
  ["problem", "problems"],
  ["question", "questions"],
  ["card", "cards"],
  ["flashcard", "flashcards"],
  ["sentence", "sentences"],
  ["line", "lines"],
  ["paragraph", "paragraphs"],
  ["verse", "verses"],
  ["item", "items"],
  ["task", "tasks"],
  ["video", "videos"],
  ["episode", "episodes"],
  ["book", "books"],
  ["essay", "essays"],
  ["post", "posts"],
  ["email", "emails"],
  ["call", "calls"],
  ["meeting", "meetings"],
  ["step", "steps"],
  ["rep", "reps"],
  ["set", "sets"],
  ["kilometer", "kilometers"],
  ["kilometre", "kilometres"],
  ["mile", "miles"],
  ["meter", "meters"],
  ["metre", "metres"],
  ["kilogram", "kilograms"],
  ["calorie", "calories"],
  ["glass", "glasses"],
  ["cup", "cups"],
  ["note", "notes"],
  ["slide", "slides"],
  ["recording", "recordings"],
  ["foot", "feet"],
  ["person", "people"],
  ["child", "children"],
  ["story", "stories"],
  ["entry", "entries"],
  ["activity", "activities"],
  ["copy", "copies"],
  ["summary", "summaries"],
  ["diary", "diaries"],
  ["index", "indices", "indexes"],
  ["appendix", "appendices", "appendixes"],
  ["analysis", "analyses"],
  ["thesis", "theses"],
  ["datum", "data"],
  ["medium", "media"],
  ["criterion", "criteria"],
  ["phenomenon", "phenomena"],
  ["leaf", "leaves"],
  ["half", "halves"],
  ["tooth", "teeth"],
  ["mouse", "mice"],
];

/**
 * Persian units: singular, irregular (broken or Arabic) plurals, and the regular plural with
 * «ها» written with a zero-width non-joiner, with a space, and joined (for stems whose last letter
 * does not join, joining is the usual spelling). Only listed stems get these forms.
 */
const PERSIAN_UNITS: readonly { singular: string; irregular?: readonly string[] }[] = [
  { singular: "صفحه", irregular: ["صفحات"] },
  { singular: "کلمه", irregular: ["کلمات"] },
  { singular: "واژه", irregular: ["واژگان"] },
  { singular: "دقیقه", irregular: ["دقایق"] },
  { singular: "ساعت", irregular: ["ساعات"] },
  { singular: "ثانیه" },
  { singular: "روز" },
  { singular: "هفته" },
  { singular: "ماه" },
  { singular: "سال" },
  { singular: "فصل", irregular: ["فصول"] },
  { singular: "درس", irregular: ["دروس"] },
  { singular: "مقاله", irregular: ["مقالات"] },
  { singular: "جلسه", irregular: ["جلسات"] },
  { singular: "تمرین", irregular: ["تمرینات"] },
  { singular: "مسئله", irregular: ["مسائل"] },
  { singular: "جمله", irregular: ["جملات"] },
  { singular: "سطر", irregular: ["سطور"] },
  { singular: "بیت", irregular: ["ابیات"] },
  { singular: "کتاب", irregular: ["کتب"] },
  { singular: "ویدیو" },
  { singular: "قسمت" },
  { singular: "کارت" },
  { singular: "مورد", irregular: ["موارد"] },
  { singular: "کیلومتر" },
  { singular: "متر" },
  { singular: "قدم" },
  { singular: "لیوان" },
  { singular: "یادداشت" },
  { singular: "بند" },
  { singular: "پاراگراف" },
  { singular: "نامه" },
  { singular: "داستان" },
];

const ZWNJ = "‌";

function persianForms(entry: { singular: string; irregular?: readonly string[] }): string[] {
  const s = entry.singular;
  return [s, `${s}${ZWNJ}ها`, `${s} ها`, `${s}ها`, ...(entry.irregular ?? [])];
}

/** form → unit key (one key per listed unit). A form listed under two units would be ambiguous: none is. */
const FORMS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const add = (forms: readonly string[], key: string) => {
    for (const form of forms) {
      if (map.has(form) && map.get(form) !== key) throw new Error(`unit form listed twice: ${form}`);
      map.set(form, key);
    }
  };
  for (const forms of ENGLISH_UNITS) add(forms, `en:${forms[0]}`);
  for (const entry of PERSIAN_UNITS) add(persianForms(entry), `fa:${entry.singular}`);
  return map;
})();

/** Every listed form (for tests and review). */
export function listedUnitForms(): string[] {
  return [...FORMS.keys()];
}

/** The only harmless differences decided so far: surrounding spaces and English letter case. */
export function normalizeUnit(label: string): string {
  return label.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

type Script = "latin" | "arabic" | "other";

function scriptOf(text: string): Script | "mixed" | "none" {
  let found: Script | null = null;
  for (const ch of text) {
    const script: Script | null = /[A-Za-z]/.test(ch) ? "latin" : /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(ch) ? "arabic" : /[\s\d‌.,\-/()]/.test(ch) ? null : "other";
    if (script === null) continue;
    if (found && found !== script) return "mixed";
    found = script;
  }
  return found ?? "none";
}

function unitKey(word: string): string | undefined {
  return FORMS.get(word);
}

/** Compares one listed-or-not word pair. */
function compareWords(a: string, b: string): UnitMatch {
  if (a === b) return "match";
  const ka = unitKey(a);
  const kb = unitKey(b);
  if (ka && kb) return ka === kb ? "match" : "mismatch";
  return "unknown";
}

/**
 * Compares a legacy goal's unit with a definition's unit (T-166 to T-169). See the module comment
 * for the three results. A compound label matches only when every word is equal except one pair
 * of forms of the same listed unit; a listed Persian plural written with a space is one word.
 */
export function matchUnits(goalUnit: string, definitionUnit: string): UnitMatch {
  const a = normalizeUnit(goalUnit);
  const b = normalizeUnit(definitionUnit);
  if (a === b) return "match";
  const whole = compareWords(a, b);
  if (whole !== "unknown") return whole;
  const sa = scriptOf(a);
  const sb = scriptOf(b);
  if ((sa === "latin" || sa === "arabic") && (sb === "latin" || sb === "arabic") && sa !== sb) return "mismatch";
  // Compound labels: same number of words, exactly one differing word pair.
  const wa = a.split(/\s+/);
  const wb = b.split(/\s+/);
  if (wa.length !== wb.length || wa.length < 2) return "unknown";
  const differing = wa.map((w, i) => [w, wb[i]!] as const).filter(([x, y]) => x !== y);
  if (differing.length !== 1) return "unknown";
  return compareWords(differing[0]![0], differing[0]![1]);
}
