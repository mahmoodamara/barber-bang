// src/routes/settings.routes.js
// Public settings endpoint - returns site settings without authentication

import express from "express";
import { SiteSettings } from "../models/SiteSettings.js";
import { sendOk } from "../utils/response.js";

const router = express.Router();

/**
 * Set cache headers for public settings endpoint
 * @param {object} res - Express response
 * @param {number} [maxAge=300] - max-age in seconds (5 minutes default)
 * @param {number} [staleWhileRevalidate=600] - stale-while-revalidate in seconds
 */
function setCacheHeaders(res, maxAge = 300, staleWhileRevalidate = 600) {
  res.set(
    "Cache-Control",
    `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`
  );
}

/**
 * GET /api/v1/settings
 * Public endpoint - returns public site settings (no auth required)
 * Supports ?lang=he|ar or Accept-Language header (via langMiddleware)
 * 
 * Returns only public fields - excludes sensitive data like pricingRules and __v
 * If no settings exist, returns empty object {} with 200 status
 */
router.get("/", async (req, res) => {
  try {
    // Fetch settings with projection to exclude sensitive fields
    // Note: pricingRules contains internal business logic (pricesIncludeVat) - not for public
    const settings = await SiteSettings.findOne()
      .select(
        "storeNameHe storeNameAr logoUrl faviconUrl whatsappNumber phone email " +
        "addressHe addressAr businessHoursHe businessHoursAr socialLinks topBar " +
        "seoDefaults maintenanceMode checkoutRules createdAt updatedAt"
      )
      .lean();

    setCacheHeaders(res, 300, 600);

    // Return empty object if no settings exist (not 404 - settings are optional)
    return sendOk(res, settings || {});
  } catch (err) {
    console.error("[settings] Get public settings error:", err?.message || err);
    // Fail gracefully - return empty settings on error to avoid exposing internal errors
    setCacheHeaders(res, 60, 120); // Shorter cache on error
    return sendOk(res, {});
  }
});

export default router;
