/**
 * Common output units offered as suggestions (DECISIONS T-194; derived "Initial output unit
 * suggestions", not an owner-approved list). Suggestions only fill the definition form: a custom
 * unit is always allowed, and nothing about units is restricted or converted (T-050, T-165).
 */
import type { Language } from "@pps/shared";

const SUGGESTIONS: Record<Language, readonly string[]> = {
  en: ["minute", "hour", "page", "word", "chapter", "lesson", "article", "exercise", "question", "flashcard", "session", "kilometer", "rep"],
  fa: ["دقیقه", "ساعت", "صفحه", "کلمه", "فصل", "درس", "مقاله", "تمرین", "پرسش", "کارت مرور", "جلسه", "کیلومتر", "تکرار"],
};

export function unitSuggestions(language: Language): readonly string[] {
  return SUGGESTIONS[language];
}
