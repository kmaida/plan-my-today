#!/usr/bin/env node

import { config } from "./config";
import { initializeLogger } from "./observability/logger";
import { initializeTelemetry, shutdownTelemetry } from "./observability/telemetry";
import { startServer } from "./server";

// Initialize observability if enabled
if (config.observability.enableOtel) {
  initializeTelemetry();
}

// Initialize logging with environment-based log level
initializeLogger({
  service: config.observability.serviceName,
  version: config.observability.serviceVersion,
  environment: config.observability.environment,
});

// Graceful shutdown: flush pending OTel spans before exit
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await shutdownTelemetry();
    process.exit(0);
  });
}

startServer();
