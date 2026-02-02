// src/utils/withMongoTransaction.js
import mongoose from "mongoose";

/**
 * ✅ DELIVERABLE #1: Enforce MongoDB transactions in production
 *
 * REQUIRE_TRANSACTIONS env flag:
 * - true/1 (default in production): Fail if transactions not supported
 * - false/0: Allow fallback to non-transactional mode (dev/test only)
 */

/**
 * Check if REQUIRE_TRANSACTIONS is enabled.
 * Default: true in production, false otherwise.
 */
function isTransactionsRequired() {
  const envVal = String(process.env.REQUIRE_TRANSACTIONS || "").trim().toLowerCase();
  if (envVal === "false" || envVal === "0") return false;
  if (envVal === "true" || envVal === "1") return true;
  // Default: require in production
  return process.env.NODE_ENV === "production";
}

function isTransactionNotSupported(err) {
  if (!err) return false;
  if (err.code === 20) return true;

  const msg = String(err.message || "");
  if (!msg) return false;
  if (msg.includes("Transaction numbers are only allowed on a replica set member or mongos")) {
    return true;
  }
  if (msg.includes("Transaction is not supported")) return true;
  if (msg.toLowerCase().includes("replica set")) return true;
  return false;
}

/**
 * Custom error for transaction requirement failures
 */
class TransactionRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransactionRequiredError";
    this.code = "TRANSACTION_REQUIRED";
    this.statusCode = 503;
  }
}

/**
 * Execute a function within a MongoDB transaction.
 *
 * Behavior based on REQUIRE_TRANSACTIONS:
 * - If required (production default): throws TransactionRequiredError when transactions unavailable
 * - If not required: gracefully degrades to non-transactional mode (dev/test)
 *
 * @param {Function} fn - Async function receiving (session) parameter. session is null if transactions unavailable AND fallback allowed.
 * @returns {Promise<any>} - Result from fn
 * @throws {TransactionRequiredError} - If transactions required but not supported
 */
async function withMongoTransaction(fn) {
  const requireTx = isTransactionsRequired();

  const session = await mongoose.startSession().catch((e) => {
    const errMsg = `[withMongoTransaction] mongo start session failed: ${String(e?.message || e)}`;

    if (requireTx) {
      console.error(errMsg);
      throw new TransactionRequiredError(
        "Database transactions are required but not available. Ensure MongoDB is running as a replica set."
      );
    }

    console.warn("[best-effort] " + errMsg);
    return null;
  });

  // If no session and transactions required, fail
  if (!session) {
    if (requireTx) {
      throw new TransactionRequiredError(
        "Database transactions are required but session could not be started. Ensure MongoDB is running as a replica set."
      );
    }
    // Fallback allowed (dev/test)
    return await fn(null);
  }

  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      }
    );
    return result;
  } catch (err) {
    if (isTransactionNotSupported(err)) {
      // Transactions not supported by this MongoDB instance
      if (requireTx) {
        console.error("[withMongoTransaction] Transactions required but not supported:", String(err?.message || err));
        throw new TransactionRequiredError(
          "Database transactions are required but not supported by the current MongoDB topology. Use a replica set."
        );
      }
      // Fallback allowed (dev/test)
      console.warn("[best-effort] Transactions not supported, running without transaction");
      return await fn(null);
    }
    throw err;
  } finally {
    try {
      await session.endSession();
    } catch (e) {
      console.warn("[best-effort] mongo end session failed:", String(e?.message || e));
    }
  }
}

export { withMongoTransaction, isTransactionsRequired, TransactionRequiredError };
