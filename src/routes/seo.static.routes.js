// src/routes/seo.static.routes.js
// Sitemap XML and robots.txt endpoints (raw output, no JSON envelope).

import express from "express";

import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { ContentPage } from "../models/ContentPage.js";

import { STORE_BASE_URL, escapeXml, toW3CDate } from "../utils/seo.js";

const router = express.Router();

// Sitemap limits (Google allows up to 50,000 URLs per sitemap)
const SITEMAP_PRODUCTS_LIMIT = 10000;
const SITEMAP_CATEGORIES_LIMIT = 5000;
const SITEMAP_PAGES_LIMIT = 1000;

// ============================================================
// robots.txt
// ============================================================

/**
 * GET /robots.txt
 * Returns robots.txt content
 */
router.get("/robots.txt", (_req, res) => {
  const baseUrl = STORE_BASE_URL;

  const content = `# robots.txt for ${baseUrl}
User-agent: *
Allow: /

# Sitemaps
Sitemap: ${baseUrl}/sitemap.xml

# Disallow admin and API paths
Disallow: /api/
Disallow: /api
Disallow: /admin/
Disallow: /admin

# Disallow cart and checkout paths
Disallow: /cart
Disallow: /checkout

# Allow search engines to crawl product and category pages
Allow: /product/
Allow: /category/
Allow: /page/
`;

  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=3600");
  res.send(content);
});

// ============================================================
// Sitemap Index
// ============================================================

/**
 * GET /sitemap.xml
 * Returns sitemap index pointing to individual sitemaps
 */
router.get("/sitemap.xml", async (_req, res) => {
  try {
    const baseUrl = STORE_BASE_URL;
    const now = toW3CDate(new Date());

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${escapeXml(baseUrl)}/sitemap-products.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${escapeXml(baseUrl)}/sitemap-categories.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${escapeXml(baseUrl)}/sitemap-pages.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
</sitemapindex>`;

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=600");
    res.send(xml);
  } catch (e) {
    console.error("[sitemap] index error:", e);
    res.status(500).set("Content-Type", "text/plain").send("Sitemap generation error");
  }
});

// ============================================================
// Products Sitemap
// ============================================================

/**
 * GET /sitemap-products.xml
 * Returns sitemap for all active products
 */
router.get("/sitemap-products.xml", async (_req, res) => {
  try {
    const products = await Product.find({
      isActive: true,
      isDeleted: { $ne: true },
    })
      .select("slug updatedAt images imageUrl")
      .sort({ updatedAt: -1 })
      .limit(SITEMAP_PRODUCTS_LIMIT)
      .lean();

    const baseUrl = STORE_BASE_URL;

    const urls = products.map((p) => {
      const loc = `${baseUrl}/product/${escapeXml(p.slug)}`;
      const lastmod = toW3CDate(p.updatedAt);

      // Get primary image for image sitemap
      let imageUrl = null;
      if (Array.isArray(p.images) && p.images.length > 0) {
        const primary = p.images.find((img) => img.isPrimary) || p.images[0];
        imageUrl = primary?.secureUrl || primary?.url;
      }
      imageUrl = imageUrl || p.imageUrl;

      let urlXml = `  <url>
    <loc>${loc}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>`;

      if (lastmod) {
        urlXml += `
    <lastmod>${lastmod}</lastmod>`;
      }

      // Add image to sitemap if available
      if (imageUrl) {
        urlXml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
    </image:image>`;
      }

      urlXml += `
  </url>`;

      return urlXml;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.join("\n")}
</urlset>`;

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=600");
    res.send(xml);
  } catch (e) {
    console.error("[sitemap] products error:", e);
    res.status(500).set("Content-Type", "text/plain").send("Sitemap generation error");
  }
});

// ============================================================
// Categories Sitemap
// ============================================================

/**
 * GET /sitemap-categories.xml
 * Returns sitemap for all active categories
 */
router.get("/sitemap-categories.xml", async (_req, res) => {
  try {
    const categories = await Category.find({ isActive: true })
      .select("slug updatedAt imageUrl bannerUrl")
      .sort({ updatedAt: -1 })
      .limit(SITEMAP_CATEGORIES_LIMIT)
      .lean();

    const baseUrl = STORE_BASE_URL;

    const urls = categories.map((c) => {
      const loc = `${baseUrl}/category/${escapeXml(c.slug)}`;
      const lastmod = toW3CDate(c.updatedAt);
      const imageUrl = c.bannerUrl || c.imageUrl;

      let urlXml = `  <url>
    <loc>${loc}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>`;

      if (lastmod) {
        urlXml += `
    <lastmod>${lastmod}</lastmod>`;
      }

      if (imageUrl) {
        urlXml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
    </image:image>`;
      }

      urlXml += `
  </url>`;

      return urlXml;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.join("\n")}
</urlset>`;

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=600");
    res.send(xml);
  } catch (e) {
    console.error("[sitemap] categories error:", e);
    res.status(500).set("Content-Type", "text/plain").send("Sitemap generation error");
  }
});

// ============================================================
// Pages Sitemap
// ============================================================

/**
 * GET /sitemap-pages.xml
 * Returns sitemap for all active content pages + homepage
 */
router.get("/sitemap-pages.xml", async (_req, res) => {
  try {
    const pages = await ContentPage.find({ isActive: true })
      .select("slug updatedAt")
      .sort({ sortOrder: 1, updatedAt: -1 })
      .limit(SITEMAP_PAGES_LIMIT)
      .lean();

    const baseUrl = STORE_BASE_URL;

    // Start with homepage
    const urls = [
      `  <url>
    <loc>${escapeXml(baseUrl)}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`,
    ];

    // Add content pages
    for (const p of pages) {
      const loc = `${baseUrl}/page/${escapeXml(p.slug)}`;
      const lastmod = toW3CDate(p.updatedAt);

      let urlXml = `  <url>
    <loc>${loc}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>`;

      if (lastmod) {
        urlXml += `
    <lastmod>${lastmod}</lastmod>`;
      }

      urlXml += `
  </url>`;

      urls.push(urlXml);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=600");
    res.send(xml);
  } catch (e) {
    console.error("[sitemap] pages error:", e);
    res.status(500).set("Content-Type", "text/plain").send("Sitemap generation error");
  }
});

export default router;
