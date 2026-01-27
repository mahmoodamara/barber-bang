// src/services/invoice.service.js
import { getReceiptUrlByPaymentIntent } from "./stripe.service.js";
import { computeAllocationRequirement } from "../utils/allocation.js";

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

export async function createInvoiceForOrder(order) {
  if (!order || !order._id) {
    throw makeErr(400, "ORDER_REQUIRED", "order is required to issue invoice");
  }

  const provider = resolveInvoiceProvider(order);
  const docId = String(order._id);

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
      provider,
      docId,
      docType: "receipt_link",
      number: "",
      url: receiptUrl,
      issuedAt: new Date(),
      status: "issued",
      error: "",
      allocation: allocationPayload,
    };
  }

  if (provider === "manual") {
    const base = normalizeUrlBase(process.env.INVOICE_BASE_URL);
    const url = base ? `${base}/${encodeURIComponent(docId)}` : "";

    return {
      provider,
      docId,
      docType: "invoice",
      number: "",
      url,
      issuedAt: url ? new Date() : null,
      status: url ? "issued" : "pending",
      error: "",
      allocation: allocationPayload,
    };
  }

  throw makeErr(501, "INVOICE_PROVIDER_NOT_IMPLEMENTED", `Invoice provider "${provider}" not implemented`);
}
