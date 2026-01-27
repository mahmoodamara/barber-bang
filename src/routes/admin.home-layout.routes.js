import express from "express";
import { z } from "zod";
import { HomeLayout } from "../models/HomeLayout.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { sendOk, sendError } from "../utils/response.js";

const router = express.Router();

// Validation Schema for Sections
const sectionSchema = z.object({
    id: z.string(),
    type: z.enum(["hero", "categories", "featured-products", "banner", "text", "grid-products"]),
    enabled: z.boolean(),
    order: z.number(),
    payload: z.record(z.any()).optional(), // Allow flexible payload but ensure object
});

const layoutUpdateSchema = z.object({
    sections: z.array(sectionSchema),
    __v: z.number().optional(),
});

router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.SETTINGS_WRITE));
router.use(auditAdmin());

/**
 * GET /api/admin/home-layout
 * Get home layout configuration (creates default if missing)
 */
router.get("/", async (req, res, next) => {
    try {
        let layout = await HomeLayout.findOne();
        if (!layout) {
            layout = await HomeLayout.create({ sections: [] });
        }

        sendOk(res, layout);
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/home-layout
 * Update home layout configuration
 */
router.put("/", async (req, res, next) => {
    try {
        const validation = layoutUpdateSchema.safeParse(req.body);
        if (!validation.success) {
            return sendError(res, 400, "VALIDATION_ERROR", "Invalid layout data", { details: validation.error.format() });
        }

        const { sections, __v } = validation.data;

        let layout = await HomeLayout.findOne();
        if (!layout) {
            layout = new HomeLayout({});
        }

        if (typeof __v === 'number' && layout.__v !== undefined && layout.__v !== __v) {
            return sendError(res, 409, "CONFLICT", "Layout has been updated by another user. Please refresh.");
        }

        layout.sections = sections;

        await layout.save();

        sendOk(res, layout);
    } catch (error) {
        if (error.name === "VersionError") {
            return sendError(res, 409, "CONFLICT", "Layout has been updated by another user. Please refresh.");
        }
        next(error);
    }
});

export default router;
