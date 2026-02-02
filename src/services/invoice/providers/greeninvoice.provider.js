// src/services/invoice/providers/greeninvoice.provider.js
/**
 * GreenInvoice Israel invoice provider. Credentials from ENV: GREENINVOICE_API_URL, GREENINVOICE_API_KEY.
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
  if (res.url != null) out.url = typeof res.url === "string" ? res.url.slice(0, 120) : res.url;
  return out;
}

/**
 * Create invoice in GreenInvoice for order.
 * @param {object} order - Order doc
 * @param {{ idempotencyKey?: string }} options
 * @returns {Promise<{ invoiceNumber: string, providerDocId: string, url: string, issuedAt: Date, raw: object }>}
 */
export async function createInvoiceForOrder(order, options = {}) {
  const baseUrl = String(process.env.GREENINVOICE_API_URL || "https://api.greeninvoice.co.il").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.GREENINVOICE_API_KEY || "").trim();
  if (!apiKey) {
    throw makeErr("INVOICE_CONFIG", "GREENINVOICE_API_KEY is required for GreenInvoice provider");
  }

  const total = Number(order?.pricing?.total ?? 0);
  const totalBeforeVat = Number(order?.pricing?.totalBeforeVat ?? order?.pricing?.total ?? 0);
  const vatAmount = Number(order?.pricing?.vatAmount ?? 0);
  const vatRate = Number(order?.pricing?.vatRate ?? 17);

  const payload = {
    type: 320,
    documentType: "invoice",
    client: {
      name: order?.shipping?.address?.fullName || order?.shipping?.phone || "Customer",
      address: [order?.shipping?.address?.street, order?.shipping?.address?.city].filter(Boolean).join(", ") || "",
      phone: order?.shipping?.phone || "",
      email: order?.shipping?.email || "",
      vatId: order?.invoice?.customerVatId || "",
    },
    items: (order?.items || []).map((item) => ({
      description: item?.titleHe || item?.title || "Item",
      quantity: Number(item?.qty ?? 1),
      price: Number(item?.unitPrice ?? 0),
      vatRate,
    })),
    payment: {
      amount: total,
      currency: "ILS",
    },
    totals: {
      totalBeforeVat,
      vat: vatAmount,
      total,
    },
    ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey.slice(0, 128) } : {}),
  };

  const url = `${baseUrl}/api/v1/documents`;
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
          throw new Error(`GreenInvoice HTTP ${res.status}`);
        }
        const msg = (body?.message || body?.error || res.statusText || "GreenInvoice API error").slice(0, 120);
        throw makeErr("INVOICE_PROVIDER_ERROR", `GreenInvoice: ${msg}`);
      }
      return { res, body };
    },
    { retries }
  );

  const data = body?.item ?? body?.data ?? body;
  const providerDocId = String(data?.id ?? body?.id ?? "");
  const invoiceNumber = String(data?.number ?? body?.number ?? "");
  const invoiceUrl = String(data?.url ?? body?.url ?? "").slice(0, 512);
  const issuedAt = data?.createdAt ? new Date(data.createdAt) : body?.createdAt ? new Date(body.createdAt) : new Date();

  return {
    invoiceNumber,
    providerDocId: providerDocId || String(order._id),
    url: invoiceUrl,
    issuedAt,
    raw: redactSnapshot(data || body),
  };
}
