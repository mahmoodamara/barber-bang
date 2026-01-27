import express from "express";
import { z } from "zod";
import { SiteSettings } from "../models/SiteSettings.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { sendOk, sendError } from "../utils/response.js";

const router = express.Router();

// Validation Schema
const settingsSchema = z.object({
    storeNameHe: z.string().optional(),
    storeNameAr: z.string().optional(),
    logoUrl: z.string().url().optional().or(z.literal("")),
    faviconUrl: z.string().url().optional().or(z.literal("")),
    whatsappNumber: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional().or(z.literal("")),
    addressHe: z.string().optional(),
    addressAr: z.string().optional(),
    businessHoursHe: z.string().optional(),
    businessHoursAr: z.string().optional(),
    socialLinks: z.object({
        instagram: z.string().optional(),
        facebook: z.string().optional(),
        tiktok: z.string().optional(),
    }).optional(),
    topBar: z.object({
        enabled: z.boolean().optional(),
        textHe: z.string().optional(),
        textAr: z.string().optional(),
        link: z.string().optional(),
    }).optional(),
    seoDefaults: z.object({
        titleHe: z.string().optional(),
        titleAr: z.string().optional(),
        descriptionHe: z.string().optional(),
        descriptionAr: z.string().optional(),
        ogImage: z.string().optional(),
    }).optional(),
    maintenanceMode: z.object({
        enabled: z.boolean().optional(),
        messageHe: z.string().optional(),
        messageAr: z.string().optional(),
    }).optional(),
    checkoutRules: z.object({
        enableCOD: z.boolean().optional(),
        codFeeMinor: z.number().min(0).optional(),
        freeShippingThresholdMinor: z.number().min(0).optional(),
        minOrderAmountMinor: z.number().min(0).optional(),
    }).optional(),
    __v: z.number().optional(), // For optimistic currency
}).strict(); // Reject unknown fields

// Middleware stack
router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.SETTINGS_WRITE));
router.use(auditAdmin());

/**
 * GET /api/admin/settings
 * Get global site settings (creates default if missing)
 */
router.get("/", async (req, res, next) => {
    try {
        let settings = await SiteSettings.findOne();

        if (!settings) {
            settings = await SiteSettings.create({});
        }

        sendOk(res, settings);
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/settings
 * Update global site settings
 */
router.put("/", async (req, res, next) => {
    try {
        const validation = settingsSchema.safeParse(req.body);
        if (!validation.success) {
            return sendError(res, 400, "VALIDATION_ERROR", "Invalid settings data", { details: validation.error.format() });
        }

        const { __v, ...updates } = validation.data;

        let settings = await SiteSettings.findOne();
        if (!settings) {
            settings = new SiteSettings({});
        }

        // Optimistic Concurrency Check
        if (typeof __v === 'number' && settings.__v !== undefined && settings.__v !== __v) {
            return sendError(res, 409, "CONFLICT", "Settings have been updated by another user. Please refresh and try again.");
        }

        // Apply updates
        Object.assign(settings, updates);

        await settings.save();

        sendOk(res, settings);
    } catch (error) {
        if (error.name === "VersionError") {
            return sendError(res, 409, "CONFLICT", "Settings have been updated by another user. Please refresh and try again.");
        }
        next(error);
    }
});

export default router;
