import { logger } from "./logger.js";

export function setupProcessSafety({ onShutdown }) {
  let shuttingDown = false;

  const safeShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn({ signal }, "Shutdown initiated");

    try {
      await onShutdown?.();
      logger.info("Shutdown completed");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => safeShutdown("SIGINT"));
  process.on("SIGTERM", () => safeShutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
  });

  return { safeShutdown };
}
