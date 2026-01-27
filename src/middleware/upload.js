// src/middleware/upload.js
import multer from "multer";
import {
  isAllowedMimeType,
  getAllowedMimeTypes,
  getMaxFileSizeBytes,
} from "../config/cloudinary.js";

/**
 * ============================
 * Multer Upload Middleware
 * ============================
 * Memory storage (no disk writes) for security.
 * Validates file type and size before processing.
 */

// Custom file filter for allowed image types
function imageFileFilter(req, file, cb) {
  const mimeType = String(file.mimetype || "").toLowerCase();

  if (!isAllowedMimeType(mimeType)) {
    const err = new Error(
      `Invalid file type. Allowed types: ${getAllowedMimeTypes().join(", ")}`
    );
    err.code = "INVALID_FILE_TYPE";
    err.statusCode = 400;
    return cb(err, false);
  }

  cb(null, true);
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WEBP (RIFF....WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

export function validateImageMagic(req, _res, next) {
  const file = req.file;
  if (!file || !file.buffer) return next();

  const detected = detectImageMime(file.buffer);
  if (!detected || !isAllowedMimeType(detected)) {
    const err = new Error("File content does not match allowed image types");
    err.code = "FILE_TYPE_MISMATCH";
    err.statusCode = 400;
    return next(err);
  }

  return next();
}

// Memory storage configuration
const storage = multer.memoryStorage();

/**
 * Single image upload middleware
 * Field name: "file"
 * Max size: configurable via CLOUDINARY_MAX_FILE_SIZE env (default 5MB)
 */
export const uploadSingleImage = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: getMaxFileSizeBytes(),
    files: 1,
  },
}).single("file");

/**
 * Multiple images upload middleware
 * Field name: "files"
 * Max files: 10
 */
export const uploadMultipleImages = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: getMaxFileSizeBytes(),
    files: 10,
  },
}).array("files", 10);

/**
 * Wrapper to handle multer errors consistently
 * Returns errors in standard API format
 */
export function handleUploadError(err, req, res, next) {
  if (!err) return next();

  // Multer-specific errors
  if (err instanceof multer.MulterError) {
    let message = "File upload error";
    let code = "UPLOAD_ERROR";

    switch (err.code) {
      case "LIMIT_FILE_SIZE":
        message = `File too large. Maximum size: ${Math.round(getMaxFileSizeBytes() / (1024 * 1024))}MB`;
        code = "FILE_TOO_LARGE";
        break;
      case "LIMIT_FILE_COUNT":
        message = "Too many files";
        code = "TOO_MANY_FILES";
        break;
      case "LIMIT_UNEXPECTED_FILE":
        message = "Unexpected field name for file upload";
        code = "UNEXPECTED_FIELD";
        break;
      default:
        message = err.message || "File upload error";
    }

    return res.status(400).json({
      ok: false,
      error: {
        code,
        message,
        requestId: req.requestId || "",
        path: req.originalUrl || req.url || "",
      },
    });
  }

  // Custom file filter errors
  if (err.code === "INVALID_FILE_TYPE" || err.code === "FILE_TYPE_MISMATCH") {
    return res.status(400).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        requestId: req.requestId || "",
        path: req.originalUrl || req.url || "",
      },
    });
  }

  // Pass other errors to global handler
  next(err);
}
