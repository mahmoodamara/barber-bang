import test from "node:test";
import assert from "node:assert/strict";

import { setOrderShippingMethodSchema } from "../src/validators/shipping.validators.js";
import { checkoutSchema } from "../src/validators/order.validators.js";

const orderId = "507f1f77bcf86cd799439011";
const shippingMethodId = "507f1f77bcf86cd799439012";

test("setOrderShippingMethodSchema requires pickupLocation for SELF_PICKUP", () => {
  const out = setOrderShippingMethodSchema.safeParse({
    params: { id: orderId },
    body: { shippingMethodId, shippingMethodCode: "SELF_PICKUP" },
  });

  assert.equal(out.success, false);
  assert.equal(out.error?.issues?.[0]?.message, "PICKUP_LOCATION_REQUIRED");
});

test("setOrderShippingMethodSchema accepts pickupLocation for SELF_PICKUP", () => {
  const out = setOrderShippingMethodSchema.safeParse({
    params: { id: orderId },
    body: {
      shippingMethodId,
      shippingMethodCode: "SELF_PICKUP",
      pickupLocation: { name: "Main Store", address: "123 Main St" },
    },
  });

  assert.equal(out.success, true);
});

test("checkoutSchema allows COD provider", () => {
  const out = checkoutSchema.safeParse({
    params: { id: orderId },
    body: { provider: "cod" },
  });

  assert.equal(out.success, true);
});
