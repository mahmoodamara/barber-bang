import mongoose from "mongoose";

import { Job } from "../models/Job.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import {
  buildListEnvelope,
  buildSearchOrFilter,
  isValidObjectId,
  parseAdminPagination,
  parseSort,
} from "../utils/adminQuery.js";
import { sanitizeAuditMeta } from "./audit.service.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function oidOrNull(v) {
  const s = String(v || "");
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function pickRelatedEntity(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const orderId = oidOrNull(p.orderId) || oidOrNull(p.order?.id) || oidOrNull(p.order?._id);
  const userId = oidOrNull(p.userId) || oidOrNull(p.user?.id) || oidOrNull(p.user?._id);
  return {
    ...(orderId ? { orderId: String(orderId) } : {}),
    ...(userId ? { userId: String(userId) } : {}),
  };
}

function toJobDTO(docOrLean, { includePayload = false } = {}) {
  if (!docOrLean) return docOrLean;
  const d = typeof docOrLean.toObject === "function" ? docOrLean.toObject() : docOrLean;

  const lastError = d.lastError ? String(d.lastError) : null;
  const relatedEntity = pickRelatedEntity(d.payload);

  return {
    id: String(d._id || d.id),
    _id: d._id || d.id,
    type: d.name,
    status: d.status,
    attempts: Number(d.attempts || 0),
    maxAttempts: Number(d.maxAttempts || 0),
    runAt: d.runAt || null,
    lockedUntil: d.lockedUntil || null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    finishedAt: d.finishedAt || null,
    lastErrorAt: d.status === "failed" && d.updatedAt ? d.updatedAt : null,
    errorMessage: lastError ? lastError.slice(0, 200) : null,
    ...(Object.keys(relatedEntity).length ? { relatedEntity } : {}),
    ...(includePayload ? { payloadMeta: sanitizeAuditMeta(d.payload || {}) } : {}),
    ...(includePayload ? { lastError: lastError ? lastError.slice(0, 2000) : null } : {}),
  };
}

export async function adminListJobs({ q }) {
  const { page, limit, skip } = parseAdminPagination(q, { defaultLimit: 20, maxLimit: 100 });

  const filter = {};

  if (q.status) filter.status = String(q.status);
  if (q.type) filter.name = String(q.type).trim();

  const searchTerm = String(q.q || "").trim();
  if (searchTerm) {
    if (isValidObjectId(searchTerm)) {
      const oid = new mongoose.Types.ObjectId(searchTerm);
      filter.$or = [
        { _id: oid },
        { "payload.orderId": oid },
        { "payload.userId": oid },
        { "payload.orderId": searchTerm },
        { "payload.userId": searchTerm },
      ];
    } else {
      const search = buildSearchOrFilter(searchTerm, ["name", "status", "lastError"]);
      if (search) Object.assign(filter, search);
    }
  }

  const sort = parseSort(q.sort, ["createdAt", "status", "updatedAt", "attempts"], {
    defaultSort: { createdAt: -1, _id: -1 },
  });

  const [items, total] = await Promise.all([
    applyQueryBudget(Job.find(filter).sort(sort).skip(skip).limit(limit).lean()),
    applyQueryBudget(Job.countDocuments(filter)),
  ]);

  return buildListEnvelope({
    items: items.map((j) => toJobDTO(j, { includePayload: false })),
    page,
    limit,
    total,
  });
}

export async function adminGetJob(jobId) {
  const job = await applyQueryBudget(Job.findById(jobId).lean());
  if (!job) throw httpError(404, "JOB_NOT_FOUND", "Job not found");
  return toJobDTO(job, { includePayload: true });
}

export async function adminRetryJob(jobId) {
  const job = await Job.findById(jobId);
  if (!job) throw httpError(404, "JOB_NOT_FOUND", "Job not found");

  if (job.status === "processing") {
    throw httpError(409, "JOB_IN_PROGRESS", "Job is currently processing");
  }

  if (job.status !== "failed") {
    throw httpError(409, "JOB_NOT_FAILED", "Only failed jobs can be retried", { status: job.status });
  }

  const maxAttempts = Number(job.maxAttempts || 8);
  const capAttempts = Math.max(0, maxAttempts - 1);

  job.status = "pending";
  job.runAt = new Date();
  job.lockId = null;
  job.lockedUntil = null;
  job.finishedAt = null;
  job.attempts = Math.min(Number(job.attempts || 0), capAttempts);

  await job.save();
  return toJobDTO(job, { includePayload: false });
}

export async function adminRetryFailedJobs({ limit } = {}) {
  const take = Math.min(100, Math.max(1, Number(limit || 20)));

  const jobs = await applyQueryBudget(
    Job.find({ status: "failed" }).sort({ updatedAt: -1, createdAt: -1 }).limit(take).lean(),
  );

  if (!jobs.length) return { retried: 0, ids: [] };

  const ops = jobs.map((j) => {
    const maxAttempts = Number(j.maxAttempts || 8);
    const capAttempts = Math.max(0, maxAttempts - 1);
    const attempts = Math.min(Number(j.attempts || 0), capAttempts);

    return {
      updateOne: {
        filter: { _id: j._id, status: "failed" },
        update: {
          $set: {
            status: "pending",
            runAt: new Date(),
            lockId: null,
            lockedUntil: null,
            finishedAt: null,
            attempts,
          },
        },
      },
    };
  });

  const r = await Job.bulkWrite(ops, { ordered: false });
  const retried = Number(r.modifiedCount || 0);
  const ids = jobs.map((j) => String(j._id));

  return { retried, ids };
}
