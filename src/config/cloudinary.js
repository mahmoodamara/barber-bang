// src/config/cloudinary.js
import { v2 as cloudinary } from "cloudinary";

/**
 * ============================
 * Cloudinary Configuration
 * ============================
 * Environment variables:
 * - CLOUDINARY_CLOUD_NAME (required)
 * - CLOUDINARY_API_KEY (required)
 * - CLOUDINARY_API_SECRET (required) — must match Cloudinary Dashboard exactly; "Invalid Signature" = wrong secret on server (e.g. Render env)
 * - CLOUDINARY_FOLDER (optional, default: "barber-store")
 */

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "";
const API_KEY = process.env.CLOUDINARY_API_KEY || "";
const API_SECRET = process.env.CLOUDINARY_API_SECRET || "";
const DEFAULT_FOLDER = process.env.CLOUDINARY_FOLDER || "barber-store";

// Allowed image MIME types (security: disallow SVG by default)
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

// Max file size in bytes (5MB default)
const MAX_FILE_SIZE_BYTES = Number(process.env.CLOUDINARY_MAX_FILE_SIZE) || 5 * 1024 * 1024;

let configured = false;

/**
 * Initialize Cloudinary with environment credentials
 * Called lazily on first upload/delete
 */
function ensureConfigured() {
  if (configured) return;

  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    throw new Error(
      "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required"
    );
  }

  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: API_KEY,
    api_secret: API_SECRET,
    secure: true,
  });

  configured = true;
}

/**
 * Check if Cloudinary is properly configured
 * @returns {boolean}
 */
export function isCloudinaryConfigured() {
  return Boolean(CLOUD_NAME && API_KEY && API_SECRET);
}

/**
 * Validate file type against allowed MIME types
 * @param {string} mimeType
 * @returns {boolean}
 */
export function isAllowedMimeType(mimeType) {
  return ALLOWED_MIME_TYPES.has(String(mimeType || "").toLowerCase());
}

/**
 * Get allowed MIME types for validation messages
 * @returns {string[]}
 */
export function getAllowedMimeTypes() {
  return Array.from(ALLOWED_MIME_TYPES);
}

/**
 * Get max file size in bytes
 * @returns {number}
 */
export function getMaxFileSizeBytes() {
  return MAX_FILE_SIZE_BYTES;
}

/**
 * Get default folder name
 * @returns {string}
 */
export function getDefaultFolder() {
  return DEFAULT_FOLDER;
}

/**
 * Upload a buffer to Cloudinary
 * @param {Object} options
 * @param {Buffer} options.buffer - File buffer to upload
 * @param {string} [options.filename] - Original filename (for public_id generation)
 * @param {string} [options.folder] - Folder in Cloudinary (default: from env)
 * @param {string[]} [options.tags] - Tags for organization
 * @param {string} [options.resourceType="image"] - Resource type
 * @returns {Promise<Object>} Cloudinary upload result
 */
export async function uploadBuffer({
  buffer,
  filename = "",
  folder = DEFAULT_FOLDER,
  tags = [],
  resourceType = "image",
}) {
  ensureConfigured();

  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("Invalid buffer provided");
  }

  // Generate a clean public_id from filename
  const timestamp = Date.now();
  const cleanName = String(filename || "image")
    .replace(/\.[^/.]+$/, "") // remove extension
    .replace(/[^a-zA-Z0-9_-]/g, "_") // sanitize
    .substring(0, 50); // limit length

  const publicId = `${folder}/${cleanName}_${timestamp}`;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        folder: folder,
        public_id: `${cleanName}_${timestamp}`,
        tags: Array.isArray(tags) ? tags : [],
        // Optimization transformations
        transformation: [
          {
            quality: "auto",
            fetch_format: "auto",
          },
        ],
        // Security: disallow overwriting existing files
        overwrite: false,
        // Ensure unique naming
        unique_filename: true,
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }
        resolve(result);
      }
    );

    // Write buffer to stream
    uploadStream.end(buffer);
  });
}

/**
 * Delete an asset from Cloudinary by public_id
 * @param {string} publicId - The public_id of the asset to delete
 * @param {string} [resourceType="image"] - Resource type
 * @returns {Promise<Object>} Cloudinary delete result
 */
export async function deleteByPublicId(publicId, resourceType = "image") {
  ensureConfigured();

  if (!publicId || typeof publicId !== "string") {
    throw new Error("Invalid publicId provided");
  }

  return cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true, // Invalidate CDN cache
  });
}

/**
 * Get asset details from Cloudinary
 * @param {string} publicId
 * @param {string} [resourceType="image"]
 * @returns {Promise<Object>}
 */
export async function getAssetDetails(publicId, resourceType = "image") {
  ensureConfigured();

  if (!publicId || typeof publicId !== "string") {
    throw new Error("Invalid publicId provided");
  }

  return cloudinary.api.resource(publicId, {
    resource_type: resourceType,
  });
}

export { cloudinary };
