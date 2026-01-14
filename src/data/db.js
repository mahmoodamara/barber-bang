import mongoose from "mongoose";
import { ENV } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import { markHealthy, markUnhealthy } from "../utils/healthState.js";
import { installMongooseMonitoring } from "../utils/mongooseMonitor.js";

let connectPromise = null;
let listenersBound = false;

function bindConnectionListenersOnce() {
  if (listenersBound) return;
  listenersBound = true;

  mongoose.connection.on("connected", () => {
    logger.info("MongoDB connected");
    markHealthy();
  });

  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected");
    markUnhealthy("db_disconnected");
  });

  mongoose.connection.on("error", (err) => {
    logger.error({ err }, "MongoDB error");
    markUnhealthy("db_error");
  });
}

function isReadyStateConnected() {
  return mongoose.connection.readyState === 1; // 1 = connected
}

/**
 * Connect to MongoDB (idempotent).
 * - Safe to call from API server and Worker.
 * - Disables command buffering to fail fast when DB is down.
 */
export async function connectDb() {
  mongoose.set("strictQuery", true);
  mongoose.set("autoIndex", ENV.MONGO_AUTO_INDEX);

  // Fail-fast: do NOT buffer model operations if not connected
  mongoose.set("bufferCommands", false);

  installMongooseMonitoring();
  bindConnectionListenersOnce();

  // already connected
  if (isReadyStateConnected()) return mongoose.connection;

  // if a connection attempt is already in-flight, await it
  if (connectPromise) {
    await connectPromise;
    return mongoose.connection;
  }

  connectPromise = mongoose
    .connect(ENV.MONGO_URI, {
      dbName: ENV.MONGO_DB_NAME,
      maxPoolSize: Number(ENV.MONGO_MAX_POOL_SIZE || 20),
      minPoolSize: Number(ENV.MONGO_MIN_POOL_SIZE || 0),
      serverSelectionTimeoutMS: 5000, // أسرع فشلًا (أفضل للـ worker)
      socketTimeoutMS: 30_000,
      family: 4, // يقلل مشاكل IPv6 على بعض البيئات
    })
    .then(() => {
      // ensure readiness
      if (!isReadyStateConnected()) {
        const err = new Error("DB_NOT_READY_AFTER_CONNECT");
        err.code = "DB_NOT_READY_AFTER_CONNECT";
        throw err;
      }
      return mongoose.connection;
    })
    .catch((err) => {
      // reset so a future call can retry
      connectPromise = null;
      logger.error({ err }, "MongoDB connect failed");
      markUnhealthy("db_connect_failed");
      throw err;
    });

  await connectPromise;
  return mongoose.connection;
}

export async function disconnectDb() {
  try {
    connectPromise = null;
    await mongoose.disconnect();
  } catch (err) {
    logger.error({ err }, "MongoDB disconnect error");
  }
}

/**
 * Readiness probe helper
 */
export function isDbReady() {
  return isReadyStateConnected();
}
