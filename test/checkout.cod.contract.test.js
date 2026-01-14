import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("startCodCheckout does not mark paid/captured", () => {
  const filePath = path.join(process.cwd(), "src", "services", "payment.service.js");
  const contents = fs.readFileSync(filePath, "utf8");
  const start = contents.indexOf("export async function startCodCheckout");
  const end = contents.indexOf("export async function startCheckout");
  assert.ok(start !== -1);
  assert.ok(end !== -1);

  const block = contents.slice(start, end);
  assert.equal(block.includes("paidAt"), false);
  assert.equal(block.includes("payment.status = \"captured\""), false);
  assert.equal(block.includes("ORDER_STATUS.PAYMENT_RECEIVED"), false);
});
