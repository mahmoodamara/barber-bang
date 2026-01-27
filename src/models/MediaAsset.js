// src/models/MediaAsset.js
import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * ============================
 * MediaAsset Model
 * ============================
 * Stores metadata for uploaded media files (Cloudinary).
 * Used for the admin media library.
 */
const mediaAssetSchema = new Schema(
  {
    // Cloudinary public_id (unique identifier)
    publicId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 256,
    },

    // URLs
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 512,
    },
    secureUrl: {
      type: String,
      required: true,
      trim: true,
      maxlength: 512,
    },

    // Image dimensions
    width: {
      type: Number,
      default: null,
      min: 0,
    },
    height: {
      type: Number,
      default: null,
      min: 0,
    },

    // File size in bytes
    bytes: {
      type: Number,
      default: null,
      min: 0,
    },

    // File format (jpg, png, webp, etc.)
    format: {
      type: String,
      default: "",
      trim: true,
      maxlength: 20,
    },

    // Cloudinary folder
    folder: {
      type: String,
      default: "",
      trim: true,
      maxlength: 128,
    },

    // Tags for organization/filtering
    tags: {
      type: [String],
      default: [],
    },

    // Original filename (for display purposes)
    originalFilename: {
      type: String,
      default: "",
      trim: true,
      maxlength: 256,
    },

    // Alt text for accessibility (bilingual)
    altHe: {
      type: String,
      default: "",
      trim: true,
      maxlength: 256,
    },
    altAr: {
      type: String,
      default: "",
      trim: true,
      maxlength: 256,
    },

    // Resource type (image, video, raw)
    resourceType: {
      type: String,
      default: "image",
      trim: true,
      maxlength: 20,
    },

    // Who uploaded this asset
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Soft delete flag
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * ============================
 * Indexes
 * ============================
 */

// Unique publicId (already declared in schema, but explicit for clarity)
// mediaAssetSchema.index({ publicId: 1 }, { unique: true }); // Removed duplicate

// Fast listing by creation date
mediaAssetSchema.index({ createdAt: -1 });

// Search by tags
mediaAssetSchema.index({ tags: 1 });

// Filter by folder
mediaAssetSchema.index({ folder: 1, createdAt: -1 });

// Filter by creator
mediaAssetSchema.index({ createdBy: 1, createdAt: -1 });

// Text search on filename and alt text
mediaAssetSchema.index(
  {
    originalFilename: "text",
    publicId: "text",
    altHe: "text",
    altAr: "text",
  },
  {
    weights: {
      originalFilename: 10,
      publicId: 5,
      altHe: 3,
      altAr: 3,
    },
    name: "MediaAssetTextIndex",
  }
);

/**
 * Pre-save hook: normalize tags
 */
mediaAssetSchema.pre("save", function (next) {
  if (Array.isArray(this.tags)) {
    this.tags = this.tags
      .map((t) => String(t || "").trim().toLowerCase())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i); // unique
  }
  next();
});

export const MediaAsset = mongoose.model("MediaAsset", mediaAssetSchema);
