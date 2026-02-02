// src/services/invoice/providers/icount.provider.js
/**
 * Icount Israel invoice provider. Credentials from ENV: ICOUNT_API_URL, ICOUNT_API_KEY.
 * No hardcoded secrets. Uses timeout + retry (no API keys or PII in logs).
 */

import { fetchWithTimeout, retryWithBackoff, isRetryableStatus } from "../httpClient.js";

function makeErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function redactSnapshot(res) {
  if (!res || typeof res !== "object") return res;
  const out = {};
  if (res.id != null) out.id = res.id;
  if (res.number != null) out.number = String(res.number);
  if (res.doc_number != null) out.doc_number = res.doc_number;
  if (res.url != null) out.url = typeof res.url === "string" ? res.url.slice(0, 120) : res.url;
  return out;
}

/**
 * Create invoice in Icount for order.
 * @param {object} order - Order doc (items, pricing, shipping, etc.)
 * @param {{ idempotencyKey?: string }} options
 * @returns {Promise<{ invoiceNumber: string, providerDocId: string, url: string, issuedAt: Date, raw: object }>}
 */
export async function createInvoiceForOrder(order, options = {}) {
  const baseUrl = String(process.env.ICOUNT_API_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.ICOUNT_API_KEY || "").trim();
  if (!baseUrl || !apiKey) {
    throw makeErr("INVOICE_CONFIG", "ICOUNT_API_URL and ICOUNT_API_KEY are required for Icount provider");
  }

  const total = Number(order?.pricing?.total ?? 0);
  const totalBeforeVat = Number(order?.pricing?.totalBeforeVat ?? order?.pricing?.total ?? 0);
  const vatAmount = Number(order?.pricing?.vatAmount ?? 0);
  const currency = String(order?.currency || "ILS").toUpperCase();

  const payload = {
    type: "inv",
    customer: {
      name: order?.shipping?.address?.fullName || order?.shipping?.phone || "Customer",
      address: [order?.shipping?.address?.street, order?.shipping?.address?.city].filter(Boolean).join(", ") || "",
      phone: order?.shipping?.phone || "",
      email: order?.shipping?.email || "",
      vat_id: order?.invoice?.customerVatId || "",
    },
    items: (order?.items || []).map((item) => ({
      description: item?.titleHe || item?.title || "Item",
      quantity: Number(item?.qty ?? 1),
      price: Number(item?.unitPrice ?? 0),
      vat_rate: Number(order?.pricing?.vatRate ?? 17),
    })),
    totals: {
      total_before_vat: totalBeforeVat,
      vat: vatAmount,
      total: total,
    },
    currency,
    ...(options?.idempotencyKey ? { idempotency_key: options.idempotencyKey.slice(0, 128) } : {}),
  };

  const url = `${baseUrl}/api/v3/documents`;
  const timeoutMs = Number(process.env.INVOICE_HTTP_TIMEOUT_MS) || 10000;
  const retries = Number(process.env.INVOICE_HTTP_RETRIES) || 2;

  const { body } = await retryWithBackoff(
    async () => {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        },
        timeoutMs
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (isRetryableStatus(res.status)) {
          throw new Error(`Icount HTTP ${res.status}`);
        }
        const msg = (body?.message || body?.error || res.statusText || "Icount API error").slice(0, 120);
        throw makeErr("INVOICE_PROVIDER_ERROR", `Icount: ${msg}`);
      }
      return { res, body };
    },
    { retries }
  );

  const providerDocId = String(body?.id ?? body?.doc_id ?? body?.data?.id ?? "");
  const invoiceNumber = String(body?.number ?? body?.doc_number ?? body?.data?.number ?? "");
  const invoiceUrl = String(body?.url ?? body?.link ?? body?.data?.url ?? "").slice(0, 512);
  const issuedAt = body?.created_at ? new Date(body.created_at) : new Date();

  return {
    invoiceNumber,
    providerDocId: providerDocId || String(order._id),
    url: invoiceUrl,
    issuedAt,
    raw: redactSnapshot(body),
  };
}
