// src/tracing.js — OpenTelemetry bootstrap (optional, enable with ENABLE_TRACING=true)
// Must be imported first in server.js so instrumentations patch http/express before app loads.

import { createRequire } from "node:module";

const ENABLE_TRACING =
  String(process.env.ENABLE_TRACING || "").trim().toLowerCase() === "true";

if (ENABLE_TRACING) {
  try {
    const require = createRequire(import.meta.url);
    const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
    const { registerInstrumentations } = require("@opentelemetry/instrumentation");
    const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
    const { Resource } = require("@opentelemetry/resources");
    const { SEMRESATTRS_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "simple-shop-v2",
    });

    const provider = new NodeTracerProvider({ resource });

    const isProd = process.env.NODE_ENV === "production";
    if (!isProd && process.env.OTEL_CONSOLE_EXPORTER !== "false") {
      const { SimpleSpanProcessor, ConsoleSpanExporter } = require("@opentelemetry/sdk-trace-base");
      provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    }

    provider.register();

    registerInstrumentations({
      instrumentations: [getNodeAutoInstrumentations()],
    });
  } catch (err) {
    process.emitWarning?.("OpenTelemetry tracing init failed: " + (err?.message || err));
  }
}
