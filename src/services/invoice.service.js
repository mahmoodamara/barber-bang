// src/services/invoice.service.js
import { Order } from "../models/Order.js";
import { getReceiptUrlByPaymentIntent } from "./stripe.service.js";
import { computeAllocationRequirement } from "../utils/allocation.js";
import { createInvoiceForOrder as icountCreate } from "./invoice/providers/icount.provider.js";
import { createInvoiceForOrder as greeninvoiceCreate } from "./invoice/providers/greeninvoice.provider.js";
import { getInvoiceIssueCounter } from "../middleware/prometheus.js";

const INVOICE_ISSUING_STUCK_MIN = Number(process.env.INVOICE_ISSUING_STUCK_MIN) || 15;
const invoiceIssueTotal = getInvoiceIssueCounter();

function incInvoiceIssue(status, source = "initial") {
  try {
    invoiceIssueTotal.inc({ status, source });
  } catch {
    // metrics best-effort
  }
}

export function recordInvoiceIssueMetric(status, source = "initial") {
  incInvoiceIssue(status, source);
}

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function normalizeProvider(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  const allowed = new Set(["none", "stripe", "manual", "icount", "greeninvoice", "other"]);
  return allowed.has(v) ? v : "other";
}

function normalizeUrlBase(raw) {
  const base = String(raw || "").trim();
  if (!base) return "";
  return base.replace(/\/+$/, "");
}

export function resolveInvoiceProvider(order) {
  const envProvider = normalizeProvider(process.env.INVOICE_PROVIDER);
  if (envProvider) return envProvider;

  const method = String(order?.paymentMethod || "").trim().toLowerCase();
  return method === "stripe" ? "stripe" : "manual";
}

/**
 * Adapter interface: createInvoiceForOrder(order, { provider?, idempotencyKey })
 * @returns {Promise<{ invoiceNumber, providerDocId, url, issuedAt, raw, provider, docId, docType, number, status, error, allocation }>}
 * Legacy shape (provider, docId, docType, number, status, error, allocation) is included for backward compatibility.
 */
export async function createInvoiceForOrder(order, options = {}) {
  if (!order || !order._id) {
    throw makeErr(400, "ORDER_REQUIRED", "order is required to issue invoice");
  }

  const provider = options.provider ?? resolveInvoiceProvider(order);
  const docId = String(order._id);
  const idempotencyKey = options.idempotencyKey ?? "";

  if (provider === "none") {
    throw makeErr(400, "INVOICE_DISABLED", "Invoice issuing is disabled");
  }

  const allocation = computeAllocationRequirement({ order, pricing: order?.pricing });
  const allocationPayload = {
    required: allocation.required,
    status: allocation.status,
    thresholdBeforeVat: allocation.thresholdBeforeVat,
    requestedAt: null,
  };

  if (provider === "stripe") {
    let receiptUrl = String(order?.stripe?.receiptUrl || "");

    if (!receiptUrl) {
      const paymentIntentId = String(order?.stripe?.paymentIntentId || "");
      if (paymentIntentId) {
        receiptUrl = await getReceiptUrlByPaymentIntent(paymentIntentId);
      }
    }

    if (!receiptUrl) {
      throw makeErr(400, "STRIPE_RECEIPT_NOT_AVAILABLE", "Stripe receipt URL not available");
    }

    return {
      invoiceNumber: "",
      providerDocId: docId,
      url: receiptUrl,
      issuedAt: new Date(),
      raw: {},
      provider,
      docId,
      docType: "receipt_link",
      number: "",
      status: "issued",
      error: "",
      allocation: allocationPayload,
    };
  }

  if (provider === "manual") {
    const base = normalizeUrlBase(process.env.INVOICE_BASE_URL);
    const url = base ? `${base}/${encodeURIComponent(docId)}` : "";

    return {
      invoiceNumber: "",
      providerDocId: docId,
      url,
      issuedAt: url ? new Date() : null,
      raw: {},
      provider,
      docId,
      docType: "invoice",
      number: "",
      status: url ? "issued" : "pending",
      error: "",
      allocation: allocationPayload,
    };
  }

  if (provider === "icount") {
    const result = await icountCreate(order, { idempotencyKey });
    return {
      ...result,
      provider,
      docId: result.providerDocId || docId,
      docType: "invoice",
      number: result.invoiceNumber,
      status: "issued",
      error: "",
      allocation: allocationPayload,
    };
  }

  if (provider === "greeninvoice") {
    const result = await greeninvoiceCreate(order, { idempotencyKey });
    return {
      ...result,
      provider,
      docId: result.providerDocId || docId,
      docType: "invoice",
      number: result.invoiceNumber,
      status: "issued",
      error: "",
      allocation: allocationPayload,
    };
  }

  throw makeErr(501, "INVOICE_PROVIDER_NOT_IMPLEMENTED", `Invoice provider "${provider}" not implemented`);
}

/**
 * Atomic "issuing" lock: set invoice.status = "issuing" only if not already "issued".
 * Option stuckCutoff: Date; if set, also allow re-lock when status === "issuing" and issuingAt < stuckCutoff.
 * Returns { locked: boolean, order?, existingInvoice? }. If !locked, existingInvoice has current invoice snapshot (no-op).
 */
async function tryAcquireLock(orderId, stuckCutoff = null) {
  const now = new Date();
  const lockCondition = {
    _id: orderId,
    $or: stuckCutoff
      ? [
          { "invoice.status": { $exists: false } },
          { "invoice.status": "pending" },
          { "invoice.status": "failed" },
          { "invoice.status": "issuing", "invoice.issuingAt": { $lt: stuckCutoff } },
        ]
      : [
          { "invoice.status": { $exists: false } },
          { "invoice.status": "pending" },
          { "invoice.status": "failed" },
        ],
  };
  const updated = await Order.findOneAndUpdate(
    lockCondition,
    { $set: { "invoice.status": "issuing", "invoice.issuingAt": now } },
    { new: true }
  );
  if (updated) {
    return { locked: true, order: updated };
  }
  const order = await Order.findById(orderId).lean();
  return {
    locked: false,
    order,
    existingInvoice: order?.invoice
      ? {
          status: order.invoice.status,
          number: order.invoice.number,
          url: order.invoice.url,
          issuedAt: order.invoice.issuedAt,
          providerDocId: order.invoice.providerDocId,
        }
      : null,
  };
}

/**
 * Issue invoice with atomic lock. Prevents duplicate invoices on webhook duplicates.
 * On success: sets issued + snapshot; on failure: sets failed + lastErrorCode, lastErrorAt (short message).
 * Payment flow must never be blocked by invoice errors.
 */
export async function issueInvoiceWithLock(orderId, options = {}) {
  const idempotencyKey = options.idempotencyKey ?? "";
  const stuckCutoff = options.stuckCutoff ?? null;
  const source = String(options.source || "initial");

  const { locked, order, existingInvoice } = await tryAcquireLock(orderId, stuckCutoff);
  if (!locked) {
    return { ok: true, alreadyIssued: true, existingInvoice };
  }
  if (!order) {
    return { ok: false, error: "ORDER_NOT_FOUND" };
  }

  const provider = resolveInvoiceProvider(order);
  if (provider === "none") {
    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          "invoice.status": "failed",
          "invoice.lastErrorCode": "INVOICE_DISABLED",
          "invoice.lastErrorAt": new Date(),
          "invoice.error": "Invoice issuing is disabled",
        },
        $unset: { "invoice.issuingAt": "" },
      }
    );
    incInvoiceIssue("failure", source);
    return { ok: false, error: "INVOICE_DISABLED" };
  }

  try {
    const invoice = await createInvoiceForOrder(order, { idempotencyKey });
    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          "invoice.provider": invoice.provider,
          "invoice.docId": invoice.docId || "",
          "invoice.providerDocId": invoice.providerDocId || "",
          "invoice.idempotencyKey": idempotencyKey,
          "invoice.docType": invoice.docType || "",
          "invoice.number": invoice.number || "",
          "invoice.url": invoice.url || "",
          "invoice.issuedAt": invoice.issuedAt || null,
          "invoice.status": "issued",
          "invoice.error": "",
          "invoice.snapshot": invoice.raw && typeof invoice.raw === "object" ? invoice.raw : null,
          "invoice.allocation": invoice.allocation || {},
        },
        $unset: { "invoice.issuingAt": "", "invoice.lastErrorCode": "", "invoice.lastErrorAt": "" },
      }
    );
    incInvoiceIssue("success", source);
    return { ok: true, issued: true, invoice };
  } catch (e) {
    const code = (e?.code || "INVOICE_PROVIDER_ERROR").slice(0, 64);
    const message = String(e?.message || "Invoice failed").slice(0, 256);
    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          "invoice.provider": provider,
          "invoice.docId": String(orderId),
          "invoice.status": "failed",
          "invoice.lastErrorCode": code,
          "invoice.lastErrorAt": new Date(),
          "invoice.error": message,
        },
        $unset: { "invoice.issuingAt": "" },
      }
    );
    incInvoiceIssue("failure", source);
    return { ok: false, error: code, message };
  }
}

/**
 * Retry invoice issuance for an order (e.g. from retry job). Uses stuck cutoff to re-lock stuck "issuing".
 */
export async function retryInvoiceForOrder(orderId) {
  const stuckMin = INVOICE_ISSUING_STUCK_MIN;
  const stuckCutoff = new Date(Date.now() - stuckMin * 60 * 1000);
  return issueInvoiceWithLock(orderId, { stuckCutoff, source: "retry" });
}
