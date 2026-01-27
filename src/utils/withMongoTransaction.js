// src/utils/withMongoTransaction.js
import mongoose from "mongoose";

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
 * Execute a function within a MongoDB transaction.
 * Gracefully degrades to non-transactional if replica set is not available.
 *
 * @param {Function} fn - Async function receiving (session) parameter. session is null if transactions unavailable.
 * @returns {Promise<any>} - Result from fn
 */
async function withMongoTransaction(fn) {
  const session = await mongoose.startSession().catch((e) => {
    console.warn("[best-effort] mongo start session failed:", String(e?.message || e));
    return null;
  });

  // If no session at all, just run without tx
  if (!session) return await fn(null);

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

export { withMongoTransaction };
