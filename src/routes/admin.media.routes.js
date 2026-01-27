// src/routes/admin.media.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { auditAdmin } from "../middleware/audit.js";
import { uploadSingleImage, validateImageMagic, handleUploadError } from "../middleware/upload.js";
import { getRequestId } from "../middleware/error.js";
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

/**
 * ============================
 * Helper Functions
 * ============================
 */

function errorPayload(req, code, message, details = null) {
  // We won't use this return value directly but pass it to sendError in the router
  return { code, message, details };
}

function successPayload(data, meta = null) {
  return { data, meta };
}

function notFoundPayload(req, message = "Asset not found") {
  return { code: "NOT_FOUND", message };
}

function mapAsset(asset) {
  const obj = typeof asset.toObject === "function" ? asset.toObject() : asset;
  return {
    id: String(obj._id),
    publicId: obj.publicId || "",
    url: obj.url || "",
    secureUrl: obj.secureUrl || "",
    width: obj.width || null,
    height: obj.height || null,
    bytes: obj.bytes || null,
    format: obj.format || "",
    folder: obj.folder || "",
    tags: Array.isArray(obj.tags) ? obj.tags : [],
    originalFilename: obj.originalFilename || "",
    altHe: obj.altHe || "",
    altAr: obj.altAr || "",
    resourceType: obj.resourceType || "image",
    createdBy: obj.createdBy ? String(obj.createdBy) : null,
    createdAt: obj.createdAt || null,
    updatedAt: obj.updatedAt || null,
  };
}

/**
 * ============================
 * POST /upload
 * ============================
 * Upload a single image to Cloudinary.
 * Accepts multipart/form-data with field name "file".
 * Optional body fields: folder, tags (comma separated), altHe, altAr
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
      // Check if Cloudinary is configured
      if (!isCloudinaryConfigured()) {
        return sendError(
          res,
          503,
          "SERVICE_UNAVAILABLE",
          "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET."
        );
      }

      // Check if file was provided
      if (!req.file || !req.file.buffer) {
        return sendError(res, 400, "NO_FILE", "No file provided. Use field name 'file'.");
      }

      // Parse optional body fields
      const folder = String(req.body?.folder || getDefaultFolder()).trim();
      const tagsRaw = String(req.body?.tags || "").trim();
      const tags = tagsRaw
        ? tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
        : [];
      const altHe = String(req.body?.altHe || "").trim().substring(0, 256);
      const altAr = String(req.body?.altAr || "").trim().substring(0, 256);

      // Upload to Cloudinary
      const result = await uploadBuffer({
        buffer: req.file.buffer,
        filename: req.file.originalname || "upload",
        folder,
        tags,
        resourceType: "image",
      });

      // Save to MongoDB
      const asset = await MediaAsset.create({
        publicId: result.public_id,
        url: result.url,
        secureUrl: result.secure_url,
        width: result.width || null,
        height: result.height || null,
        bytes: result.bytes || null,
        format: result.format || "",
        folder: result.folder || folder,
        tags: result.tags || tags,
        originalFilename: req.file.originalname || "",
        altHe,
        altAr,
        resourceType: result.resource_type || "image",
        createdBy: req.user?._id || null,
      });

      return sendCreated(res, mapAsset(asset));
    } catch (err) {
      console.error("[admin.media] Upload error:", err?.message || err);

      // Handle Cloudinary-specific errors
      if (err?.http_code) {
        return sendError(
          res,
          err.http_code,
          "CLOUDINARY_ERROR",
          err.message || "Cloudinary upload failed"
        );
      }

      return sendError(res, 500, "UPLOAD_FAILED", "Failed to upload image");
    }
  }
);

/**
 * ============================
 * GET /
 * ============================
 * List media assets with pagination and search.
 * Query params:
 * - q: search term (filename, publicId, tags)
 * - folder: filter by folder
 * - tags: filter by tag (comma separated)
 * - page: page number (default 1)
 * - limit: items per page (default 20, max 100)
 * - sortBy: field to sort by (default: createdAt)
 * - sortDir: asc or desc (default: desc)
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

      // Build filter
      const filter = { isDeleted: { $ne: true } };

      // Text search
      if (q) {
        filter.$text = { $search: q };
      }

      // Folder filter
      if (folder) {
        filter.folder = folder;
      }

      // Tags filter
      if (tags) {
        const tagList = tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
        if (tagList.length > 0) {
          filter.tags = { $in: tagList };
        }
      }

      // Sorting
      const sortOrder = sortDir === "asc" ? 1 : -1;
      const sort = { [sortBy]: sortOrder };

      // If text search, also sort by relevance
      if (q) {
        sort.score = { $meta: "textScore" };
      }

      // Pagination
      const skip = (page - 1) * limit;

      // Execute query with projection for text search
      let query = MediaAsset.find(filter);
      if (q) {
        query = query.select({ score: { $meta: "textScore" } });
      }

      const [items, total] = await Promise.all([
        query.sort(sort).skip(skip).limit(limit).lean(),
        MediaAsset.countDocuments(filter),
      ]);

      const totalPages = Math.ceil(total / limit);

      return sendOk(
        res,
        items.map(mapAsset),
        {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        }
      );
    } catch (err) {
      console.error("[admin.media] List error:", err?.message || err);
      return sendError(res, 500, "LIST_FAILED", "Failed to list media assets");
    }
  }
);

/**
 * ============================
 * GET /:id
 * ============================
 * Get a single media asset by ID.
 */
router.get(
  "/:id",
  requireAuth(),
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return sendError(res, 400, "INVALID_ID", "Invalid asset ID");
      }

      const asset = await MediaAsset.findOne({
        _id: id,
        isDeleted: { $ne: true },
      });

      if (!asset) {
        return sendError(res, 404, "NOT_FOUND", "Asset not found");
      }

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
 * Update asset metadata (altHe, altAr, tags).
 */
const updateSchema = z.object({
  body: z.object({
    altHe: z.string().max(256).optional(),
    altAr: z.string().max(256).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  }).strict(),
});

router.patch(
  "/:id",
  requireAuth(),
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  validate(updateSchema),
  auditAdmin(),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return sendError(res, 400, "INVALID_ID", "Invalid asset ID");
      }

      const asset = await MediaAsset.findOne({
        _id: id,
        isDeleted: { $ne: true },
      });

      if (!asset) {
        return sendError(res, 404, "NOT_FOUND", "Asset not found");
      }

      const { altHe, altAr, tags } = req.validated.body;

      if (altHe !== undefined) asset.altHe = altHe.trim();
      if (altAr !== undefined) asset.altAr = altAr.trim();
      if (tags !== undefined) asset.tags = tags;

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
 * Delete a media asset from Cloudinary and MongoDB.
 */
router.delete(
  "/:id",
  requireAuth(),
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  auditAdmin(),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return sendError(res, 400, "INVALID_ID", "Invalid asset ID");
      }

      const asset = await MediaAsset.findOne({
        _id: id,
        isDeleted: { $ne: true },
      });

      if (!asset) {
        return sendError(res, 404, "NOT_FOUND", "Asset not found");
      }

      // Delete from Cloudinary
      if (isCloudinaryConfigured() && asset.publicId) {
        try {
          await deleteByPublicId(asset.publicId, asset.resourceType || "image");
        } catch (cloudErr) {
          // Log but don't fail if Cloudinary delete fails
          // Asset might have been deleted manually from Cloudinary dashboard
          console.warn(
            "[admin.media] Cloudinary delete warning:",
            cloudErr?.message || cloudErr
          );
        }
      }

      // Hard delete from MongoDB (or soft delete if preferred)
      await MediaAsset.deleteOne({ _id: id });

      return sendOk(res, {
        deleted: true,
        id: String(asset._id),
        publicId: asset.publicId,
      });
    } catch (err) {
      console.error("[admin.media] Delete error:", err?.message || err);
      return sendError(res, 500, "DELETE_FAILED", "Failed to delete media asset");
    }
  }
);

/**
 * ============================
 * GET /orphans
 * ============================
 * List orphan MediaAssets (not linked to any Product) older than N days.
 * Query params:
 * - days: minimum age in days (default 7, min 1, max 365)
 * - page: page number (default 1)
 * - limit: items per page (default 20, max 100)
 */
const orphansSchema = z.object({
  query: z.object({
    days: z.string().regex(/^\d+$/).optional(),
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
  }).optional(),
});

router.get(
  "/orphans",
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  validate(orphansSchema),
  async (req, res) => {
    try {
      const q = req.validated?.query || {};
      const days = Math.min(365, Math.max(1, Number(q.days || 7)));
      const page = Math.max(1, Number(q.page || 1));
      const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
      const skip = (page - 1) * limit;

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      // Get all publicIds/URLs used in Product.images
      const productsWithImages = await Product.find(
        { "images.0": { $exists: true }, isDeleted: { $ne: true } },
        { images: 1, imageUrl: 1 }
      ).lean();

      const usedUrls = new Set();
      const usedPublicIds = new Set();

      for (const product of productsWithImages) {
        if (product.imageUrl) {
          usedUrls.add(product.imageUrl);
        }
        for (const img of product.images || []) {
          if (img.url) usedUrls.add(img.url);
          if (img.secureUrl) usedUrls.add(img.secureUrl);
          // Extract publicId from URL if present
          if (img.publicId) usedPublicIds.add(img.publicId);
        }
      }

      // Find orphan assets
      const filter = {
        isDeleted: { $ne: true },
        createdAt: { $lt: cutoffDate },
      };

      // Count total orphans (we'll filter in memory for URL matching)
      const allAssets = await MediaAsset.find(filter)
        .sort({ createdAt: -1 })
        .lean();

      const orphans = allAssets.filter((asset) => {
        // Check if this asset is used anywhere
        const isUsed =
          usedPublicIds.has(asset.publicId) ||
          usedUrls.has(asset.url) ||
          usedUrls.has(asset.secureUrl);
        return !isUsed;
      });

      const total = orphans.length;
      const paginatedOrphans = orphans.slice(skip, skip + limit);

      return sendOk(
        res,
        paginatedOrphans.map(mapAsset),
        {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          daysThreshold: days,
          cutoffDate: cutoffDate.toISOString(),
        }
      );
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
 * Delete orphan MediaAssets (not linked to any Product) older than N days.
 * Body params:
 * - days: minimum age in days (default 7, min 1, max 365)
 * - dryRun: if true, only return what would be deleted (default false)
 * - maxDelete: maximum number to delete in one call (default 50, max 200)
 */
const deleteOrphansSchema = z.object({
  body: z.object({
    days: z.number().int().min(1).max(365).optional(),
    dryRun: z.boolean().optional(),
    maxDelete: z.number().int().min(1).max(200).optional(),
  }).strict(),
});

router.delete(
  "/orphans",
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  validate(deleteOrphansSchema),
  auditAdmin(),
  async (req, res) => {
    try {
      const { days = 7, dryRun = false, maxDelete = 50 } = req.validated?.body || {};

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      // Get all publicIds/URLs used in Product.images
      const productsWithImages = await Product.find(
        { "images.0": { $exists: true }, isDeleted: { $ne: true } },
        { images: 1, imageUrl: 1 }
      ).lean();

      const usedUrls = new Set();
      const usedPublicIds = new Set();

      for (const product of productsWithImages) {
        if (product.imageUrl) {
          usedUrls.add(product.imageUrl);
        }
        for (const img of product.images || []) {
          if (img.url) usedUrls.add(img.url);
          if (img.secureUrl) usedUrls.add(img.secureUrl);
          if (img.publicId) usedPublicIds.add(img.publicId);
        }
      }

      // Find orphan assets
      const filter = {
        isDeleted: { $ne: true },
        createdAt: { $lt: cutoffDate },
      };

      const allAssets = await MediaAsset.find(filter)
        .sort({ createdAt: 1 }) // Oldest first
        .limit(maxDelete * 2) // Fetch more to account for filtering
        .lean();

      const orphans = allAssets.filter((asset) => {
        const isUsed =
          usedPublicIds.has(asset.publicId) ||
          usedUrls.has(asset.url) ||
          usedUrls.has(asset.secureUrl);
        return !isUsed;
      }).slice(0, maxDelete);

      if (dryRun) {
        return sendOk(res, {
          dryRun: true,
          wouldDelete: orphans.length,
          assets: orphans.map(mapAsset),
          cutoffDate: cutoffDate.toISOString(),
          daysThreshold: days,
        });
      }

      // Actually delete
      const deleted = [];
      const failed = [];

      for (const asset of orphans) {
        try {
          // Delete from Cloudinary
          if (isCloudinaryConfigured() && asset.publicId) {
            try {
              await deleteByPublicId(asset.publicId, asset.resourceType || "image");
            } catch (cloudErr) {
              console.warn(
                "[admin.media] Cloudinary orphan delete warning:",
                cloudErr?.message || cloudErr
              );
            }
          }

          // Delete from MongoDB
          await MediaAsset.deleteOne({ _id: asset._id });
          deleted.push({
            id: String(asset._id),
            publicId: asset.publicId,
          });
        } catch (delErr) {
          failed.push({
            id: String(asset._id),
            publicId: asset.publicId,
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
      });
    } catch (err) {
      console.error("[admin.media] Delete orphans error:", err?.message || err);
      return sendError(res, 500, "DELETE_ORPHANS_FAILED", "Failed to delete orphan assets");
    }
  }
);

/**
 * ============================
 * GET /config
 * ============================
 * Get upload configuration (for frontend display).
 */
router.get(
  "/config",
  requireAuth(),
  requirePermission(PERMISSIONS.PRODUCTS_WRITE),
  (_req, res) => {
    return sendOk(res, {
      configured: isCloudinaryConfigured(),
      defaultFolder: getDefaultFolder(),
      allowedMimeTypes: getAllowedMimeTypes(),
      maxFileSizeBytes: getMaxFileSizeBytes(),
      maxFileSizeMB: Math.round(getMaxFileSizeBytes() / (1024 * 1024)),
    });
  }
);

export default router;
