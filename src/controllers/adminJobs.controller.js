import {
  adminGetJob as adminGetJobSvc,
  adminListJobs as adminListJobsSvc,
  adminRetryFailedJobs as adminRetryFailedJobsSvc,
  adminRetryJob as adminRetryJobSvc,
} from "../services/adminJobs.service.js";
import { logAuditFail, logAuditSuccess, AuditActions } from "../services/audit.service.js";

function ctx(req) {
  return {
    actorId: req.auth?.userId || null,
    roles: req.auth?.roles || [],
    requestId: req.requestId || req.id || null,
    ip: req.ip || null,
    userAgent: req.headers?.["user-agent"] || null,
  };
}

export async function adminListJobs(req, res) {
  const q = req.validated?.query || req.query || {};
  const out = await adminListJobsSvc({ q, ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminGetJob(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const out = await adminGetJobSvc(id, { ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminRetryJob(req, res) {
  const id = req.validated?.params?.id || req.params?.id;

  try {
    const out = await adminRetryJobSvc(id, { ctx: ctx(req) });

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_JOB_RETRY,
      { type: "Job", id },
      { message: "Admin job retry", meta: { jobId: id } },
    );

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_JOB_RETRY, { type: "Job", id }, err);
    throw err;
  }
}

export async function adminRetryFailedJobs(req, res) {
  const body = req.validated?.body || {};

  try {
    const out = await adminRetryFailedJobsSvc(body, { ctx: ctx(req) });

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_JOB_RETRY_FAILED_BULK,
      { type: "Job", id: null },
      { message: "Admin bulk retry failed jobs", meta: { limit: body.limit, retried: out.retried } },
    );

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_JOB_RETRY_FAILED_BULK, { type: "Job", id: null }, err);
    throw err;
  }
}

