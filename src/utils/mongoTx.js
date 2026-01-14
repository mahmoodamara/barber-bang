import mongoose from "mongoose";
import { logger } from "./logger.js";
import { ENV } from "./env.js";

let transactionsSupported = true;
let warnedOnce = false;

function isTransactionUnsupported(err) {
  const msg = String(err?.message || "");
  const codeName = String(err?.codeName || "");
  const code = Number.isInteger(err?.code) ? err.code : null;

  if (/Transaction numbers are only allowed on a replica set member or mongos/i.test(msg)) {
    return true;
  }
  if (/Transactions are not supported/i.test(msg)) {
    return true;
  }
  if (/does not support retryable writes/i.test(msg)) {
    return true;
  }
  if (code === 20 && /transaction/i.test(msg)) {
    return true;
  }
  if (codeName === "IllegalOperation" && /transaction/i.test(msg)) {
    return true;
  }
  return false;
}

export async function withOptionalTransaction(fn) {
  if (!transactionsSupported) return await fn();

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      transactionsSupported = false;
      if (!warnedOnce) {
        warnedOnce = true;
        logger.warn(
          { err },
          "MongoDB transactions unsupported; falling back to non-transactional flow.",
        );
      }
      return await fn();
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

function txRequired() {
  return ENV.REQUIRE_TRANSACTIONS === true;
}

function txRequiredError() {
  const err = new Error("TRANSACTIONS_REQUIRED");
  err.statusCode = 503;
  err.code = "TRANSACTIONS_REQUIRED";
  err.details = {
    hint: "MongoDB transactions are required (enable replica set / mongos) when REQUIRE_TRANSACTIONS=true",
  };
  return err;
}

/**
 * withRequiredTransaction
 *
 * Behavior:
 * - If REQUIRE_TRANSACTIONS=false => behaves like withOptionalTransaction.
 * - If REQUIRE_TRANSACTIONS=true:
 *   - Runs in a transaction if supported
 *   - Throws TRANSACTIONS_REQUIRED if MongoDB does not support transactions
 */
export async function withRequiredTransaction(fn) {
  if (!txRequired()) return await withOptionalTransaction(fn);

  if (!transactionsSupported) throw txRequiredError();

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      transactionsSupported = false;
      if (!warnedOnce) {
        warnedOnce = true;
        logger.warn(
          { err },
          "MongoDB transactions unsupported; REQUIRE_TRANSACTIONS=true will block sensitive operations.",
        );
      }
      throw txRequiredError();
    }
    throw err;
  } finally {
    await session.endSession();
  }
}
