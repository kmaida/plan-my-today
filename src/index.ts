#!/usr/bin/env node

import { config } from "./config";
import { initializeLogger } from "./observability/logger";
import { startServer } from "./server";

// Initialize logging with environment-based log level
initializeLogger({
  service: config.observability.serviceName,
  version: config.observability.serviceVersion,
  environment: config.observability.environment,
});

// Graceful shutdown
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    process.exit(0);
  });
}

startServer();
