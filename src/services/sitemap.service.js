import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { ContentPage } from "../models/ContentPage.js";
import { SiteSettings } from "../models/SiteSettings.js";
import { slugifyText } from "../utils/slug.js";
import { STORE_BASE_URL, escapeXml, toW3CDate } from "../utils/seo.js";

const SITEMAP_PROTOCOL_MAX_URLS = 50_000;
const DEFAULT_MAX_URLS_PER_FILE = 5_000;
const DEFAULT_CACHE_SECONDS = 300;
const DEFAULT_BRAND_MIN_PRODUCTS = 1;
const DEFAULT_LANG_QUERY_PARAM = "lang";
const DEFAULT_CHANGEFREQ = "weekly";

const DEFAULT_STATIC_ROUTES = [
  { path: "/", changefreq: "daily", priority: 1.0 },
  { path: "/shop", changefreq: "daily", priority: 0.9 },
  { path: "/brands", changefreq: "weekly", priority: 0.8 },
  { path: "/deals", changefreq: "daily", priority: 0.8 },
  { path: "/bundles", changefreq: "weekly", priority: 0.7 },
  { path: "/shop/best-sellers", changefreq: "daily", priority: 0.8 },
  { path: "/shop/most-popular", changefreq: "daily", priority: 0.8 },
  { path: "/shop/top-rated", changefreq: "weekly", priority: 0.7 },
  { path: "/b2b", changefreq: "weekly", priority: 0.5 },
  { path: "/accessibility", changefreq: "monthly", priority: 0.3 },
];

const DEFAULT_EXCLUDED_PATH_PREFIXES = [
  "/admin",
  "/api",
  "/auth",
  "/cart",
  "/checkout",
  "/login",
  "/register",
  "/me",
  "/wishlist",
  "/order-confirmation",
];

const DEFAULT_FILTER_QUERY_DISALLOWS = [
  "*?*q=",
  "*?*sort=",
  "*?*page=",
  "*?*minPrice=",
  "*?*maxPrice=",
  "*?*inStock=",
  "*?*onSale=",
  "*?*rating_gte=",
  "*?*discount_gte=",
  "*?*categoryId=",
  "*?*brand=",
];

const ALLOWED_SECTIONS = new Set([
  "static",
  "products",
  "categories",
  "brands",
  "pages",
  "blog",
]);

const ALLOWED_CHANGEFREQ = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

const cacheState = {
  manifest: null,
  expiresAt: 0,
  xmlByKey: new Map(),
};

const CONTENT_PAGE_PROJECTION = "slug updatedAt createdAt noindex noIndex metaRobots";
const PRODUCT_PROJECTION = "slug updatedAt createdAt noindex noIndex metaRobots";
const CATEGORY_PROJECTION = "slug updatedAt createdAt noindex noIndex metaRobots";

class SitemapError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePath(path) {
  const raw = String(path || "").trim();
  if (!raw) return "/";
  if (raw === "/") return "/";
  return `/${raw.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function normalizePathPrefix(pathPrefix) {
  const normalized = normalizePath(pathPrefix);
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || STORE_BASE_URL || "").trim();
  const withoutTrailingSlash = raw.replace(/\/+$/, "");
  if (!withoutTrailingSlash) {
    throw new SitemapError(500, "SITEMAP_BASE_URL_MISSING", "STORE_BASE_URL is required");
  }
  return withoutTrailingSlash;
}

function normalizePriority(priority, fallback = 0.5) {
  const value = Number(priority);
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 10) / 10;
}

function normalizeChangefreq(changefreq, fallback = DEFAULT_CHANGEFREQ) {
  const value = String(changefreq || "").trim().toLowerCase();
  if (ALLOWED_CHANGEFREQ.has(value)) return value;
  return fallback;
}

function buildAbsoluteUrl(baseUrl, path) {
  const normalizedPath = normalizePath(path);
  if (normalizedPath === "/") return baseUrl;
  return `${baseUrl}${normalizedPath}`;
}

function encodePathSegment(segment) {
  return encodeURIComponent(String(segment || "").trim());
}

function isLikelyNoIndexDocument(doc) {
  if (!doc || typeof doc !== "object") return false;
  if (doc.noindex === true || doc.noIndex === true) return true;
  const robots = doc.metaRobots;
  if (typeof robots === "string" && robots.toLowerCase().includes("noindex")) {
    return true;
  }
  if (Array.isArray(robots)) {
    return robots.some((item) => String(item || "").toLowerCase().includes("noindex"));
  }
  return false;
}

function isExcludedPath(path, config) {
  const normalized = normalizePath(path);
  return config.excludedPathPrefixes.some((prefix) => {
    if (prefix === "/") return normalized === "/";
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function isContentSlugAllowed(slug, config) {
  const normalized = String(slug || "").trim().toLowerCase();
  if (!normalized) return false;
  if (!/^[\p{L}0-9-]+$/u.test(normalized)) return false;
  if (config.excludedContentSlugs.has(normalized)) return false;
  return true;
}

function resolveBlogSlugRegex(rawRegex) {
  const pattern = String(rawRegex || "").trim();
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function isBlogSlug(slug, config) {
  if (config.blogSlugs.has(slug)) return true;
  if (config.blogSlugRegex && config.blogSlugRegex.test(slug)) return true;
  return false;
}

function getConfig() {
  const baseUrl = normalizeBaseUrl(process.env.STORE_BASE_URL || STORE_BASE_URL);
  const maxUrlsPerFile = parsePositiveInt(
    process.env.SITEMAP_MAX_URLS_PER_FILE,
    DEFAULT_MAX_URLS_PER_FILE,
    SITEMAP_PROTOCOL_MAX_URLS,
  );
  const cacheSeconds = parsePositiveInt(process.env.SITEMAP_CACHE_SECONDS, DEFAULT_CACHE_SECONDS, 86_400);
  const brandMinProducts = parsePositiveInt(
    process.env.SITEMAP_BRAND_MIN_PRODUCTS,
    DEFAULT_BRAND_MIN_PRODUCTS,
    100_000,
  );

  const hreflangs = parseCsv(process.env.SITEMAP_HREFLANG_LANGS || "he,ar");
  const hreflangEnabled = parseBoolean(process.env.SITEMAP_HREFLANG_ENABLED, hreflangs.length > 1);
  const langQueryParam = String(process.env.SITEMAP_LANG_QUERY_PARAM || DEFAULT_LANG_QUERY_PARAM).trim() || DEFAULT_LANG_QUERY_PARAM;

  const contentPagePathPrefix = normalizePathPrefix(process.env.SITEMAP_CONTENT_PAGE_PATH_PREFIX || "/page");
  const blogPagePathPrefix = normalizePathPrefix(process.env.SITEMAP_BLOG_PAGE_PATH_PREFIX || "/page");
  const blogSlugs = new Set(parseCsv(process.env.SITEMAP_BLOG_SLUGS).map((slug) => slug.toLowerCase()));
  const blogSlugRegex = resolveBlogSlugRegex(process.env.SITEMAP_BLOG_SLUG_REGEX || "^(blog|post|article|news)-");

  const staticExcludePaths = new Set(parseCsv(process.env.SITEMAP_EXCLUDED_STATIC_PATHS).map((path) => normalizePath(path)));
  const extraStaticPaths = parseCsv(process.env.SITEMAP_EXTRA_STATIC_PATHS).map((path) => ({
    path: normalizePath(path),
    changefreq: "monthly",
    priority: 0.4,
  }));
  const staticRoutes = [...DEFAULT_STATIC_ROUTES, ...extraStaticPaths].filter(
    (route) => !staticExcludePaths.has(normalizePath(route.path)),
  );

  const excludedPathPrefixes = [
    ...DEFAULT_EXCLUDED_PATH_PREFIXES,
    ...parseCsv(process.env.SITEMAP_EXCLUDE_PATH_PREFIXES).map((path) => normalizePathPrefix(path)),
  ]
    .map((path) => normalizePathPrefix(path))
    .filter(Boolean);

  const excludedContentSlugs = new Set(
    parseCsv(process.env.SITEMAP_EXCLUDED_CONTENT_SLUGS).map((slug) => String(slug).toLowerCase()),
  );

  const robotsDisallowQueryPatterns = [
    ...DEFAULT_FILTER_QUERY_DISALLOWS,
    ...parseCsv(process.env.SITEMAP_ROBOTS_EXTRA_QUERY_DISALLOW),
  ];

  return {
    baseUrl,
    maxUrlsPerFile,
    cacheSeconds,
    brandMinProducts,
    hreflangEnabled,
    hreflangs,
    langQueryParam,
    contentPagePathPrefix,
    blogPagePathPrefix,
    blogSlugs,
    blogSlugRegex,
    staticRoutes,
    excludedPathPrefixes,
    excludedContentSlugs,
    robotsDisallowQueryPatterns,
  };
}

function buildAlternates(canonicalUrl, config) {
  if (!config.hreflangEnabled || !Array.isArray(config.hreflangs) || config.hreflangs.length === 0) {
    return [];
  }

  const alternates = [];
  for (const lang of config.hreflangs) {
    const normalizedLang = String(lang || "").trim().toLowerCase();
    if (!normalizedLang) continue;
    const url = new URL(canonicalUrl);
    url.searchParams.set(config.langQueryParam, normalizedLang);
    alternates.push({
      hreflang: normalizedLang,
      href: url.toString(),
    });
  }

  alternates.push({
    hreflang: "x-default",
    href: canonicalUrl,
  });

  return alternates;
}

function toEntry(path, options, config) {
  if (isExcludedPath(path, config)) return null;

  const loc = buildAbsoluteUrl(config.baseUrl, path);
  const lastmod = toW3CDate(options.lastmod);

  return {
    loc,
    lastmod,
    changefreq: normalizeChangefreq(options.changefreq, DEFAULT_CHANGEFREQ),
    priority: normalizePriority(options.priority, 0.5),
    alternates: buildAlternates(loc, config),
  };
}

function dedupeEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (!entry?.loc) continue;
    if (seen.has(entry.loc)) continue;
    seen.add(entry.loc);
    out.push(entry);
  }
  return out;
}

function getChunkMeta(count, maxUrlsPerFile) {
  const safeCount = Math.max(0, Number(count || 0));
  if (safeCount === 0) return { count: 0, chunkCount: 0 };
  return { count: safeCount, chunkCount: Math.ceil(safeCount / maxUrlsPerFile) };
}

function getMaxDate(dates) {
  let max = null;
  for (const value of dates) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!max || date > max) max = date;
  }
  return max;
}

function buildUrlSetXml(entries, includeHreflang = false) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    includeHreflang
      ? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
      : '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const entry of entries) {
    lines.push("  <url>");
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
    if (entry.lastmod) {
      lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    }
    if (entry.changefreq) {
      lines.push(`    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`);
    }
    if (typeof entry.priority === "number") {
      lines.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
    }
    if (includeHreflang && Array.isArray(entry.alternates)) {
      for (const alt of entry.alternates) {
        if (!alt?.hreflang || !alt?.href) continue;
        lines.push(
          `    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}" />`,
        );
      }
    }
    lines.push("  </url>");
  }

  lines.push("</urlset>");
  return lines.join("\n");
}

function buildSitemapIndexXml(items) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const item of items) {
    lines.push("  <sitemap>");
    lines.push(`    <loc>${escapeXml(item.loc)}</loc>`);
    if (item.lastmod) {
      lines.push(`    <lastmod>${escapeXml(item.lastmod)}</lastmod>`);
    }
    lines.push("  </sitemap>");
  }

  lines.push("</sitemapindex>");
  return lines.join("\n");
}

async function getCollectionStats(Model, match) {
  const rows = await Model.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        lastmod: { $max: "$updatedAt" },
      },
    },
  ]);
  const row = rows[0] || {};
  return {
    count: Number(row.count || 0),
    lastmod: row.lastmod || null,
  };
}

async function getBrandStats(config) {
  const rows = await Product.aggregate([
    {
      $match: {
        isActive: true,
        isDeleted: { $ne: true },
        noindex: { $ne: true },
        noIndex: { $ne: true },
        brand: { $exists: true, $type: "string" },
      },
    },
    {
      $project: {
        updatedAt: 1,
        brandTrim: { $trim: { input: "$brand" } },
      },
    },
    { $match: { brandTrim: { $ne: "" } } },
    {
      $group: {
        _id: { $toLower: "$brandTrim" },
        productCount: { $sum: 1 },
        lastmod: { $max: "$updatedAt" },
      },
    },
    { $match: { productCount: { $gte: config.brandMinProducts } } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        lastmod: { $max: "$lastmod" },
      },
    },
  ]);

  const row = rows[0] || {};
  return {
    count: Number(row.count || 0),
    lastmod: row.lastmod || null,
  };
}

function splitContentPages(rows, config) {
  const pages = [];
  const blog = [];

  for (const row of rows) {
    if (isLikelyNoIndexDocument(row)) continue;
    const slug = String(row?.slug || "").trim().toLowerCase();
    if (!isContentSlugAllowed(slug, config)) continue;

    const item = {
      slug,
      lastmod: row.updatedAt || row.createdAt || null,
    };

    if (isBlogSlug(slug, config)) {
      blog.push(item);
    } else {
      pages.push(item);
    }
  }

  const sortByFreshness = (a, b) => {
    const aTime = a.lastmod ? new Date(a.lastmod).getTime() : 0;
    const bTime = b.lastmod ? new Date(b.lastmod).getTime() : 0;
    if (aTime === bTime) return a.slug.localeCompare(b.slug);
    return bTime - aTime;
  };

  pages.sort(sortByFreshness);
  blog.sort(sortByFreshness);

  return { pages, blog };
}

function buildStaticEntries(config, staticLastmod) {
  const entries = [];
  for (const route of config.staticRoutes) {
    const entry = toEntry(
      route.path,
      {
        lastmod: staticLastmod,
        changefreq: route.changefreq,
        priority: route.priority,
      },
      config,
    );
    if (entry) entries.push(entry);
  }
  return dedupeEntries(entries);
}

async function buildManifest() {
  const config = getConfig();

  const productMatch = {
    isActive: true,
    isDeleted: { $ne: true },
    noindex: { $ne: true },
    noIndex: { $ne: true },
    slug: { $exists: true, $type: "string", $ne: "" },
  };

  const categoryMatch = {
    isActive: true,
    noindex: { $ne: true },
    noIndex: { $ne: true },
    slug: { $exists: true, $type: "string", $ne: "" },
  };

  const [productStats, categoryStats, brandStats, contentRows, siteSettings] = await Promise.all([
    getCollectionStats(Product, productMatch),
    getCollectionStats(Category, categoryMatch),
    getBrandStats(config),
    ContentPage.find({ isActive: true }).select(CONTENT_PAGE_PROJECTION).lean(),
    SiteSettings.findOne().select("updatedAt").lean(),
  ]);

  const contentSplit = splitContentPages(contentRows || [], config);
  const contentPagesLastmod = getMaxDate(contentSplit.pages.map((item) => item.lastmod));
  const blogLastmod = getMaxDate(contentSplit.blog.map((item) => item.lastmod));
  const staticLastmod = siteSettings?.updatedAt || getMaxDate([
    productStats.lastmod,
    categoryStats.lastmod,
    contentPagesLastmod,
    blogLastmod,
  ]) || new Date();
  const staticEntries = buildStaticEntries(config, staticLastmod);

  const sections = [];
  const pushSection = (key, count, lastmod) => {
    const meta = getChunkMeta(count, config.maxUrlsPerFile);
    if (meta.count <= 0) return;
    sections.push({
      key,
      count: meta.count,
      chunkCount: meta.chunkCount,
      lastmod: toW3CDate(lastmod) || toW3CDate(new Date()),
    });
  };

  pushSection("static", staticEntries.length, staticLastmod);
  pushSection("products", productStats.count, productStats.lastmod);
  pushSection("categories", categoryStats.count, categoryStats.lastmod);
  pushSection("brands", brandStats.count, brandStats.lastmod);
  pushSection("pages", contentSplit.pages.length, contentPagesLastmod);
  pushSection("blog", contentSplit.blog.length, blogLastmod);

  const sectionByKey = new Map(sections.map((section) => [section.key, section]));

  return {
    version: Date.now(),
    createdAt: new Date(),
    config,
    productMatch,
    categoryMatch,
    staticEntries,
    contentSplit,
    sections,
    sectionByKey,
  };
}

async function getManifest() {
  const now = Date.now();
  if (cacheState.manifest && now < cacheState.expiresAt) {
    return cacheState.manifest;
  }

  const manifest = await buildManifest();
  cacheState.manifest = manifest;
  cacheState.expiresAt = now + manifest.config.cacheSeconds * 1_000;
  cacheState.xmlByKey.clear();
  return manifest;
}

function getPaging(skipPage, pageSize) {
  const page = parsePositiveInt(skipPage, 1);
  const skip = (page - 1) * pageSize;
  return { page, skip };
}

async function getProductEntries(manifest, page) {
  const { config, productMatch } = manifest;
  const { skip } = getPaging(page, config.maxUrlsPerFile);
  const rows = await Product.find(productMatch)
    .select(PRODUCT_PROJECTION)
    .sort({ updatedAt: -1, _id: 1 })
    .skip(skip)
    .limit(config.maxUrlsPerFile)
    .lean();

  const entries = [];
  for (const row of rows) {
    if (isLikelyNoIndexDocument(row)) continue;
    const slug = String(row.slug || "").trim();
    if (!slug) continue;
    const path = `/product/${encodePathSegment(slug)}`;
    const entry = toEntry(
      path,
      {
        lastmod: row.updatedAt || row.createdAt || null,
        changefreq: "daily",
        priority: 0.9,
      },
      config,
    );
    if (entry) entries.push(entry);
  }
  return dedupeEntries(entries);
}

async function getCategoryEntries(manifest, page) {
  const { config, categoryMatch } = manifest;
  const { skip } = getPaging(page, config.maxUrlsPerFile);
  const rows = await Category.find(categoryMatch)
    .select(CATEGORY_PROJECTION)
    .sort({ updatedAt: -1, _id: 1 })
    .skip(skip)
    .limit(config.maxUrlsPerFile)
    .lean();

  const entries = [];
  for (const row of rows) {
    if (isLikelyNoIndexDocument(row)) continue;
    const slug = String(row.slug || "").trim();
    if (!slug) continue;
    const path = `/category/${encodePathSegment(slug)}`;
    const entry = toEntry(
      path,
      {
        lastmod: row.updatedAt || row.createdAt || null,
        changefreq: "weekly",
        priority: 0.8,
      },
      config,
    );
    if (entry) entries.push(entry);
  }

  return dedupeEntries(entries);
}

async function getBrandEntries(manifest, page) {
  const { config } = manifest;
  const { skip } = getPaging(page, config.maxUrlsPerFile);
  const rows = await Product.aggregate([
    {
      $match: {
        isActive: true,
        isDeleted: { $ne: true },
        noindex: { $ne: true },
        noIndex: { $ne: true },
        brand: { $exists: true, $type: "string" },
      },
    },
    {
      $project: {
        updatedAt: 1,
        brandTrim: { $trim: { input: "$brand" } },
      },
    },
    { $match: { brandTrim: { $ne: "" } } },
    { $sort: { updatedAt: -1, _id: 1 } },
    {
      $group: {
        _id: { $toLower: "$brandTrim" },
        name: { $first: "$brandTrim" },
        productCount: { $sum: 1 },
        lastmod: { $max: "$updatedAt" },
      },
    },
    { $match: { productCount: { $gte: config.brandMinProducts } } },
    { $sort: { lastmod: -1, _id: 1 } },
    { $skip: skip },
    { $limit: config.maxUrlsPerFile },
  ]);

  const entries = [];
  for (const row of rows) {
    const name = String(row?.name || "").trim();
    const slug = slugifyText(name);
    if (!slug) continue;
    const path = `/brands/${encodePathSegment(slug)}`;
    const entry = toEntry(
      path,
      {
        lastmod: row.lastmod || null,
        changefreq: "weekly",
        priority: 0.7,
      },
      config,
    );
    if (entry) entries.push(entry);
  }
  return dedupeEntries(entries);
}

function getStaticEntries(manifest, page) {
  const { config } = manifest;
  const { skip } = getPaging(page, config.maxUrlsPerFile);
  return manifest.staticEntries.slice(skip, skip + config.maxUrlsPerFile);
}

function getContentEntries(manifest, page, bucket) {
  const { config } = manifest;
  const list = bucket === "blog" ? manifest.contentSplit.blog : manifest.contentSplit.pages;
  const { skip } = getPaging(page, config.maxUrlsPerFile);
  const rows = list.slice(skip, skip + config.maxUrlsPerFile);
  const prefix = bucket === "blog" ? config.blogPagePathPrefix : config.contentPagePathPrefix;

  const entries = [];
  for (const row of rows) {
    const path = `${prefix}/${encodePathSegment(row.slug)}`.replace(/\/{2,}/g, "/");
    const entry = toEntry(
      path,
      {
        lastmod: row.lastmod || null,
        changefreq: bucket === "blog" ? "weekly" : "monthly",
        priority: bucket === "blog" ? 0.7 : 0.6,
      },
      config,
    );
    if (entry) entries.push(entry);
  }
  return dedupeEntries(entries);
}

async function buildSectionEntries(manifest, sectionKey, page) {
  switch (sectionKey) {
    case "static":
      return getStaticEntries(manifest, page);
    case "products":
      return getProductEntries(manifest, page);
    case "categories":
      return getCategoryEntries(manifest, page);
    case "brands":
      return getBrandEntries(manifest, page);
    case "pages":
      return getContentEntries(manifest, page, "pages");
    case "blog":
      return getContentEntries(manifest, page, "blog");
    default:
      throw new SitemapError(404, "SITEMAP_SECTION_NOT_FOUND", "Sitemap section not found");
  }
}

function normalizeSectionKey(sectionKey) {
  const key = String(sectionKey || "").trim().toLowerCase();
  if (!ALLOWED_SECTIONS.has(key)) {
    throw new SitemapError(404, "SITEMAP_SECTION_NOT_FOUND", "Sitemap section not found");
  }
  return key;
}

function normalizePageNumber(pageNumber) {
  return parsePositiveInt(pageNumber, 1, 1_000_000);
}

function getSectionOrThrow(manifest, sectionKey) {
  const section = manifest.sectionByKey.get(sectionKey);
  if (!section) {
    throw new SitemapError(404, "SITEMAP_SECTION_NOT_FOUND", "Sitemap section not found");
  }
  return section;
}

function buildSitemapIndexItems(manifest) {
  const items = [];
  for (const section of manifest.sections) {
    for (let page = 1; page <= section.chunkCount; page += 1) {
      const loc = buildAbsoluteUrl(
        manifest.config.baseUrl,
        `/sitemaps/${section.key}-${page}.xml`,
      );
      items.push({
        loc,
        lastmod: section.lastmod,
      });
    }
  }
  return items;
}

function buildCacheKey(manifest, sectionKey, page) {
  return `${manifest.version}:${sectionKey}:${page}`;
}

export async function getSitemapIndexXml() {
  const manifest = await getManifest();
  const indexItems = buildSitemapIndexItems(manifest);
  return buildSitemapIndexXml(indexItems);
}

export async function getSitemapSectionXml(rawSectionKey, rawPageNumber = 1) {
  const manifest = await getManifest();
  const sectionKey = normalizeSectionKey(rawSectionKey);
  const page = normalizePageNumber(rawPageNumber);
  const section = getSectionOrThrow(manifest, sectionKey);

  if (page > section.chunkCount) {
    throw new SitemapError(404, "SITEMAP_PAGE_OUT_OF_RANGE", "Sitemap page out of range");
  }

  const cacheKey = buildCacheKey(manifest, sectionKey, page);
  const cached = cacheState.xmlByKey.get(cacheKey);
  if (cached) return cached;

  const entries = await buildSectionEntries(manifest, sectionKey, page);
  const xml = buildUrlSetXml(entries, manifest.config.hreflangEnabled);
  cacheState.xmlByKey.set(cacheKey, xml);
  return xml;
}

export async function getRobotsTxt() {
  const config = getConfig();
  const lines = [
    "User-agent: *",
    "Allow: /",
    "",
    "# Disallow non-indexable/private routes",
  ];

  for (const prefix of config.excludedPathPrefixes) {
    if (!prefix || prefix === "/") continue;
    lines.push(`Disallow: ${prefix}`);
    if (!prefix.endsWith("/")) {
      lines.push(`Disallow: ${prefix}/`);
    }
  }

  lines.push("");
  lines.push("# Disallow duplicate filter/facet URL combinations");
  for (const pattern of config.robotsDisallowQueryPatterns) {
    lines.push(`Disallow: /${String(pattern || "").replace(/^\/+/, "")}`);
  }

  if (config.hreflangEnabled && config.hreflangs.length > 0) {
    lines.push("");
    lines.push("# Allow hreflang language URLs");
    for (const lang of config.hreflangs) {
      const normalized = String(lang || "").trim().toLowerCase();
      if (!normalized) continue;
      lines.push(`Allow: /*?${config.langQueryParam}=${normalized}`);
    }
  }

  lines.push("");
  lines.push(`# Sitemap: ${buildAbsoluteUrl(config.baseUrl, "/sitemap.xml")}`);

  return `${lines.join("\n")}\n`;
}

export async function getSitemapManifestSummary() {
  const manifest = await getManifest();
  return {
    generatedAt: manifest.createdAt.toISOString(),
    sections: manifest.sections.map((section) => ({
      key: section.key,
      count: section.count,
      chunkCount: section.chunkCount,
      lastmod: section.lastmod,
    })),
    maxUrlsPerFile: manifest.config.maxUrlsPerFile,
  };
}

export function clearSitemapCache() {
  cacheState.manifest = null;
  cacheState.expiresAt = 0;
  cacheState.xmlByKey.clear();
}

export { buildUrlSetXml, buildSitemapIndexXml, splitContentPages, isBlogSlug, getConfig, SitemapError };
