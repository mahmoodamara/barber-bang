const DEFAULT_MAX_LENGTH = 140;

export function slugifyText(raw = "") {
  const str = String(raw || "").trim();
  if (!str) return "";

  const normalized = str.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = normalized
    .toLowerCase()
    .replace(/[^\p{L}0-9]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) return "";
  return slug.slice(0, DEFAULT_MAX_LENGTH);
}

export async function generateUniqueSlug(Model, rawInput, excludeId) {
  const base = slugifyText(rawInput) || `product-${Date.now().toString(36)}`;
  const trimmedBase = base.slice(0, DEFAULT_MAX_LENGTH);

  const buildCandidate = (suffix = "") => {
    const suffixText = suffix ? `-${suffix}` : "";
    const availableLength = DEFAULT_MAX_LENGTH - suffixText.length;
    return `${trimmedBase.slice(0, availableLength)}${suffixText}`;
  };

  let candidate = buildCandidate();
  let counter = 0;

  const exists = async (value) => {
    const filter = { slug: value };
    if (excludeId) filter._id = { $ne: excludeId };
    return Model.exists(filter);
  };

  while (await exists(candidate)) {
    counter += 1;
    candidate = buildCandidate(counter);
  }

  return candidate;
}
