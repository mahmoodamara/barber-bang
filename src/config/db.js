import mongoose from "mongoose";
import { isTransactionsRequired, TransactionRequiredError } from "../utils/withMongoTransaction.js";

// Cached transaction support status
let transactionSupportChecked = false;
let transactionsSupported = false;

/**
 * ✅ Validate MongoDB topology supports transactions using hello (low privilege).
 * Replaces serverStatus() which can fail for users without serverStatus privilege.
 * hello: 1 returns setName (replica set) or msg "isdbgrid" (mongos).
 */
async function validateTransactionSupport() {
  if (transactionSupportChecked) return transactionsSupported;

  try {
    const db = mongoose.connection.db;
    const result = await db.admin().command({ hello: 1 });

    // Replica set: response has setName or topologyVersion
    const isReplicaSet = Boolean(result?.setName || result?.topologyVersion);

    // Mongos: response has msg "isdbgrid"
    const isMongos = String(result?.msg || "").toLowerCase() === "isdbgrid";

    transactionsSupported = isReplicaSet || isMongos;
    transactionSupportChecked = true;

    return transactionsSupported;
  } catch (e) {
    console.warn("[db] Could not verify transaction support:", String(e?.message || e));
    transactionSupportChecked = true;
    transactionsSupported = false;
    return false;
  }
}

export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is required");

  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);

  console.log("[db] connected");

  // ✅ Validate transaction support at startup
  const requireTx = isTransactionsRequired();
  const supported = await validateTransactionSupport();

  if (requireTx && !supported) {
    const errMsg = [
      "[db] FATAL: REQUIRE_TRANSACTIONS is enabled but MongoDB does not support transactions.",
      "MongoDB must be running as a replica set or sharded cluster.",
      "For development, set REQUIRE_TRANSACTIONS=false or use a replica set.",
    ].join("\n");

    console.error(errMsg);
    throw new TransactionRequiredError(
      "MongoDB transactions are required but not supported. Use a replica set."
    );
  }

  if (supported) {
    console.log("[db] Transaction support verified (replica set/mongos)");
  } else {
    console.warn("[db] WARNING: Transactions not supported (standalone mode). Fallback enabled for non-production.");
  }
}

/**
 * Get database health status for readiness endpoint
 */
export function getDbHealth() {
  const state = mongoose.connection.readyState;
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  const isConnected = state === 1;

  return {
    connected: isConnected,
    transactionsSupported,
    transactionsRequired: isTransactionsRequired(),
    healthy: isConnected && (!isTransactionsRequired() || transactionsSupported),
  };
}

export { validateTransactionSupport };
