// src/models/AuditLog.js
import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Production-grade AuditLog schema for comprehensive action tracking.
 *
 * Goals:
 * - Track "who did what, when, from where, and what changed"
 * - Support full user journey: auth → cart → order → payment → admin actions
 * - Never store sensitive data (passwords, tokens, OTP, card data)
 * - Performant, searchable, and safe-by-default
 */

const ActorSchema = new Schema(
  {
    actorType: {
      type: String,
      enum: ["user", "staff", "admin", "system", "anonymous"],
      default: "anonymous",
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
    email: { type: String, maxlength: 180, default: null }, // snapshot, lowercased
    roles: { type: [String], default: [] },
  },
  { _id: false },
);

const EntitySchema = new Schema(
  {
    entityType: { type: String, maxlength: 80, index: true, default: null }, // e.g. "Order", "Cart", "User"
    entityId: { type: String, maxlength: 100, index: true, default: null }, // ObjectId or external ID (e.g. Stripe event)
  },
  { _id: false },
);

const RouteSchema = new Schema(
  {
    method: { type: String, maxlength: 10, default: null }, // GET, POST, etc.
    path: { type: String, maxlength: 300, default: null }, // /api/v1/orders/:id/checkout
  },
  { _id: false },
);

const MetaSchema = new Schema(
  {
    lang: { type: String, enum: ["he", "ar", null], default: null },
    idempotencyKey: { type: String, maxlength: 120, default: null },
    durationMs: { type: Number, default: null },
    httpStatus: { type: Number, default: null },
  },
  { _id: false },
);

const ErrorSchema = new Schema(
  {
    code: { type: String, maxlength: 80, default: null },
    message: { type: String, maxlength: 500, default: null },
    stack: { type: String, maxlength: 2000, default: null }, // only in non-prod or with flag
  },
  { _id: false },
);

const AuditLogSchema = new Schema(
  {
    // Request context
    requestId: { type: String, maxlength: 120, index: true, default: null },

    // Who performed the action
    actor: { type: ActorSchema, default: () => ({}) },

    // Legacy fields for backward compatibility (will be migrated to actor subdoc)
    actorId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
    actorRoles: { type: [String], default: [] },
    actorEmail: { type: String, maxlength: 180, default: null },

    // What action was performed
    action: {
      type: String,
      required: true,
      maxlength: 120,
      index: true,
    }, // e.g. "AUTH_LOGIN", "CART_ADD_ITEM", "ORDER_CREATE_DRAFT"

    // Legacy event field (alias for action)
    event: { type: String, maxlength: 120, index: true, default: null },

    // What entity was affected
    entity: { type: EntitySchema, default: () => ({}) },

    // Legacy fields for backward compatibility
    resource: { type: String, maxlength: 80, index: true, default: null },
    targetId: { type: Schema.Types.ObjectId, index: true, default: null },

    // Outcome
    status: {
      type: String,
      enum: ["success", "fail"],
      required: true,
      index: true,
    },

    // Legacy outcome field
    outcome: { type: String, enum: ["success", "failure"], index: true, default: null },

    // Severity
    severity: {
      type: String,
      enum: ["info", "warn", "error"],
      default: "info",
      index: true,
    },

    // Request metadata
    ip: { type: String, maxlength: 80, default: null },
    userAgent: { type: String, maxlength: 500, default: null },
    route: { type: RouteSchema, default: () => ({}) },

    // Additional metadata
    meta: { type: MetaSchema, default: () => ({}) },

    // Legacy meta field (mixed type for backward compatibility)
    metaLegacy: { type: Schema.Types.Mixed, default: {} },

    // Change tracking (for updates)
    diff: { type: Schema.Types.Mixed, default: null }, // { field: { before, after } }

    // Error details (for failures)
    error: { type: ErrorSchema, default: null },

    // Legacy fields
    statusCode: { type: Number, default: null },
    message: { type: String, maxlength: 500, default: "" },

    // Tags for fast filtering
    tags: { type: [String], default: [], index: true },
  },
  {
    timestamps: true,
    minimize: true,
    collection: "auditlogs",
  },
);

// ─────────────────────────────────────────────────────────────
// Indexes for efficient querying
// ─────────────────────────────────────────────────────────────

// Time-based queries (most common)
AuditLogSchema.index({ createdAt: -1 });

// User journey tracking
AuditLogSchema.index({ "actor.userId": 1, createdAt: -1 });
AuditLogSchema.index({ actorId: 1, createdAt: -1 }); // legacy

// Action-based filtering
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ event: 1, createdAt: -1 }); // legacy

// Entity tracking
AuditLogSchema.index({ "entity.entityType": 1, "entity.entityId": 1, createdAt: -1 });
AuditLogSchema.index({ resource: 1, targetId: 1, createdAt: -1 }); // legacy

// Status/severity filtering
AuditLogSchema.index({ status: 1, createdAt: -1 });
AuditLogSchema.index({ outcome: 1, createdAt: -1 }); // legacy
AuditLogSchema.index({ severity: 1, createdAt: -1 });

// Request tracking
AuditLogSchema.index({ requestId: 1 });

// Compound indexes for admin dashboard
AuditLogSchema.index({ createdAt: -1, status: 1 });
AuditLogSchema.index({ createdAt: -1, "actor.actorType": 1 });
AuditLogSchema.index({ "actor.actorType": 1, action: 1, createdAt: -1 });

// Text search for admin queries
AuditLogSchema.index(
  {
    action: "text",
    event: "text",
    "entity.entityType": "text",
    resource: "text",
    message: "text",
    "actor.email": "text",
    actorEmail: "text",
  },
  {
    name: "audit_text_search",
    weights: {
      action: 10,
      event: 10,
      "entity.entityType": 5,
      resource: 5,
      message: 3,
      "actor.email": 2,
      actorEmail: 2,
    },
  },
);

// TTL index for automatic cleanup (optional - 1 year retention)
// Uncomment if you want automatic expiration:
// AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

// ─────────────────────────────────────────────────────────────
// Virtual for unified actor access
// ─────────────────────────────────────────────────────────────

AuditLogSchema.virtual("actorInfo").get(function () {
  // Prefer new actor subdoc, fallback to legacy fields
  if (this.actor?.userId || this.actor?.actorType !== "anonymous") {
    return this.actor;
  }
  return {
    actorType: this.actorId ? "user" : "anonymous",
    userId: this.actorId,
    email: this.actorEmail,
    roles: this.actorRoles || [],
  };
});

AuditLogSchema.virtual("entityInfo").get(function () {
  // Prefer new entity subdoc, fallback to legacy fields
  if (this.entity?.entityType || this.entity?.entityId) {
    return this.entity;
  }
  return {
    entityType: this.resource,
    entityId: this.targetId ? String(this.targetId) : null,
  };
});

// ─────────────────────────────────────────────────────────────
// Pre-save hook for backward compatibility
// ─────────────────────────────────────────────────────────────

AuditLogSchema.pre("save", function (next) {
  // Sync legacy fields if new fields are set
  if (this.actor?.userId && !this.actorId) {
    this.actorId = this.actor.userId;
  }
  if (this.actor?.email && !this.actorEmail) {
    this.actorEmail = this.actor.email;
  }
  if (this.actor?.roles?.length && !this.actorRoles?.length) {
    this.actorRoles = this.actor.roles;
  }

  // Sync event/action
  if (this.action && !this.event) {
    this.event = this.action;
  }

  // Sync entity fields
  if (this.entity?.entityType && !this.resource) {
    this.resource = this.entity.entityType;
  }
  if (this.entity?.entityId && !this.targetId) {
    const eid = this.entity.entityId;
    if (mongoose.Types.ObjectId.isValid(eid)) {
      this.targetId = new mongoose.Types.ObjectId(eid);
    }
  }

  // Sync status/outcome
  if (this.status && !this.outcome) {
    this.outcome = this.status === "fail" ? "failure" : "success";
  }

  next();
});

export const AuditLog = mongoose.models.AuditLog || mongoose.model("AuditLog", AuditLogSchema);
