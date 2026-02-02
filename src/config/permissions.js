// src/config/permissions.js
export const PERMISSIONS = {
  ORDERS_WRITE: "ORDERS_WRITE",
  PRODUCTS_WRITE: "PRODUCTS_WRITE",
  PROMOS_WRITE: "PROMOS_WRITE",
  SETTINGS_WRITE: "SETTINGS_WRITE",
  REFUNDS_WRITE: "REFUNDS_WRITE",
  /** Read-only access to audit logs. Backward-compatible: admins implicitly have it. */
  AUDIT_READ: "AUDIT_READ",
};
