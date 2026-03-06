import express from "express";

import {
  getRobotsTxt,
  getSitemapIndexXml,
  getSitemapSectionXml,
  SitemapError,
} from "../services/sitemap.service.js";

const router = express.Router();

function setXmlHeaders(res) {
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
}

function setTextHeaders(res) {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=1800, stale-while-revalidate=3600");
}

function sendSitemapError(res, error) {
  if (error instanceof SitemapError && error.statusCode === 404) {
    return res
      .status(404)
      .set("Content-Type", "text/plain; charset=utf-8")
      .send("Sitemap not found");
  }
  console.error("[sitemap] generation error:", error);
  return res
    .status(500)
    .set("Content-Type", "text/plain; charset=utf-8")
    .send("Sitemap generation error");
}

router.get("/robots.txt", async (_req, res) => {
  try {
    const content = await getRobotsTxt();
    setTextHeaders(res);
    return res.send(content);
  } catch (error) {
    console.error("[robots] generation error:", error);
    return res
      .status(500)
      .set("Content-Type", "text/plain; charset=utf-8")
      .send("Robots generation error");
  }
});

router.get("/sitemap.xml", async (_req, res) => {
  try {
    const xml = await getSitemapIndexXml();
    setXmlHeaders(res);
    return res.send(xml);
  } catch (error) {
    return sendSitemapError(res, error);
  }
});

router.get(/^\/sitemaps\/([a-z-]+)-(\d+)\.xml$/, async (req, res) => {
  const section = req.params[0];
  const page = Number(req.params[1] || 1);

  try {
    const xml = await getSitemapSectionXml(section, page);
    setXmlHeaders(res);
    return res.send(xml);
  } catch (error) {
    return sendSitemapError(res, error);
  }
});

router.get(/^\/sitemaps\/([a-z-]+)\.xml$/, async (req, res) => {
  const section = req.params[0];

  try {
    const xml = await getSitemapSectionXml(section, 1);
    setXmlHeaders(res);
    return res.send(xml);
  } catch (error) {
    return sendSitemapError(res, error);
  }
});

const legacyRoutes = {
  "/sitemap-products.xml": "products",
  "/sitemap-categories.xml": "categories",
  "/sitemap-brands.xml": "brands",
  "/sitemap-pages.xml": "pages",
  "/sitemap-blog.xml": "blog",
  "/sitemap-static.xml": "static",
};

for (const [legacyPath, section] of Object.entries(legacyRoutes)) {
  router.get(legacyPath, (_req, res) => {
    return res.redirect(301, `/sitemaps/${section}-1.xml`);
  });
}

export default router;
