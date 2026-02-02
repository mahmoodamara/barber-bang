/**
 * qa/tests/setup.cjs
 *
 * Jest global setup (CJS file that can load ESM/CJS modules)
 * - Boots MongoMemoryReplSet (transactions supported)
 * - Sets deterministic env flags
 * - Loads DB connector from: src/config/db.js (ESM or CJS)
 * - Loads Express app from: src/app.js (fallback: app.js) (ESM or CJS)
 * - Exposes app as global.__APP__
 *
 * IMPORTANT:
 * - Keep running jest with: NODE_OPTIONS=--experimental-vm-modules (you already do)
 */

const path = require("path");
const mongoose = require("mongoose");
const { pathToFileURL } = require("url");

let replSet;

function resolveProjectPath(rel) {
  return path.resolve(process.cwd(), rel);
}

async function loadModuleHybrid(absPath) {
  // 1) Try require first (CJS)
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(absPath);
  } catch (err) {
    const msg = String(err?.message || "");
    const code = err?.code;

    // 2) If it's ESM, use import(file://...)
    const isESM =
      code === "ERR_REQUIRE_ESM" ||
      msg.includes("Must use import to load ES Module") ||
      msg.includes("require() of ES Module");

    if (!isESM) throw err;

    const url = pathToFileURL(absPath).href;
    return import(url);
  }
}

async function loadConnectDB() {
  const dbPath = resolveProjectPath("src/config/db.js");
  const mod = await loadModuleHybrid(dbPath);

  // Support: { connectDB }, default export, or module export = fn
  const connectDB = mod.connectDB || mod.default || mod;

  if (typeof connectDB !== "function") {
    throw new Error(
      "src/config/db.js did not export a connect function. Expected `export function connectDB(){}` or `export default function(){}`",
    );
  }

  return connectDB;
}

async function loadExpressApp() {
  const candidates = [resolveProjectPath("src/app.js"), resolveProjectPath("app.js")];

  let lastErr;
  for (const p of candidates) {
    try {
      const mod = await loadModuleHybrid(p);
      const app = mod.app || mod.default || mod;

      if (!app || typeof app.listen !== "function") {
        throw new Error(
          `Loaded ${p} but did not find an Express app export. Export \`app\` or default export the Express instance.`,
        );
      }

      return app;
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `Could not load Express app from:\n- ${candidates.join("\n- ")}\nLast error: ${lastErr?.message || lastErr
    }`,
  );
}

beforeAll(async () => {
  // Deterministic env for tests
  process.env.NODE_ENV = "test";
  process.env.ENABLE_METRICS = "false";
  process.env.ENABLE_RANKING_JOB = "false";
  process.env.ENABLE_RESERVATION_REPAIR_JOB = "false";
  process.env.ENABLE_INVOICE_RETRY_JOB = "false";
  process.env.REQUIRE_TRANSACTIONS = "true";

  // JWT for tests
  process.env.JWT_SECRET = process.env.JWT_SECRET || "qa-test-secret-change-me";
  process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";

  // Stripe webhook secret (unit-style)
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_123";

  // Start in-memory replica set (transactions supported)
  const externalUri =
    process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DB_URI;
  let uri;

  try {
    const { MongoMemoryReplSet } = require("mongodb-memory-server");
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    uri = replSet.getUri();
  } catch (err) {
    const msg = String(err?.message || err?.code || err);
    const isSpawnError =
      msg.includes("spawn") ||
      err?.code === "EPERM" ||
      err?.errno === -4048 ||
      err?.syscall === "spawn";
    if (isSpawnError && externalUri && String(externalUri).trim().length > 0) {
      uri = externalUri.trim();
    } else if (isSpawnError) {
      throw new Error(
        "MongoMemoryServer failed to start (often EPERM in restricted environments). " +
          "Set MONGODB_URI to a real MongoDB connection string to run tests against an external DB."
      );
    } else {
      throw err;
    }
  }

  // Support different env names your app might use
  process.env.MONGO_URI = uri;
  process.env.MONGODB_URI = uri;
  process.env.DB_URI = uri;

  // Load connectDB (ESM-safe) then connect
  const connectDB = await loadConnectDB();
  await connectDB();

  // Load Express app after env+db are ready
  global.__APP__ = await loadExpressApp();

  // Sync indexes for all models to ensure unique constraints are in place
  // (Models are registered when app loads, so sync after app is ready)
  try {
    await Promise.all(
      Object.values(mongoose.connection.models).map((model) =>
        model.syncIndexes().catch(() => {})
      )
    );
  } catch {
    // best-effort; some tests may fail if indexes aren't ready
  }
}, 60000);

afterAll(async () => {
  try {
    if (mongoose.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
    }
  } catch {
    // ignore
  }

  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }

  try {
    if (replSet) await replSet.stop();
  } catch {
    // ignore
  }
});

beforeEach(async () => {
  // Clean collections between tests
  const { collections } = mongoose.connection;
  const names = Object.keys(collections || {});
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    await collections[name].deleteMany({});
  }
});
