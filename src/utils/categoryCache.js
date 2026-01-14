const TREE_CACHE_TTL_MS = 30_000;
const SLUG_CACHE_TTL_MS = 30_000;

const treeCache = new Map();
const slugCache = new Map();

function getCache(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function getCategoryTreeCache(key) {
  return getCache(treeCache, key);
}

export function setCategoryTreeCache(key, value) {
  setCache(treeCache, key, value, TREE_CACHE_TTL_MS);
}

export function clearCategoryTreeCache() {
  treeCache.clear();
}

export function getCategorySlugCache(key) {
  return getCache(slugCache, key);
}

export function setCategorySlugCache(key, value) {
  setCache(slugCache, key, value, SLUG_CACHE_TTL_MS);
}

export function clearCategorySlugCache() {
  slugCache.clear();
}

export function clearCategoryCaches() {
  clearCategoryTreeCache();
  clearCategorySlugCache();
}
