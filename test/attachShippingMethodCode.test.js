import test from "node:test";
import assert from "node:assert/strict";

import { attachShippingMethodCode } from "../src/middlewares/attachShippingMethodCode.js";
import { ShippingMethod } from "../src/models/ShippingMethod.js";

const validId = "507f1f77bcf86cd799439011";

function stubFindById(code) {
  ShippingMethod.findById = () => ({
    select: () => ({
      lean: async () => (code ? { code } : null),
    }),
  });
}

test("attachShippingMethodCode overwrites with db code", async () => {
  const original = ShippingMethod.findById;
  try {
    stubFindById("SELF_PICKUP");
    const req = { body: { shippingMethodId: validId } };
    const err = await new Promise((resolve) => {
      attachShippingMethodCode(req, {}, resolve);
    });
    assert.equal(err, undefined);
    assert.equal(req.body.shippingMethodCode, "SELF_PICKUP");
  } finally {
    ShippingMethod.findById = original;
  }
});

test("attachShippingMethodCode rejects mismatched client code", async () => {
  const original = ShippingMethod.findById;
  try {
    stubFindById("SELF_PICKUP");
    const req = { body: { shippingMethodId: validId, shippingMethodCode: "STANDARD" } };
    const err = await new Promise((resolve) => {
      attachShippingMethodCode(req, {}, resolve);
    });
    assert.equal(err?.code, "INVALID_SHIPPING_METHOD_CODE");
    assert.equal(err?.statusCode, 400);
  } finally {
    ShippingMethod.findById = original;
  }
});

test("attachShippingMethodCode clears client code when method not found", async () => {
  const original = ShippingMethod.findById;
  try {
    stubFindById(null);
    const req = { body: { shippingMethodId: validId, shippingMethodCode: "SELF_PICKUP" } };
    const err = await new Promise((resolve) => {
      attachShippingMethodCode(req, {}, resolve);
    });
    assert.equal(err, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(req.body, "shippingMethodCode"), false);
  } finally {
    ShippingMethod.findById = original;
  }
});
