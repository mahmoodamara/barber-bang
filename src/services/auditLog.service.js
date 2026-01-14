// src/services/auditLog.service.js
/**
 * Legacy audit log service - re-exports from audit.service.js
 * Maintained for backward compatibility with existing code.
 */

export {
  logAdminAction,
  listAuditLogs,
  logAudit,
  logAuditSuccess,
  logAuditFail,
  sanitizeAuditMeta,
  buildActor,
  computeDiff,
  AuditActions,
} from "./audit.service.js";
