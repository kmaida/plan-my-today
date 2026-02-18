import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createMcpLogger, type IMcpLogger } from "../observability/logger";
import { getSessionIdFromHeaders } from "../types/index";

interface RequestContext {
  requestId: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  logger: IMcpLogger;
}

declare global {
  namespace Express {
    interface Request {
      context: RequestContext;
      requestStartTime: number;
    }
  }
}

export function createLoggingMiddleware(operation: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    req.requestStartTime = Date.now();

    const requestId = randomUUID().substring(0, 8);
    const sessionId = getSessionIdFromHeaders(req.headers);
    const logger = createMcpLogger(sessionId, requestId, undefined, operation);

    req.context = {
      requestId,
      sessionId,
      logger,
    };

    req.context.logger.debug("Incoming request", {
      method: req.method,
      url: req.url,
      contentType: req.headers["content-type"],
      contentLength: req.headers["content-length"],
      userAgent: req.headers["user-agent"],
      hasSessionId: !!sessionId,
      operation,
    });

    res.on("finish", () => {
      const duration = Date.now() - req.requestStartTime;

      req.context.logger.debug("Response finished", {
        statusCode: res.statusCode,
        requestDuration: `${duration}ms`,
      });
    });

    res.on("error", (error) => {
      req.context.logger.error("Response error", {
        error: error.message,
        stack: error.stack,
      });
    });

    next();
  };
}

export const httpLoggingMiddleware = createLoggingMiddleware("http_request");
