import { ENV } from "../utils/env.js";

function hasEnv(key) {
  const value = process.env[key];
  return value !== undefined && String(value).trim() !== "";
}

const warnings = [];
const errors = [];
const isProd = ENV.NODE_ENV === "production";

if (!isProd) {
  warnings.push("NODE_ENV is not production; checks are informational only.");
}

if (isProd) {
  if (ENV.RATE_LIMIT_BACKEND !== "mongo") {
    errors.push("RATE_LIMIT_BACKEND must be 'mongo' for distributed rate limiting.");
  }

  if (ENV.MONGO_AUTO_INDEX !== false) {
    errors.push("MONGO_AUTO_INDEX must be false in production.");
  } else if (!hasEnv("MONGO_AUTO_INDEX")) {
    warnings.push("MONGO_AUTO_INDEX is not explicitly set; defaulting to false.");
  }

  if (!hasEnv("MONGO_MAX_POOL_SIZE")) {
    errors.push("MONGO_MAX_POOL_SIZE must be set and tuned for production traffic.");
  }

  const pdfEnabled = hasEnv("CHROME_EXECUTABLE_PATH") || hasEnv("INVOICE_BASE_URL");
  if (pdfEnabled) {
    const pdfVars = ["PDF_MAX_CONCURRENCY", "PDF_BROWSER_RECYCLE_JOBS", "PDF_BROWSER_MAX_AGE_MS"];
    for (const key of pdfVars) {
      if (!hasEnv(key)) warnings.push(`${key} is not explicitly set; use production limits.`);
    }
  }
}

if (errors.length) {
  // eslint-disable-next-line no-console
  console.error("Production env verification failed:");
  for (const err of errors) {
    // eslint-disable-next-line no-console
    console.error(`- ${err}`);
  }
  process.exit(1);
}

if (warnings.length) {
  // eslint-disable-next-line no-console
  console.warn("Production env verification warnings:");
  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`- ${warning}`);
  }
}

// eslint-disable-next-line no-console
console.log("Production env verification OK.");
