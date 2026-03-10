import mongoose from "mongoose";

const HERO_MEDIA_TYPES = new Set(["image", "slider", "video"]);

const sectionSchema = new mongoose.Schema({
    id: { type: String, required: true }, // unique UI id
    type: {
        type: String,
        required: true,
        enum: ["hero", "categories", "featured-products", "banner", "text", "grid-products"]
    },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible content
}, { _id: false });

const homeLayoutSchema = new mongoose.Schema(
    {
        sections: {
            type: [sectionSchema],
            default: [],
        },
    },
    {
        timestamps: true,
        optimisticConcurrency: true,
        autoCreate: true,
    }
);

/**
 * Lightweight payload validation per section type.
 * Ensures structural integrity without restricting flexibility.
 */
function validateSectionPayload(section) {
    const { type, payload } = section;
    if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
        return "payload must be a plain object";
    }

    // Limit payload size to prevent abuse (max 50KB JSON stringified)
    const payloadStr = JSON.stringify(payload);
    if (payloadStr.length > 51200) {
        return "payload exceeds maximum allowed size (50KB)";
    }

    // Type-specific structural checks (non-exhaustive, defensive)
    switch (type) {
        case "hero":
            // hero may have: mediaType, imageUrl, images[], videoUrl, title, subtitle, ctaText, ctaLink
            if (payload.mediaType && (typeof payload.mediaType !== "string" || !HERO_MEDIA_TYPES.has(payload.mediaType))) {
                return "hero.mediaType must be one of: image, slider, video";
            }
            if (payload.imageUrl && typeof payload.imageUrl !== "string") {
                return "hero.imageUrl must be a string";
            }
            if (payload.videoUrl && typeof payload.videoUrl !== "string") {
                return "hero.videoUrl must be a string";
            }
            if (payload.videoPosterUrl && typeof payload.videoPosterUrl !== "string") {
                return "hero.videoPosterUrl must be a string";
            }
            if (payload.images != null) {
                if (!Array.isArray(payload.images)) {
                    return "hero.images must be an array of strings";
                }
                if (payload.images.length > 12) {
                    return "hero.images cannot exceed 12 items";
                }
                const hasInvalidImage = payload.images.some((item) => item && typeof item !== "string");
                if (hasInvalidImage) {
                    return "hero.images must contain only strings";
                }
            }
            break;

        case "banner":
            // banner may have: imageUrl, link, altText
            if (payload.imageUrl && typeof payload.imageUrl !== "string") {
                return "banner.imageUrl must be a string";
            }
            break;

        case "text":
            // text may have: contentHe, contentAr
            if (payload.contentHe && typeof payload.contentHe !== "string") {
                return "text.contentHe must be a string";
            }
            if (payload.contentAr && typeof payload.contentAr !== "string") {
                return "text.contentAr must be a string";
            }
            break;

        case "categories":
        case "featured-products":
        case "grid-products":
            // These may have: limit, categoryId, title
            if (payload.limit != null && typeof payload.limit !== "number") {
                return `${type}.limit must be a number`;
            }
            if (payload.limit != null && (payload.limit < 1 || payload.limit > 100)) {
                return `${type}.limit must be between 1 and 100`;
            }
            break;
    }

    return null; // Valid
}

homeLayoutSchema.pre("validate", function (next) {
    if (!Array.isArray(this.sections)) {
        return next();
    }

    // Check for duplicate section IDs
    const ids = new Set();
    for (const section of this.sections) {
        if (!section || !section.id) continue;

        if (ids.has(section.id)) {
            return next(new Error(`Duplicate section id: ${section.id}`));
        }
        ids.add(section.id);

        const payloadError = validateSectionPayload(section);
        if (payloadError) {
            return next(new Error(`Section "${section.id}": ${payloadError}`));
        }
    }

    next();
});

// Ensure only one layout doc exists typically
export const HomeLayout = mongoose.model("HomeLayout", homeLayoutSchema);
