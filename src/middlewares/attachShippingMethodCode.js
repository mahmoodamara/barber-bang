import mongoose from "mongoose";
import { ShippingMethod } from "../models/ShippingMethod.js";

export async function attachShippingMethodCode(req, _res, next) {
  try {
    const shippingMethodId = req?.body?.shippingMethodId;
    if (!shippingMethodId || !mongoose.Types.ObjectId.isValid(String(shippingMethodId))) {
      return next();
    }

    const method = await ShippingMethod.findById(shippingMethodId)
      .select("code")
      .lean();

    const body = { ...(req.body || {}) };
    if (!method?.code) {
      if (Object.prototype.hasOwnProperty.call(body, "shippingMethodCode")) {
        delete body.shippingMethodCode;
        req.body = body;
      }
      return next();
    }

    const clientCode = body.shippingMethodCode ? String(body.shippingMethodCode).trim().toUpperCase() : null;
    if (clientCode && clientCode !== method.code) {
      const err = new Error("Shipping method code mismatch");
      err.statusCode = 400;
      err.code = "INVALID_SHIPPING_METHOD_CODE";
      return next(err);
    }

    body.shippingMethodCode = method.code;
    req.body = body;

    return next();
  } catch (err) {
    return next(err);
  }
}
