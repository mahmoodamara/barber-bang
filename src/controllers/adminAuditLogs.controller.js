// src/controllers/adminAuditLogs.controller.js
import { listAuditLogs as listAuditLogsSvc } from "../services/auditLog.service.js";

export async function listAuditLogs(req, res) {
  const q = req.validated?.query || req.query || {};
  const out = await listAuditLogsSvc({ q });

  return res.json({
    ok: true,
    data: {
      items: out.items,
      meta: out.meta,
    },
  });
}
