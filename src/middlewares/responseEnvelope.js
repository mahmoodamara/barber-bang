// src/middlewares/responseEnvelope.js

import { ENV } from "../utils/env.js";
import { assertMoneyContractOnResponse, ensureMoneyTwinsOnResponse } from "../utils/money.js";

/**
 * Response envelope normalizer
 *
 * Goal:
 * - Enforce consistent success envelope: { ok: true, data }
 * - Do NOT interfere with error responses (errors should be handled by centralized errorHandler)
 *
 * Notes:
 * - This middleware wraps ONLY res.json (and also res.send as best effort).
 * - It respects already-wrapped responses:
 *   - If body has { ok: true/false } it will pass through as-is.
 * - It preserves arrays/primitives by wrapping them into { ok:true, data:<body> }.
 * - It optionally supports legacy shapes returned by existing controllers like:
 *     { ok: true, items: [...] } or { ok: true, product: {...} }
 *   by converting them to { ok:true, data: { items: [...] } }.
 *
 * Important:
 * - If you rely on sending non-JSON (files/streams), do NOT apply this middleware to those routes.
 */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function responseEnvelope(_req, res, next) {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const shouldCheckMoney = ENV.NODE_ENV !== "production";

  res.json = (body) => {
    // Pass-through if it's already in the expected envelope format
    if (isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, "ok")) {
      // If {ok:true, ...} but missing `data`, try to normalize gently
      if (body.ok === true && !Object.prototype.hasOwnProperty.call(body, "data")) {
        // If body has other keys besides ok, wrap them under data
        const { ok, ...rest } = body;
        // If there's exactly one meaningful key, keep it under data anyway to be consistent
        const payload = { ok: true, data: Object.keys(rest).length ? rest : null };
        ensureMoneyTwinsOnResponse(payload);
        if (shouldCheckMoney) assertMoneyContractOnResponse(payload);
        return originalJson(payload);
      }

      // If ok:false, do not modify (errorHandler should format it)
      if (body.ok === false) return originalJson(body);

      ensureMoneyTwinsOnResponse(body);
      if (shouldCheckMoney) assertMoneyContractOnResponse(body);
      return originalJson(body);
    }

    // Wrap arrays/primitives/objects into { ok:true, data: body }
    const payload = { ok: true, data: body ?? null };
    ensureMoneyTwinsOnResponse(payload);
    if (shouldCheckMoney) assertMoneyContractOnResponse(payload);
    return originalJson(payload);
  };

  // Best-effort for res.send when controllers use it
  res.send = (body) => {
    // If it's Buffer/string, do not wrap (likely file, html, etc.)
    if (typeof body === "string" || Buffer.isBuffer(body)) {
      return originalSend(body);
    }

    // If it's an object, route through json wrapper
    return res.json(body);
  };

  next();
}
