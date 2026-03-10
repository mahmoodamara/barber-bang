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

const HERO_MEDIA_TYPES = ["image", "slider", "video"];
const MAX_HERO_IMAGES = 12;

function normalizeText(value) {
    if (typeof value !== "string") return "";
    return value.trim();
}

function normalizeStringArray(values, maxItems = MAX_HERO_IMAGES) {
    if (!Array.isArray(values)) return [];

    const unique = [];
    const seen = new Set();

    for (const value of values) {
        const normalized = normalizeText(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(normalized);
        if (unique.length >= maxItems) break;
    }

    return unique;
}

function inferHeroMediaType(payload) {
    const requestedType = normalizeText(payload?.mediaType);
    if (HERO_MEDIA_TYPES.includes(requestedType)) {
        return requestedType;
    }

    const images = normalizeStringArray(payload?.images);
    if (normalizeText(payload?.videoUrl)) return "video";
    if (images.length > 1) return "slider";
    return "image";
}

function normalizeHeroPayload(payload = {}) {
    const images = normalizeStringArray(payload.images);
    const imageUrl = normalizeText(payload.imageUrl) || images[0] || "";
    const mediaType = inferHeroMediaType({ ...payload, images, imageUrl });

    return {
        ...payload,
        mediaType,
        titleHe: normalizeText(payload.titleHe),
        titleAr: normalizeText(payload.titleAr),
        subtitleHe: normalizeText(payload.subtitleHe),
        subtitleAr: normalizeText(payload.subtitleAr),
        ctaTextHe: normalizeText(payload.ctaTextHe),
        ctaTextAr: normalizeText(payload.ctaTextAr),
        ctaLink: normalizeText(payload.ctaLink),
        imageUrl,
        images,
        videoUrl: normalizeText(payload.videoUrl),
        videoPosterUrl: normalizeText(payload.videoPosterUrl || payload.posterUrl || imageUrl),
        slideIntervalMs: 5000,
    };
}

function normalizeSection(section = {}) {
    if (section?.type !== "hero") return section;
    return {
        ...section,
        payload: normalizeHeroPayload(section.payload),
    };
}

// Validation Schema for Sections
const heroPayloadSchema = z.object({
    mediaType: z.enum(HERO_MEDIA_TYPES).optional(),
    titleHe: z.string().optional(),
    titleAr: z.string().optional(),
    subtitleHe: z.string().optional(),
    subtitleAr: z.string().optional(),
    ctaTextHe: z.string().optional(),
    ctaTextAr: z.string().optional(),
    ctaLink: z.string().optional(),
    imageUrl: z.string().optional(),
    images: z.array(z.string()).max(MAX_HERO_IMAGES).optional(),
    videoUrl: z.string().optional(),
    videoPosterUrl: z.string().optional(),
    slideIntervalMs: z.number().optional(),
}).passthrough();

const sectionSchema = z.object({
    id: z.string(),
    type: z.enum(["hero", "categories", "featured-products", "banner", "text", "grid-products"]),
    enabled: z.boolean(),
    order: z.number(),
    payload: z.record(z.any()).optional(), // Allow flexible payload but ensure object
}).superRefine((section, ctx) => {
    if (section.type !== "hero") return;

    const result = heroPayloadSchema.safeParse(section.payload || {});
    if (result.success) return;

    for (const issue of result.error.issues) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["payload", ...issue.path],
            message: issue.message,
        });
    }
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
        const normalizedSections = sections.map((section) => normalizeSection(section));

        let layout = await HomeLayout.findOne();
        if (!layout) {
            layout = new HomeLayout({});
        }

        if (typeof __v === 'number' && layout.__v !== undefined && layout.__v !== __v) {
            return sendError(res, 409, "CONFLICT", "Layout has been updated by another user. Please refresh.");
        }

        layout.sections = normalizedSections;

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

const heroImagesUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (_req, file, cb) => {
        if (!IMAGE_ALLOWED.has(file.mimetype.toLowerCase())) {
            const err = new Error("Ù†ÙˆØ¹ Ø§Ù„Ù…Ù„Ù ØºÙŠØ± Ù…Ø³Ù…ÙˆØ­. Ø§Ù„Ù…Ø³Ù…ÙˆØ­: JPEG, PNG, WEBP");
            err.code = "INVALID_FILE_TYPE";
            err.statusCode = 400;
            return cb(err, false);
        }
        cb(null, true);
    },
    limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_HERO_IMAGES },
}).array("files", MAX_HERO_IMAGES);

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

function mapImageUploadResult(result) {
    return {
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes,
    };
}

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

        sendCreated(res, mapImageUploadResult(result));
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/home-layout/upload-images
 * Upload multiple hero images to Cloudinary
 */
router.post("/upload-images", heroImagesUpload, handleUploadError, async (req, res, next) => {
    try {
        if (!isCloudinaryConfigured()) {
            return sendError(res, 503, "SERVICE_UNAVAILABLE", "Cloudinary ØºÙŠØ± Ù…ÙƒÙˆÙ‘Ù†");
        }

        const files = Array.isArray(req.files) ? req.files : [];
        if (!files.length) {
            return sendError(res, 400, "NO_FILE", "Ù„Ù… ÙŠØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ù…Ù„ÙØ§Øª. Ø§Ø³ØªØ®Ø¯Ù… Ø§Ù„Ø­Ù‚Ù„ 'files'");
        }

        const folder = `${getDefaultFolder()}/hero`;
        const uploads = await Promise.all(
            files.map((file, index) =>
                uploadBuffer({
                    buffer: file.buffer,
                    filename: file.originalname || `hero-image-${index + 1}`,
                    folder,
                    tags: ["hero", "home-layout", "slider"],
                    resourceType: "image",
                })
            )
        );

        const assets = uploads.map((result) => mapImageUploadResult(result));

        sendCreated(res, {
            urls: assets.map((asset) => asset.url),
            assets,
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
