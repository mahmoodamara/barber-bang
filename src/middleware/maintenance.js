// src/middleware/maintenance.js
import { SiteSettings } from "../models/SiteSettings.js";
import { getRequestId } from "./error.js";

/**
 * Allowed routes that bypass maintenance mode:
 * - /api/admin/* and /api/v1/admin/*
 * - /api/v1/health and /health
 * - /api/stripe/webhook and /api/v1/stripe/webhook
 */
const ALLOWED_PATTERNS = [
    /^\/api\/v1\/admin(\/|$)/i,
    /^\/api\/admin(\/|$)/i,
    /^\/api\/v1\/health(\/|$)/i,
    /^\/health$/i,
    /^\/api\/v1\/stripe\/webhook(\/|$)/i,
    /^\/api\/stripe\/webhook(\/|$)/i,
];

function isAllowedPath(path) {
    for (const pattern of ALLOWED_PATTERNS) {
        if (pattern.test(path)) return true;
    }
    return false;
}

let cachedSettings = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

async function getSettingsCached() {
    const now = Date.now();
    if (cachedSettings && now < cacheExpiry) {
        return cachedSettings;
    }
    try {
        cachedSettings = await SiteSettings.findOne().lean();
        cacheExpiry = now + CACHE_TTL_MS;
    } catch {
        // On error, return null (fail-open to avoid blocking if DB is down)
        cachedSettings = null;
    }
    return cachedSettings;
}

export function maintenanceMiddleware() {
    return async (req, res, next) => {
        const path = req.path || req.url || "";

        // Always allow certain paths
        if (isAllowedPath(path)) {
            return next();
        }

        const settings = await getSettingsCached();
        if (!settings?.maintenanceMode?.enabled) {
            return next();
        }

        // Maintenance mode is enabled - block with 503
        const lang = (req.lang || "he").toLowerCase();
        const message =
            lang === "ar"
                ? settings.maintenanceMode.messageAr || "الموقع قيد الصيانة"
                : settings.maintenanceMode.messageHe || "האתר בתחזוקה";

        return res.status(503).json({
            ok: false,
            error: {
                code: "MAINTENANCE_MODE",
                message,
                requestId: getRequestId(req),
                path: req.originalUrl || req.url || "",
            },
        });
    };
}
