import http from "http";
import { buildApp } from "./app.js";
import { ENV } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import { connectDb, disconnectDb } from "../data/db.js";
import { setupProcessSafety } from "../utils/shutdown.js";

async function main() {
  await connectDb();

  const app = buildApp();
  const server = http.createServer(app);

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  server.requestTimeout = 30_000;
  server.timeout = 0; // disable legacy timeout behavior

  server.listen(ENV.PORT, () => {
    logger.info({ port: ENV.PORT, env: ENV.NODE_ENV }, "API server listening");
  });

  setupProcessSafety({
    onShutdown: async () => {
      logger.info("Closing HTTP server...");
      await new Promise((resolve) => server.close(resolve));

      logger.info("Disconnecting DB...");
      await disconnectDb();
    },
  });
}

main().catch((err) => {
  logger.fatal({ err }, "API failed to start");
  process.exit(1);
});
