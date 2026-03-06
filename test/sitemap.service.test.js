import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUrlSetXml,
  buildSitemapIndexXml,
  splitContentPages,
  isBlogSlug,
} from "../src/services/sitemap.service.js";

test("splitContentPages separates blog and pages by slug rules", () => {
  const config = {
    blogSlugs: new Set(["weekly-roundup"]),
    blogSlugRegex: /^(blog|news)-/i,
    excludedContentSlugs: new Set(["terms"]),
  };

  const rows = [
    { slug: "about", updatedAt: new Date("2026-03-01") },
    { slug: "blog-wax-guide", updatedAt: new Date("2026-03-02") },
    { slug: "weekly-roundup", updatedAt: new Date("2026-03-03") },
    { slug: "terms", updatedAt: new Date("2026-03-04") },
  ];

  const split = splitContentPages(rows, config);

  assert.equal(split.pages.length, 1);
  assert.equal(split.pages[0].slug, "about");

  assert.equal(split.blog.length, 2);
  assert.deepEqual(
    split.blog.map((item) => item.slug).sort(),
    ["blog-wax-guide", "weekly-roundup"],
  );
});

test("isBlogSlug supports explicit and regex matching", () => {
  const config = {
    blogSlugs: new Set(["market-update"]),
    blogSlugRegex: /^blog-/i,
  };

  assert.equal(isBlogSlug("market-update", config), true);
  assert.equal(isBlogSlug("blog-shaving-tips", config), true);
  assert.equal(isBlogSlug("about", config), false);
});

test("buildUrlSetXml includes hreflang namespace and alternates when enabled", () => {
  const xml = buildUrlSetXml(
    [
      {
        loc: "https://example.com/product/test",
        lastmod: "2026-03-06",
        changefreq: "daily",
        priority: 0.9,
        alternates: [
          { hreflang: "he", href: "https://example.com/product/test?lang=he" },
          { hreflang: "ar", href: "https://example.com/product/test?lang=ar" },
          { hreflang: "x-default", href: "https://example.com/product/test" },
        ],
      },
    ],
    true,
  );

  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.match(xml, /hreflang="he"/);
  assert.match(xml, /hreflang="ar"/);
  assert.match(xml, /hreflang="x-default"/);
});

test("buildSitemapIndexXml renders sitemapindex entries", () => {
  const xml = buildSitemapIndexXml([
    {
      loc: "https://example.com/sitemaps/products-1.xml",
      lastmod: "2026-03-06",
    },
    {
      loc: "https://example.com/sitemaps/categories-1.xml",
      lastmod: "2026-03-05",
    },
  ]);

  assert.match(xml, /<sitemapindex/);
  assert.match(xml, /products-1\.xml/);
  assert.match(xml, /categories-1\.xml/);
});
