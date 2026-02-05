/**
 * Shared product helpers used by routes and Product model.
 * Single source of truth for pricing, attributes, and sale logic.
 */

export function toMinorSafe(major) {
  const n = Number(major || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

export function normalizeKey(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (!v) return "";
  return v
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Used by Product model for variantKey building. */
export function normalizeKeyPart(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s ? s.replace(/\s+/g, "_") : "";
}

export function buildLegacyAttributes(variant) {
  if (!variant) return [];
  const legacy = [
    { key: "volume_ml", type: "number", value: variant.volumeMl, unit: "ml" },
    { key: "weight_g", type: "number", value: variant.weightG, unit: "g" },
    { key: "pack_count", type: "number", value: variant.packCount, unit: "" },
    { key: "scent", type: "text", value: variant.scent },
    { key: "hold_level", type: "text", value: variant.holdLevel },
    { key: "finish_type", type: "text", value: variant.finishType },
    { key: "skin_type", type: "text", value: variant.skinType },
  ];

  return legacy
    .map((a) => {
      if (a.type === "number") {
        const n = Number(a.value);
        if (!Number.isFinite(n)) return null;
        return { ...a, value: n };
      }
      const s = String(a.value || "").trim();
      if (!s) return null;
      return { ...a, value: s };
    })
    .filter(Boolean);
}

export function normalizeAttributesInput(attrs) {
  const list = Array.isArray(attrs) ? attrs : [];
  return list
    .map((a) => ({
      key: normalizeKey(a?.key),
      type: String(a?.type || ""),
      value: a?.value ?? null,
      valueKey: normalizeKey(a?.valueKey),
      unit: String(a?.unit || ""),
    }))
    .filter((a) => a.key);
}

export function mergeAttributesWithLegacy(variant) {
  const attrs = normalizeAttributesInput(variant?.attributes);
  const keys = new Set(attrs.map((a) => a.key));
  for (const la of buildLegacyAttributes(variant)) {
    if (!keys.has(la.key)) attrs.push(la);
  }
  return attrs;
}

export function legacyAttributesObject(list) {
  const obj = {
    volumeMl: null,
    weightG: null,
    packCount: null,
    scent: "",
    holdLevel: "",
    finishType: "",
    skinType: "",
  };

  for (const a of list || []) {
    const key = String(a?.key || "");
    const val = a?.value;
    if (key === "volume_ml" && Number.isFinite(Number(val))) obj.volumeMl = Number(val);
    if (key === "weight_g" && Number.isFinite(Number(val))) obj.weightG = Number(val);
    if (key === "pack_count" && Number.isFinite(Number(val))) obj.packCount = Number(val);
    if (key === "scent" && typeof val === "string") obj.scent = val;
    if (key === "hold_level" && typeof val === "string") obj.holdLevel = val;
    if (key === "finish_type" && typeof val === "string") obj.finishType = val;
    if (key === "skin_type" && typeof val === "string") obj.skinType = val;
  }

  return obj;
}

/**
 * Sale is active when: salePrice set, salePrice < price, and within optional date window.
 */
export function isSaleActiveByPrice(p, now = new Date()) {
  if (p?.salePrice == null) return false;
  if (!(Number(p.salePrice) < Number(p.price))) return false;
  if (p.saleStartAt && now < new Date(p.saleStartAt)) return false;
  if (p.saleEndAt && now > new Date(p.saleEndAt)) return false;
  return true;
}
