export function getLang(req) {
  const v = req?.lang;
  if (v === "he" || v === "ar") return v;
  return "he";
}

export function pickLocalized(obj, lang, fieldBase) {
  const he = obj?.[`${fieldBase}He`];
  const ar = obj?.[`${fieldBase}Ar`];
  return lang === "ar" ? ar || he || "" : he || ar || "";
}

export function localizeCategory(cat, lang) {
  return {
    id: cat.id,
    name: pickLocalized(cat, lang, "name"),
    slug: cat.slug,
    fullSlug: cat.fullSlug,
    parentId: cat.parentId,
    ancestors: cat.ancestors,
    level: cat.level,
    sortOrder: cat.sortOrder,
    isActive: cat.isActive,
  };
}

export function localizeProduct(prod, lang) {
  return {
    id: prod.id,
    name: pickLocalized(prod, lang, "name"),
    description: pickLocalized(prod, lang, "description"),
    brand: prod.brand,
    categoryIds: prod.categoryIds,
    images: prod.images,
    slug: prod.slug,
    isActive: prod.isActive,
    createdAt: prod.createdAt,
    updatedAt: prod.updatedAt,
  };
}
