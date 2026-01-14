export function normalizeSlug(input) {
  const s = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!s || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) {
    const err = new Error("INVALID_SLUG");
    err.statusCode = 400;
    throw err;
  }
  return s;
}

export function joinFullSlug(parentFullSlug, slug) {
  if (!parentFullSlug) return slug;
  return `${parentFullSlug}/${slug}`;
}
