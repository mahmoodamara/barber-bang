// src/routes/admin.media.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { auditAdmin } from "../middleware/audit.js";
import { uploadSingleImage, validateImageMagic, handleUploadError } from "../middleware/upload.js";
import { limitMediaUpload } from "../middleware/rateLimit.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";

import { MediaAsset } from "../models/MediaAsset.js";
import { Product } from "../models/Product.js";
import {
  uploadBuffer,
  deleteByPublicId,
  isCloudinaryConfigured,
  getDefaultFolder,
  getAllowedMimeTypes,
  getMaxFileSizeBytes,
} from "../config/cloudinary.js";

const router = express.Router();
const { isValidObjectId } = mongoose;

const OBJECT_ID_RE = "[0-9a-fA-F]{24}";

// Orphans: caps to avoid memory exhaustion (best-effort endpoint)
const ORPHANS_MAX_FETCH = 2000;
const DELETE_ORPHANS_DEFAULT_MAX = 50;
const DELETE_ORPHANS_HARD_CAP = 100;
const DELETE_ORPHANS_SCAN_CAP = 2000;

/**
 * ============================
 * Helpers
 * ============================
 */

function mapAsset(asset) {
  const obj = typeof asset?.toObject === "function" ? asset.toObject() : asset;
  return {
    id: obj?._id ? String(obj._id) : "",
    publicId: obj?.publicId || "",
    url: obj?.url || "",
    secureUrl: obj?.secureUrl || "",
    width: obj?.width ?? null,
    height: obj?.height ?? null,
    bytes: obj?.bytes ?? null,
    format: obj?.format || "",
    folder: obj?.folder || "",
    tags: Array.isArray(obj?.tags) ? obj.tags : [],
    originalFilename: obj?.originalFilename || "",
    altHe: obj?.altHe || "",
    altAr: obj?.altAr || "",
    resourceType: obj?.resourceType || "image",
    createdBy: obj?.createdBy ? String(obj.createdBy) : null,
    createdAt: obj?.createdAt || null,
    updatedAt: obj?.updatedAt || null,
  };
}

function normalizeTagCsv(tagsRaw) {
  const out = [];
  const seen = new Set();
  for (const raw of String(tagsRaw || "").split(",")) {
    const t = raw.trim().toLowerCase().slice(0, 50);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeTagsArray(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const t = String(raw || "").trim().toLowerCase().slice(0, 50);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

async function buildUsedMediaSets() {
  // IMPORTANT: include imageUrl-only products too (avoid false positives)
  const products = await Product.find(
    {
      isDeleted: { $ne: true },
      $or: [{ "images.0": { $exists: true } }, { imageUrl: { $exists: true, $ne: "" } }],
    },
    { images: 1, imageUrl: 1 }
  ).lean();

  const usedUrls = new Set();
  const usedPublicIds = new Set();

  for (const p of products) {
    if (p?.imageUrl) usedUrls.add(p.imageUrl);
    for (const img of p?.images || []) {
      if (img?.url) usedUrls.add(img.url);
      if (img?.secureUrl) usedUrls.add(img.secureUrl);
      if (img?.publicId) usedPublicIds.add(img.publicId);
    }
  }

  return { usedUrls, usedPublicIds };
}

/**
 * ============================
 * POST /upload
 * ============================
 */
router.post(
  "/upload",
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  limitMediaUpload,
  uploadSingleImage,
  validateImageMagic,
  handleUploadError,
  auditAdmin(),
  async (req, res) => {
    try {
      if (!isCloudinaryConfigured()) {
        return sendError(
          res,
          503,
          "SERVICE_UNAVAILABLE",
          "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET."
        );
      }

      if (!req.file?.buffer) {
        return sendError(res, 400, "NO_FILE", "No file provided. Use field name 'file'.");
      }

      const folder = String(req.body?.folder || getDefaultFolder()).trim() || getDefaultFolder();
      const tags = normalizeTagCsv(req.body?.tags);
      const altHe = String(req.body?.altHe || "").trim().slice(0, 256);
      const altAr = String(req.body?.altAr || "").trim().slice(0, 256);

      const result = await uploadBuffer({
        buffer: req.file.buffer,
        filename: req.file.originalname || "upload",
        folder,
        tags,
        resourceType: "image",
      });

      const asset = await MediaAsset.create({
        publicId: result.public_id,
        url: result.url,
        secureUrl: result.secure_url,
        width: result.width ?? null,
        height: result.height ?? null,
        bytes: result.bytes ?? null,
        format: result.format || "",
        folder: result.folder || folder,
        tags: Array.isArray(result.tags) ? result.tags : tags,
        originalFilename: req.file.originalname || "",
        altHe,
        altAr,
        resourceType: result.resource_type || "image",
        createdBy: req.user?._id || null,
      });

      return sendCreated(res, mapAsset(asset));
    } catch (err) {
      console.error("[admin.media] Upload error:", err?.message || err);

      if (err?.http_code) {
        return sendError(res, err.http_code, "CLOUDINARY_ERROR", err.message || "Cloudinary upload failed");
      }

      return sendError(res, 500, "UPLOAD_FAILED", "Failed to upload image");
    }
  }
);

/**
 * ============================
 * GET /
 * ============================
 */
const listSchema = z.object({
  query: z.object({
    q: z.string().max(100).optional(),
    folder: z.string().max(128).optional(),
    tags: z.string().max(256).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.enum(["createdAt", "originalFilename", "bytes"]).default("createdAt"),
    sortDir: z.enum(["asc", "desc"]).default("desc"),
  }),
});

router.get(
  "/",
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  validate(listSchema),
  async (req, res) => {
    try {
      const { q, folder, tags, page, limit, sortBy, sortDir } = req.validated.query;

      const filter = { isDeleted: { $ne: true } };

      if (q) {
        // Requires a text index on relevant fields (e.g., publicId, originalFilename, tags).
        filter.$text = { $search: q };
      }

      if (folder) filter.folder = folder;

      if (tags) {
        const tagList = normalizeTagCsv(tags);
        if (tagList.length) filter.tags = { $in: tagList };
      }

      const sortOrder = sortDir === "asc" ? 1 : -1;
      const sort = q
        ? { score: { $meta: "textScore" }, [sortBy]: sortOrder }
        : { [sortBy]: sortOrder };

      const skip = (page - 1) * limit;

      let query = MediaAsset.find(filter);
      if (q) query = query.select({ score: { $meta: "textScore" } });

      const [items, total] = await Promise.all([
        query.sort(sort).skip(skip).limit(limit).lean(),
        MediaAsset.countDocuments(filter),
      ]);

      const totalPages = Math.ceil(total / limit);

      return sendOk(res, items.map(mapAsset), {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error("[admin.media] List error:", msg);

      if (msg.includes("text index required") || msg.includes("text index")) {
        return sendError(res, 500, "TEXT_INDEX_MISSING", "Text search is not available (missing text index)");
      }

      return sendError(res, 500, "LIST_FAILED", "Failed to list media assets");
    }
  }
);

/**
 * ============================
 * GET /config
 * ============================
 * Static route (kept above /:id) + /:id constrained to ObjectId.
 */
router.get(
  "/config",
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  (_req, res) => {
    const maxBytes = getMaxFileSizeBytes();
    return sendOk(res, {
      configured: isCloudinaryConfigured(),
      defaultFolder: getDefaultFolder(),
      allowedMimeTypes: getAllowedMimeTypes(),
      maxFileSizeBytes: maxBytes,
      maxFileSizeMB: Math.round(maxBytes / (1024 * 1024)),
    });
  }
);

/**
 * ============================
 * GET /orphans
 * ============================
 */
const orphansSchema = z.object({
  query: z.object({
    days: z.coerce.number().int().min(1).max(365).default(7),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
});

router.get(
  "/orphans",
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  validate(orphansSchema),
  async (req, res) => {
    try {
      const { days, page, limit } = req.validated.query;
      const skip = (page - 1) * limit;

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const { usedUrls, usedPublicIds } = await buildUsedMediaSets();

      const filter = { isDeleted: { $ne: true }, createdAt: { $lt: cutoffDate } };
      const projection = {
        _id: 1,
        publicId: 1,
        url: 1,
        secureUrl: 1,
        resourceType: 1,
        createdAt: 1,
        originalFilename: 1,
        altHe: 1,
        altAr: 1,
        tags: 1,
        folder: 1,
        format: 1,
        width: 1,
        height: 1,
        bytes: 1,
        createdBy: 1,
        updatedAt: 1,
      };

      const scannedAssets = await MediaAsset.find(filter)
        .select(projection)
        .sort({ createdAt: -1 })
        .limit(ORPHANS_MAX_FETCH)
        .lean();

      const orphans = scannedAssets.filter((asset) => {
        const isUsed =
          (asset?.publicId && usedPublicIds.has(asset.publicId)) ||
          (asset?.url && usedUrls.has(asset.url)) ||
          (asset?.secureUrl && usedUrls.has(asset.secureUrl));
        return !isUsed;
      });

      const total = orphans.length;
      const items = orphans.slice(skip, skip + limit);

      return sendOk(res, items.map(mapAsset), {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        daysThreshold: days,
        cutoffDate: cutoffDate.toISOString(),
        scannedCap: ORPHANS_MAX_FETCH,
      });
    } catch (err) {
      console.error("[admin.media] Orphans list error:", err?.message || err);
      return sendError(res, 500, "LIST_ORPHANS_FAILED", "Failed to list orphan assets");
    }
  }
);

/**
 * ============================
 * DELETE /orphans
 * ============================
 */
const deleteOrphansSchema = z.object({
  body: z
    .object({
      days: z.number().int().min(1).max(365).optional(),
      dryRun: z.boolean().optional(),
      maxDelete: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
});

router.delete(
  "/orphans",
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  validate(deleteOrphansSchema),
  auditAdmin(),
  async (req, res) => {
    try {
      const body = req.validated.body || {};
      const days = body.days ?? 7;
      const dryRun = body.dryRun ?? false;
      const maxDelete = Math.min(DELETE_ORPHANS_HARD_CAP, body.maxDelete ?? DELETE_ORPHANS_DEFAULT_MAX);

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const { usedUrls, usedPublicIds } = await buildUsedMediaSets();

      const filter = { isDeleted: { $ne: true }, createdAt: { $lt: cutoffDate } };
      const projection = { _id: 1, publicId: 1, url: 1, secureUrl: 1, resourceType: 1 };

      const scanLimit = Math.min(DELETE_ORPHANS_SCAN_CAP, Math.max(maxDelete * 10, maxDelete));
      const scannedAssets = await MediaAsset.find(filter)
        .select(projection)
        .sort({ createdAt: 1 })
        .limit(scanLimit)
        .lean();

      const orphans = scannedAssets
        .filter((asset) => {
          const isUsed =
            (asset?.publicId && usedPublicIds.has(asset.publicId)) ||
            (asset?.url && usedUrls.has(asset.url)) ||
            (asset?.secureUrl && usedUrls.has(asset.secureUrl));
          return !isUsed;
        })
        .slice(0, maxDelete);

      if (dryRun) {
        return sendOk(res, {
          dryRun: true,
          wouldDelete: orphans.length,
          assets: orphans.map(mapAsset),
          cutoffDate: cutoffDate.toISOString(),
          daysThreshold: days,
          scanned: scannedAssets.length,
          scanLimit,
        });
      }

      const deleted = [];
      const failed = [];

      for (const asset of orphans) {
        try {
          if (isCloudinaryConfigured() && asset.publicId) {
            try {
              await deleteByPublicId(asset.publicId, asset.resourceType || "image");
            } catch (cloudErr) {
              console.warn("[admin.media] Cloudinary orphan delete warning:", cloudErr?.message || cloudErr);
            }
          }

          await MediaAsset.deleteOne({ _id: asset._id });
          deleted.push({ id: String(asset._id), publicId: asset.publicId || "" });
        } catch (delErr) {
          failed.push({
            id: String(asset._id),
            publicId: asset.publicId || "",
            error: delErr?.message || "Delete failed",
          });
        }
      }

      return sendOk(res, {
        deleted: deleted.length,
        failed: failed.length,
        deletedAssets: deleted,
        failedAssets: failed,
        cutoffDate: cutoffDate.toISOString(),
        daysThreshold: days,
        scanned: scannedAssets.length,
        scanLimit,
      });
    } catch (err) {
      console.error("[admin.media] Delete orphans error:", err?.message || err);
      return sendError(res, 500, "DELETE_ORPHANS_FAILED", "Failed to delete orphan assets");
    }
  }
);

/**
 * ============================
 * GET /:id
 * ============================
 * Constrained to ObjectId to avoid shadowing static routes.
 */
router.get(
  `/:id(${OBJECT_ID_RE})`,
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Redundant with route regex, but harmless defense-in-depth.
      if (!isValidObjectId(id)) return sendError(res, 400, "INVALID_ID", "Invalid asset ID");

      const asset = await MediaAsset.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
      if (!asset) return sendError(res, 404, "NOT_FOUND", "Asset not found");

      return sendOk(res, mapAsset(asset));
    } catch (err) {
      console.error("[admin.media] Get error:", err?.message || err);
      return sendError(res, 500, "GET_FAILED", "Failed to get media asset");
    }
  }
);

/**
 * ============================
 * PATCH /:id
 * ============================
 */
const updateSchema = z.object({
  body: z
    .object({
      altHe: z.string().max(256).optional(),
      altAr: z.string().max(256).optional(),
      tags: z.array(z.string().max(50)).max(20).optional(), // aligned with normalizeTagsArray cap
    })
    .strict(),
});

router.patch(
  `/:id(${OBJECT_ID_RE})`,
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  validate(updateSchema),
  auditAdmin(),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) return sendError(res, 400, "INVALID_ID", "Invalid asset ID");

      const asset = await MediaAsset.findOne({ _id: id, isDeleted: { $ne: true } });
      if (!asset) return sendError(res, 404, "NOT_FOUND", "Asset not found");

      const { altHe, altAr, tags } = req.validated.body;

      if (altHe !== undefined) asset.altHe = String(altHe).trim();
      if (altAr !== undefined) asset.altAr = String(altAr).trim();
      if (tags !== undefined) asset.tags = normalizeTagsArray(tags);

      await asset.save();
      return sendOk(res, mapAsset(asset));
    } catch (err) {
      console.error("[admin.media] Update error:", err?.message || err);
      return sendError(res, 500, "UPDATE_FAILED", "Failed to update media asset");
    }
  }
);

/**
 * ============================
 * DELETE /:id
 * ============================
 */
router.delete(
  `/:id(${OBJECT_ID_RE})`,
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  auditAdmin(),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) return sendError(res, 400, "INVALID_ID", "Invalid asset ID");

      const asset = await MediaAsset.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
      if (!asset) return sendError(res, 404, "NOT_FOUND", "Asset not found");

      if (isCloudinaryConfigured() && asset.publicId) {
        try {
          await deleteByPublicId(asset.publicId, asset.resourceType || "image");
        } catch (cloudErr) {
          // Best-effort: the asset might already be deleted from Cloudinary.
          console.warn("[admin.media] Cloudinary delete warning:", cloudErr?.message || cloudErr);
        }
      }

      // Keep current behavior: hard-delete the DB record.
      await MediaAsset.deleteOne({ _id: id });

      return sendOk(res, { deleted: true, id: String(asset._id), publicId: asset.publicId || "" });
    } catch (err) {
      console.error("[admin.media] Delete error:", err?.message || err);
      return sendError(res, 500, "DELETE_FAILED", "Failed to delete media asset");
    }
  }
);

export default router;
