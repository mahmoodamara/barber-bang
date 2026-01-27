import express from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { sendOk, sendError } from "../utils/response.js";

const router = express.Router();

router.use(requireAuth());
router.use(requireRole("admin"));

const querySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    actorId: z.string().optional(),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    action: z.string().optional(),
    from: z.string().datetime().optional(), // ISO string
    to: z.string().datetime().optional(),   // ISO string
});

/**
 * GET /api/admin/audit-logs
 * List paginated audit logs with filtering
 */
router.get("/", async (req, res, next) => {
    try {
        const validation = querySchema.safeParse(req.query);
        if (!validation.success) {
            return sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters", { details: validation.error.format() });
        }

        const { page, limit, actorId, entityType, entityId, action, from, to } = validation.data;
        const skip = (page - 1) * limit;

        const filter = {};

        if (actorId && mongoose.isValidObjectId(actorId)) {
            filter.actorId = actorId;
        }

        if (entityType) {
            // Allow case-insensitive partial match? Or strict? 
            // strict is safer for indexing, but regex is more user-friendly. 
            // Default to strict per prompt "Reject unknown fields (strict)", but this is a query value.
            // Let's go with exact match for performance on indexed fields.
            filter.entityType = entityType;
        }

        if (entityId) {
            filter.entityId = entityId;
        }

        if (action) {
            // Case-insensitive regex for action search is usually desired
            filter.action = { $regex: action, $options: "i" };
        }

        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) filter.createdAt.$lte = new Date(to);
        }

        const [logs, total] = await Promise.all([
            AuditLog.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate("actorId", "name email role") // Moderate expansion
                .lean(),
            AuditLog.countDocuments(filter),
        ]);

        sendOk(res, logs, {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        });
    } catch (error) {
        next(error);
    }
});

export default router;
