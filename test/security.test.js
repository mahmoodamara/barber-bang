import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test_secret_min_32_chars_1234567890";
process.env.JWT_ISSUER = "test-issuer";
process.env.JWT_AUDIENCE = "test-audience";
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.ENABLE_METRICS = "false";
process.env.REGISTER_MIN_DELAY_MS = "10";
process.env.COUPON_RESERVATION_TTL_MINUTES = "5";

const { app } = await import("../src/app.js");
const { connectDB } = await import("../src/config/db.js");
const { User } = await import("../src/models/User.js");
const { Product } = await import("../src/models/Product.js");
const { Coupon } = await import("../src/models/Coupon.js");
const { signToken } = await import("../src/utils/jwt.js");
const { reserveCouponAtomic } = await import("../src/services/pricing.service.js");

let mongo;
let server;
let baseUrl;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await connectDB();

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Product.deleteMany({}),
    Coupon.deleteMany({}),
  ]);
});

test("Non-admin cannot update store pickup (403)", async () => {
  const user = await User.create({
    name: "User",
    email: "user@example.com",
    passwordHash: "hash",
    role: "user",
  });

  const token = signToken({
    sub: user._id.toString(),
    userId: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
  });

  const res = await fetch(`${baseUrl}/api/v1/admin/store-pickup`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ isEnabled: true }),
  });

  assert.equal(res.status, 403);
});

test("Review XSS payload is sanitized in response", async () => {
  const user = await User.create({
    name: "Reviewer",
    email: "reviewer@example.com",
    passwordHash: "hash",
    role: "user",
  });

  const token = signToken({
    sub: user._id.toString(),
    userId: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
  });

  const categoryId = new mongoose.Types.ObjectId();
  const product = await Product.create({
    titleHe: "Test Product",
    price: 10,
    stock: 5,
    categoryId,
  });

  const payload = { rating: 5, comment: "<script>alert(1)</script>Nice" };
  const createRes = await fetch(`${baseUrl}/api/v1/products/${product._id}/reviews`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  assert.equal(createRes.status, 201);

  const listRes = await fetch(`${baseUrl}/api/v1/products/${product._id}/reviews`);
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  const comment = listBody?.data?.items?.[0]?.comment || "";
  assert.ok(!comment.includes("<"));
  assert.ok(!comment.includes(">"));
});

test("Concurrent checkouts cannot exceed coupon usage limit", async () => {
  await Coupon.create({
    code: "SAVE10",
    type: "percent",
    value: 10,
    usageLimit: 1,
    usedCount: 0,
    reservedCount: 0,
    isActive: true,
  });

  const orderA = new mongoose.Types.ObjectId();
  const orderB = new mongoose.Types.ObjectId();

  const [a, b] = await Promise.all([
    reserveCouponAtomic({ code: "SAVE10", orderId: orderA }),
    reserveCouponAtomic({ code: "SAVE10", orderId: orderB }),
  ]);

  const successes = [a, b].filter((r) => r?.success && !r?.error).length;
  assert.equal(successes, 1);
});

test("Upload rejects non-image spoofed MIME", async () => {
  const admin = await User.create({
    name: "Admin",
    email: "admin@example.com",
    passwordHash: "hash",
    role: "admin",
  });

  const token = signToken({
    sub: admin._id.toString(),
    userId: admin._id.toString(),
    role: admin.role,
    tokenVersion: admin.tokenVersion || 0,
  });

  const form = new FormData();
  const blob = new Blob([Buffer.from("not-an-image")], { type: "image/jpeg" });
  form.append("file", blob, "fake.jpg");

  const res = await fetch(`${baseUrl}/api/v1/admin/media/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });

  assert.equal(res.status, 400);
});

test("Register does not reveal if email exists", async () => {
  await User.create({
    name: "Existing",
    email: "existing@example.com",
    passwordHash: "hash",
    role: "user",
  });

  const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Someone",
      email: "existing@example.com",
      password: "Password123",
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body?.ok, true);
  assert.equal(body?.data?.token, null);
  assert.equal(body?.data?.user, null);
});
