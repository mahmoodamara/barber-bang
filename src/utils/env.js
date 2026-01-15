import "dotenv/config";
import { z } from "zod";

/**
 * Seed-mode bypass:
 * - When running seed scripts (node src/scripts/seed.*.js), allow safe defaults
 *   for required env vars that are irrelevant to seeding (JWT/Stripe).
 * - Keep strict validation for normal server runtime.
 */
const argv = process.argv.join(" ");
const isSeed =
  /\bseed\./i.test(argv) ||
  argv.includes("src/scripts") ||
  argv.includes("/scripts") ||
  argv.includes("\\scripts");

const emptyToUndefined = (v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && v.trim() === "") return undefined;
  return v;
};

const toInt = (v) => {
  const vv = emptyToUndefined(v);
  if (vv === undefined) return undefined;
  const n = Number(vv);
  return Number.isFinite(n) ? n : undefined;
};

const toFloat = (v) => {
  const vv = emptyToUndefined(v);
  if (vv === undefined) return undefined;
  const n = Number(vv);
  return Number.isFinite(n) ? n : undefined;
};

const toBool = (v) => {
  const vv = emptyToUndefined(v);
  if (vv === undefined) return undefined;
  if (typeof vv === "boolean") return vv;
  if (typeof vv === "string") {
    const s = vv.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
  }
  return undefined;
};

const toTrustProxy = (v) => {
  const vv = emptyToUndefined(v);
  if (vv === undefined) return undefined;
  if (typeof vv === "boolean" || typeof vv === "number") return vv;
  if (typeof vv === "string") {
    const s = vv.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    return vv.trim();
  }
  return vv;
};

function normalizeCityKey(city) {
  return String(city || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function parseCityRateOverrides(raw) {
  const s = emptyToUndefined(raw);
  if (!s) return {};

  const out = {};
  const parts = String(s)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 50);

  for (const p of parts) {
    const [left, right] = p.includes("=") ? p.split("=") : p.split(":");
    const cityKey = normalizeCityKey(left);
    const bps = Number(String(right || "").trim());
    if (!cityKey) continue;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) continue;
    out[cityKey] = bps;
  }

  return out;
}

// Safe defaults for seed ONLY (dev local)
const SEED_DEFAULTS = {
  MONGO_URI: "mongodb://127.0.0.1:27017/barber_store",
  JWT_SECRET: "seed_jwt_secret_1234567890", // >= 16 chars
  STRIPE_SECRET_KEY: "sk_test_seed_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_seed_dummy",
};

const requiredUnlessSeed = (key, schema) => {
  // For seed: allow missing and fallback to SEED_DEFAULTS
  // For normal runtime: enforce schema strictly
  if (isSeed) {
    return z.preprocess((v) => emptyToUndefined(v) ?? SEED_DEFAULTS[key], schema);
  }
  return schema;
};

const envSchema = z.object({
  // Core
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.preprocess(toInt, z.number().int().positive().default(4000)),
  TRUST_PROXY: z.preprocess(
    toTrustProxy,
    z.union([z.boolean(), z.number().int().nonnegative(), z.string().min(1)]).optional(),
  ),

  // Mongo (required normally; default local for seed)
  MONGO_URI: requiredUnlessSeed("MONGO_URI", z.string().min(1, "MONGO_URI is required")),
  MONGO_DB_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
  MONGO_MAX_POOL_SIZE: z.preprocess(toInt, z.number().int().positive().optional()),
  MONGO_MIN_POOL_SIZE: z.preprocess(toInt, z.number().int().nonnegative().optional()),
  MONGO_AUTO_INDEX: z.preprocess(toBool, z.boolean().optional()),

  // CORS
  CORS_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()),

  // Logging
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Body limits
  BODY_LIMIT: z.preprocess(emptyToUndefined, z.string().min(2).default("200kb")),

  // Query budget
  QUERY_MAX_TIME_MS: z.preprocess(toInt, z.number().int().positive().default(800)),
  QUERY_BUDGET_ENABLED: z.preprocess(toBool, z.boolean().default(true)),

  // Rate limit (global)
  RATE_LIMIT_WINDOW_MS: z.preprocess(toInt, z.number().int().positive().default(60_000)),
  RATE_LIMIT_MAX: z.preprocess(toInt, z.number().int().positive().default(300)),

  // Rate limit (auth) - keep both names for backward compatibility
  AUTH_LIMIT_WINDOW_MS: z.preprocess(toInt, z.number().int().positive().default(900_000)),
  AUTH_LIMIT_MAX: z.preprocess(toInt, z.number().int().positive().default(20)),
  AUTH_RATE_LIMIT_WINDOW_MS: z.preprocess(toInt, z.number().int().positive().optional()),
  AUTH_RATE_LIMIT_MAX: z.preprocess(toInt, z.number().int().positive().optional()),
  AUTH_CACHE_TTL_MS: z.preprocess(toInt, z.number().int().positive().optional()),

  // Distributed rate limiter (Mongo backend; optional)
  RATE_LIMIT_BACKEND: z.preprocess(
    emptyToUndefined,
    z.enum(["memory", "mongo"]).default("memory")
  ),
  RATE_LIMIT_TTL_MS: z.preprocess(toInt, z.number().int().positive().default(60_000)),

  // Perf
  SLOW_REQUEST_MS: z.preprocess(toInt, z.number().int().positive().default(1000)),
  DB_SLOW_QUERY_MS: z.preprocess(toInt, z.number().int().positive().optional()),

  // JWT (required normally; seed gets safe default)
  JWT_SECRET: requiredUnlessSeed("JWT_SECRET", z.string().min(16, "JWT_SECRET too short")),
  JWT_ISSUER: z.preprocess(emptyToUndefined, z.string().min(1).default("barber-store")),
  JWT_AUDIENCE: z.preprocess(emptyToUndefined, z.string().min(1).default("barber-store-web")),
  ACCESS_TOKEN_TTL: z.preprocess(emptyToUndefined, z.string().min(2).default("15m")),
  EMAIL_OTP_TTL: z.preprocess(emptyToUndefined, z.string().min(2).default("10m")),
  OTP_PEPPER: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  EMAIL_OTP_RESEND_COOLDOWN_MS: z.preprocess(toInt, z.number().int().nonnegative().default(60_000)),

  // Stripe (required normally; seed gets safe defaults)
  STRIPE_SECRET_KEY: requiredUnlessSeed(
    "STRIPE_SECRET_KEY",
    z.string().min(1, "STRIPE_SECRET_KEY is required")
  ),
  STRIPE_WEBHOOK_SECRET: requiredUnlessSeed(
    "STRIPE_WEBHOOK_SECRET",
    z.string().min(1, "STRIPE_WEBHOOK_SECRET is required")
  ),
  STRIPE_CURRENCY: z.preprocess(emptyToUndefined, z.string().min(1).default("ILS")),
  FRONTEND_URL: z.preprocess(emptyToUndefined, z.string().url().default("http://localhost:5173")),

  // Orders
  ORDER_PAYMENT_TTL_MINUTES: z.preprocess(toInt, z.number().int().positive().default(30)),

  // Idempotency
  IDEMPOTENCY_TTL_HOURS: z.preprocess(toInt, z.number().int().positive().default(24)),
  IDEMPOTENCY_MAX_BODY_BYTES: z.preprocess(toInt, z.number().int().positive().default(10_000)),

  // SMTP (optional)
  MAIL_DRIVER: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMTP_HOST: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMTP_PORT: z.preprocess(toInt, z.number().int().positive().optional()),
  SMTP_SECURE: z.preprocess(toBool, z.boolean().optional()),
  SMTP_NAME: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMTP_USER: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMTP_PASS: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMTP_FROM: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  MAIL_FROM: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  MAIL_ENVELOPE_FROM: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  MAIL_BOUNCE_TO: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

  // PDF / Puppeteer
  CHROME_EXECUTABLE_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  INVOICE_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  PDF_TIMEOUT_MS: z.preprocess(toInt, z.number().int().positive().default(15000)),
  PDF_MAX_CONCURRENCY: z.preprocess(toInt, z.number().int().positive().default(2)),
  PDF_BROWSER_RECYCLE_JOBS: z.preprocess(toInt, z.number().int().positive().default(50)),
  PDF_BROWSER_MAX_AGE_MS: z.preprocess(toInt, z.number().int().positive().default(30 * 60 * 1000)),

  // Alerts (optional)
  ALERT_EMAIL_TO: z.preprocess(emptyToUndefined, z.string().email().optional()),
  ALERT_THROTTLE_MINUTES: z.preprocess(toInt, z.number().int().positive().default(30)),

  // Refund policy
  REFUND_MAX_DAYS: z.preprocess(toInt, z.number().int().positive().default(14)),
  REFUND_ALLOW_PARTIAL: z.preprocess(toBool, z.boolean().default(true)),
  REFUND_DEFAULT_RESTOCK: z.preprocess(toBool, z.boolean().default(false)),

  // Tax / VAT
  TAX_ENABLED: z.preprocess(toBool, z.boolean().default(true)),
  VAT_BPS: z.preprocess(toInt, z.number().int().min(0).max(10_000).optional()),
  VAT_RATE: z.preprocess(toFloat, z.number().min(0).max(1).optional()),
  TAX_COUNTRY: z.preprocess(emptyToUndefined, z.string().trim().length(2).default("IL")),
  CITY_RATE_OVERRIDES: z.preprocess(emptyToUndefined, z.string().max(2000).optional()),

  // Ops monitor
  OPS_MONITOR_EVERY_MS: z.preprocess(toInt, z.number().int().positive().default(60_000)),
  OPS_STUCK_JOB_MINUTES: z.preprocess(toInt, z.number().int().positive().default(10)),
  OPS_FAILED_JOBS_WINDOW_MINUTES: z.preprocess(toInt, z.number().int().positive().default(15)),
  OPS_FAILED_JOBS_THRESHOLD: z.preprocess(toInt, z.number().int().positive().default(5)),
  OPS_UNPROCESSED_STRIPE_EVENTS_MINUTES: z.preprocess(toInt, z.number().int().positive().default(5)),

  // Order expiry sweep
  ORDER_EXPIRY_SWEEP_EVERY_MS: z.preprocess(toInt, z.number().int().positive().default(30_000)),
  ORDER_EXPIRY_SWEEP_LIMIT: z.preprocess(toInt, z.number().int().positive().default(50)),

  // Worker
  INSTANCE_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  WORKER_LEASE_MS: z.preprocess(toInt, z.number().int().positive().default(8000)),
  WORKER_IDLE_SLEEP_MS: z.preprocess(toInt, z.number().int().positive().default(500)),
  WORKER_LOOP_ERROR_SLEEP_MS: z.preprocess(toInt, z.number().int().positive().default(1000)),
  WORKER_MAX_ATTEMPTS: z.preprocess(toInt, z.number().int().positive().default(5)),
  WORKER_CANCEL_SWEEP_LIMIT: z.preprocess(toInt, z.number().int().positive().default(50)),

  // Scheduler lease (leader election)
  LEASE_NAME: z.preprocess(emptyToUndefined, z.string().min(1).default("barber-store-scheduler")),
  LEASE_TTL_MS: z.preprocess(toInt, z.number().int().positive().default(25_000)),
  LEASE_HEARTBEAT_MS: z.preprocess(toInt, z.number().int().positive().default(5_000)),

  // Metrics (optional)
  METRICS_ENABLED: z.preprocess(toBool, z.boolean().default(false)),
  METRICS_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default("/metrics")),
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(10).optional()),

  // Backups (optional scripts)
  BACKUP_DIR: z.preprocess(emptyToUndefined, z.string().min(1).default("./backups")),
  BACKUP_RETENTION_DAYS: z.preprocess(toInt, z.number().int().positive().default(7)),
  MONGODUMP_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

  // Feature flags cache
  FEATURE_FLAGS_CACHE_MS: z.preprocess(toInt, z.number().int().positive().default(30_000)),

  // Transactions enforcement (safety)
  REQUIRE_TRANSACTIONS: z.preprocess(toBool, z.boolean().default(false)),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables:");
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);

  // eslint-disable-next-line no-console
  if (isSeed) console.error("Note: You are running in SEED mode.");
  process.exit(1);
}

const raw = parsed.data;

if (raw.NODE_ENV === "production" && raw.METRICS_ENABLED && !raw.METRICS_TOKEN) {
  // eslint-disable-next-line no-console
  console.error("METRICS_TOKEN is required when METRICS_ENABLED=true in production.");
  process.exit(1);
}

if (raw.NODE_ENV === "production" && !raw.OTP_PEPPER) {
  // eslint-disable-next-line no-console
  console.error("OTP_PEPPER is required in production.");
  process.exit(1);
}

// Prefer AUTH_LIMIT_*; fallback to AUTH_RATE_LIMIT_* if user still uses legacy names
const authWindowMs = raw.AUTH_LIMIT_WINDOW_MS ?? raw.AUTH_RATE_LIMIT_WINDOW_MS ?? 900_000;
const authMax = raw.AUTH_LIMIT_MAX ?? raw.AUTH_RATE_LIMIT_MAX ?? 20;

const vatBpsFromRate =
  raw.VAT_RATE === undefined || raw.VAT_RATE === null
    ? undefined
    : Math.round(Number(raw.VAT_RATE) * 10_000);

const vatBps = raw.VAT_BPS ?? vatBpsFromRate ?? 1700;

export const ENV = {
  ...raw,
  AUTH_LIMIT_WINDOW_MS: authWindowMs,
  AUTH_LIMIT_MAX: authMax,
  MONGO_AUTO_INDEX:
    raw.MONGO_AUTO_INDEX === undefined ? raw.NODE_ENV !== "production" : raw.MONGO_AUTO_INDEX,
  CORS_ORIGINS: String(raw.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  TAX_COUNTRY: String(raw.TAX_COUNTRY || "IL").trim().toUpperCase(),
  VAT_BPS: vatBps,
  CITY_RATE_OVERRIDES: parseCityRateOverrides(raw.CITY_RATE_OVERRIDES),
  __SEED_MODE__: isSeed,
};
