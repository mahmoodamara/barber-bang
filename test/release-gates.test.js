import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

function ensureTestEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_1234567890";
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_dummy";
  process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/barber_store_test";
}

async function startServer(app) {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test("release gate: response envelope + requestId header", async (t) => {
  ensureTestEnv();
  const { buildApp } = await import("../src/api/app.js");
  const app = buildApp();
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.ok(payload.data);
  assert.ok(res.headers.get("x-request-id"));

  const res404 = await fetch(`${baseUrl}/api/v1/__missing__`);
  assert.equal(res404.status, 404);
  const errPayload = await res404.json();
  assert.equal(errPayload.ok, false);
  assert.ok(errPayload.error);
  assert.ok(errPayload.error.code);
  assert.equal(errPayload.error.requestId, res404.headers.get("x-request-id"));
});

test("release gate: money contract enforcement", async (t) => {
  ensureTestEnv();
  const express = (await import("express")).default;
  const { requestId } = await import("../src/middlewares/requestId.js");
  const { responseEnvelope } = await import("../src/middlewares/responseEnvelope.js");
  const { errorHandler } = await import("../src/middlewares/errorHandler.js");

  const app = express();
  app.use(requestId);
  app.use(responseEnvelope);

  app.get("/money-bad-minor", (_req, res) => {
    res.json({ ok: true, data: { amountMinor: -1, currency: "ILS" } });
  });

  app.get("/money-bad-currency", (_req, res) => {
    res.json({ ok: true, data: { amountMinor: 100, currency: "USD" } });
  });

  app.use(errorHandler);

  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const resMinor = await fetch(`${baseUrl}/money-bad-minor`);
  assert.equal(resMinor.status, 400);
  const minorPayload = await resMinor.json();
  assert.equal(minorPayload.ok, false);
  assert.equal(minorPayload.error.code, "INVALID_MONEY_UNIT");

  const resCurrency = await fetch(`${baseUrl}/money-bad-currency`);
  assert.equal(resCurrency.status, 500);
  const currencyPayload = await resCurrency.json();
  assert.equal(currencyPayload.ok, false);
  assert.equal(currencyPayload.error.code, "MONEY_CONTRACT_CURRENCY");
});
