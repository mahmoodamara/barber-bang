import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test_secret_min_32_chars_1234567890";
process.env.JWT_ISSUER = "test-issuer";
process.env.JWT_AUDIENCE = "test-audience";
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.ENABLE_METRICS = "false";
process.env.REGISTER_MIN_DELAY_MS = "10";
process.env.COUPON_RESERVATION_TTL_MINUTES = "5";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { app } = await import("../src/app.js");
const { connectDB } = await import("../src/config/db.js");
const { Product } = await import("../src/models/Product.js");
const { Category } = await import("../src/models/Category.js");
const { User } = await import("../src/models/User.js");
const { signToken } = await import("../src/utils/jwt.js");

let mongo;
let server;
let baseUrl;

async function createCategory() {
  return Category.create({ nameHe: `Cat-${Date.now()}` });
}

async function createBaseProduct(overrides = {}) {
  const category = await createCategory();
  return Product.create({
    titleHe: "Test Product",
    price: 10,
    stock: 5,
    categoryId: category._id,
    ...overrides,
  });
}

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
  await Promise.all([Product.deleteMany({}), Category.deleteMany({}), User.deleteMany({})]);
});

test("Missing model forces HOLD", async () => {
  const product = await createBaseProduct({
    verification: { isCategoryVerified: true },
  });
  const fresh = await Product.findById(product._id).lean();
  assert.equal(fresh.catalogStatus, "HOLD");
});

test("Critical mismatch forces HOLD", async () => {
  const product = await createBaseProduct({
    identity: { model: "KM-9999" },
    verification: { isCategoryVerified: true, hasCriticalMismatch: true },
    catalogStatus: "READY",
  });
  const fresh = await Product.findById(product._id).lean();
  assert.equal(fresh.catalogStatus, "HOLD");
});

test("READY requires publish content minimums", async () => {
  const product = await createBaseProduct({
    identity: { model: "KM-1234" },
    verification: { isCategoryVerified: true },
    catalogStatus: "READY",
  });
  const fresh = await Product.findById(product._id).lean();
  assert.equal(fresh.catalogStatus, "READY_WITH_EDITS");
});

test("Confidence grade auto-derivation", async () => {
  const a = await createBaseProduct({
    identity: { model: "KM-1000" },
    verification: { isModelVerified: true, isCategoryVerified: true, verifiedSourcesCount: 2 },
  });
  const b = await createBaseProduct({
    identity: { model: "KM-1001" },
    verification: { isCategoryVerified: true, verifiedSourcesCount: 2 },
  });
  const c = await createBaseProduct({
    identity: { model: "KM-1002" },
    verification: { isCategoryVerified: true, verifiedSourcesCount: 0 },
  });
  const d = await createBaseProduct({
    verification: { isCategoryVerified: true },
  });

  const [fa, fb, fc, fd] = await Promise.all([
    Product.findById(a._id).lean(),
    Product.findById(b._id).lean(),
    Product.findById(c._id).lean(),
    Product.findById(d._id).lean(),
  ]);

  assert.equal(fa.confidenceGrade, "A");
  assert.equal(fb.confidenceGrade, "B");
  assert.equal(fc.confidenceGrade, "C");
  assert.equal(fd.confidenceGrade, "D");
});

test("PATCH blocks publish when HOLD", async () => {
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

  const product = await createBaseProduct({
    identity: { model: "" },
    verification: { isCategoryVerified: false },
  });

  const res = await fetch(`${baseUrl}/api/v1/admin/products/${product._id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ isActive: true }),
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body?.error?.code, "PUBLISH_BLOCKED");
});

test("Migration script is idempotent", async () => {
  const product = await createBaseProduct({
    sku: "KM-1868",
    identity: { model: "" },
  });

  const scriptPath = path.join(__dirname, "../src/scripts/migrateProductCatalogFields.js");
  const env = { ...process.env, MONGO_URI: process.env.MONGO_URI };

  await execFileAsync(process.execPath, [scriptPath], { env });
  const afterFirst = await Product.findById(product._id).lean();

  await execFileAsync(process.execPath, [scriptPath], { env });
  const afterSecond = await Product.findById(product._id).lean();

  assert.equal(afterFirst.identity?.model, afterSecond.identity?.model);
  assert.equal(afterFirst.classification?.categoryPrimary, afterSecond.classification?.categoryPrimary);
  assert.equal(afterFirst.catalogStatus, afterSecond.catalogStatus);
  assert.equal(afterFirst.confidenceGrade, afterSecond.confidenceGrade);
});

test("Legacy image primary sync remains intact", async () => {
  const product = await createBaseProduct({
    identity: { model: "KM-7777" },
    verification: { isCategoryVerified: true },
    images: [
      { url: "http://example.com/a.jpg", secureUrl: "http://example.com/a.jpg" },
      { url: "http://example.com/b.jpg", secureUrl: "http://example.com/b.jpg" },
    ],
  });

  const fresh = await Product.findById(product._id).lean();
  assert.equal(fresh.images?.[0]?.isPrimary, true);
  assert.equal(fresh.imageUrl, "http://example.com/a.jpg");
});
