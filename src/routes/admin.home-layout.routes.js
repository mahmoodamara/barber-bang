import express from "express";
import { z } from "zod";
import multer from "multer";
import { HomeLayout } from "../models/HomeLayout.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { handleUploadError } from "../middleware/upload.js";
import { sendOk, sendError, sendCreated } from "../utils/response.js";
import { invalidateHomeCache } from "../utils/cache.js";
import {
    uploadBuffer,
    isCloudinaryConfigured,
    getDefaultFolder,
} from "../config/cloudinary.js";

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
        invalidateHomeCache();

        sendOk(res, layout);
    } catch (error) {
        if (error.name === "VersionError") {
            return sendError(res, 409, "CONFLICT", "Layout has been updated by another user. Please refresh.");
        }
        next(error);
    }
});

// ──────────────────────────────────────────────
// Multer configs for hero media uploads
// ──────────────────────────────────────────────

const IMAGE_ALLOWED = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const VIDEO_ALLOWED = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

const heroImageUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (_req, file, cb) => {
        if (!IMAGE_ALLOWED.has(file.mimetype.toLowerCase())) {
            const err = new Error("نوع الملف غير مسموح. المسموح: JPEG, PNG, WEBP");
            err.code = "INVALID_FILE_TYPE";
            err.statusCode = 400;
            return cb(err, false);
        }
        cb(null, true);
    },
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
}).single("file");

const heroVideoUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (_req, file, cb) => {
        if (!VIDEO_ALLOWED.has(file.mimetype.toLowerCase())) {
            const err = new Error("نوع الملف غير مسموح. المسموح: MP4, WebM, MOV");
            err.code = "INVALID_FILE_TYPE";
            err.statusCode = 400;
            return cb(err, false);
        }
        cb(null, true);
    },
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
}).single("file");

/**
 * POST /api/admin/home-layout/upload-image
 * Upload hero image to Cloudinary
 */
router.post("/upload-image", heroImageUpload, handleUploadError, async (req, res, next) => {
    try {
        if (!isCloudinaryConfigured()) {
            return sendError(res, 503, "SERVICE_UNAVAILABLE", "Cloudinary غير مكوّن");
        }
        if (!req.file?.buffer) {
            return sendError(res, 400, "NO_FILE", "لم يتم إرسال ملف. استخدم الحقل 'file'");
        }

        const folder = `${getDefaultFolder()}/hero`;
        const result = await uploadBuffer({
            buffer: req.file.buffer,
            filename: req.file.originalname || "hero-image",
            folder,
            tags: ["hero", "home-layout"],
            resourceType: "image",
        });

        sendCreated(res, {
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            bytes: result.bytes,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/home-layout/upload-video
 * Upload hero video to Cloudinary
 */
router.post("/upload-video", heroVideoUpload, handleUploadError, async (req, res, next) => {
    try {
        if (!isCloudinaryConfigured()) {
            return sendError(res, 503, "SERVICE_UNAVAILABLE", "Cloudinary غير مكوّن");
        }
        if (!req.file?.buffer) {
            return sendError(res, 400, "NO_FILE", "لم يتم إرسال ملف. استخدم الحقل 'file'");
        }

        const folder = `${getDefaultFolder()}/hero`;
        const result = await uploadBuffer({
            buffer: req.file.buffer,
            filename: req.file.originalname || "hero-video",
            folder,
            tags: ["hero", "home-layout", "video"],
            resourceType: "video",
        });

        sendCreated(res, {
            url: result.secure_url,
            publicId: result.public_id,
            format: result.format,
            bytes: result.bytes,
            duration: result.duration,
        });
    } catch (error) {
        next(error);
    }
});

export default router;
