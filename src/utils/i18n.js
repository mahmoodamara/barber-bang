// src/utils/i18n.js

/**
 * Normalize language to one of: "he" | "ar"
 * Default: "he"
 */
export function pickLang(reqLang) {
  const l = String(reqLang || "he").trim().toLowerCase();
  return l === "ar" ? "ar" : "he";
}

/**
 * pickLangValue(lang, obj, keyBase)
 * Returns obj[keyBase+"He"] or obj[keyBase+"Ar"] based on lang.
 * Fallback order:
 *  - requested language key
 *  - other language key
 *  - legacy/base key (obj[keyBase])
 *  - empty string
 *
 * Example:
 *  pickLangValue("ar", product, "title") => product.titleAr || product.titleHe || product.title
 */
export function pickLangValue(lang, obj, keyBase) {
  if (!obj) return "";
  const l = pickLang(lang);

  const heKey = `${keyBase}He`;
  const arKey = `${keyBase}Ar`;

  if (l === "ar") return obj[arKey] || obj[heKey] || obj[keyBase] || "";
  return obj[heKey] || obj[arKey] || obj[keyBase] || "";
}

/**
 * Legacy helper (kept for compatibility across routes)
 * Picks bilingual fields:
 *  - baseHe/baseAr if present
 *  - falls back to base
 */
export function t(doc, base, lang = "he") {
  return pickLangValue(lang, doc, base);
}

/**
 * Apply localized fields to a plain object:
 * mappings: [{ from: "title", to: "title" }, { from:"description", to:"description" }]
 *
 * Returns new object with unified keys:
 *  - title / description / name / address ... depending on mappings
 */
export function withLocalizedFields(doc, lang, mappings) {
  const out = { ...(doc || {}) };

  for (const m of mappings) {
    out[m.to] = t(doc, m.from, lang);
  }

  return out;
}
