import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { AppError } from "../errors.js";
import type { ProcessManager } from "../process/process-manager.js";
import type { HealthStatus } from "../types.js";

export interface AppOptions {
  manager: ProcessManager;
  publicDirectory: string;
  getHealth: () => Promise<HealthStatus>;
}

export function createApp({ manager, publicDirectory, getHealth }: AppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", sameOriginMutations);

  app.get("/api/health", asyncRoute(async (_request, response) => {
    response.json(await getHealth());
  }));

  app.get("/api/processes", (_request, response) => {
    response.json({ processes: manager.list() });
  });

  app.post("/api/processes", asyncRoute(async (request, response) => {
    const health = await getHealth();
    if (!health.ready) {
      throw new AppError(503, "claude_unavailable", health.error ?? "Claude Code is not ready for Remote Control");
    }
    const process = await manager.create(request.body);
    response.status(201).json({ process });
  }));

  app.post("/api/processes/:id/start", asyncRoute(async (request, response) => {
    response.json({ process: await manager.start(String(request.params.id)) });
  }));

  app.post("/api/processes/:id/stop", asyncRoute(async (request, response) => {
    response.json({ process: await manager.stop(String(request.params.id)) });
  }));

  app.post("/api/processes/:id/restart", asyncRoute(async (request, response) => {
    response.json({ process: await manager.restart(String(request.params.id)) });
  }));

  app.delete("/api/processes/:id", asyncRoute(async (request, response) => {
    await manager.delete(String(request.params.id));
    response.status(204).end();
  }));

  app.get("/api/events", (request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify({ processes: manager.list() })}\n\n`);

    const onProcess = (process: ReturnType<ProcessManager["get"]>) => {
      response.write(`event: process\ndata: ${JSON.stringify({ process })}\n\n`);
    };
    const onLog = (event: { processId: string; log: unknown }) => {
      response.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const onConsole = (event: { processId: string; lines: string[] }) => {
      response.write(`event: console\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    manager.on("process", onProcess);
    manager.on("log", onLog);
    manager.on("console", onConsole);

    request.on("close", () => {
      clearInterval(heartbeat);
      manager.off("process", onProcess);
      manager.off("log", onLog);
      manager.off("console", onConsole);
    });
  });

  app.use("/api", (_request, _response, next) => {
    next(new AppError(404, "not_found", "API endpoint not found"));
  });
  app.use(express.static(publicDirectory, { index: "index.html", etag: true }));
  app.get("/*splat", (_request, response) => {
    response.sendFile(resolve(publicDirectory, "index.html"));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    console.error(error);
    response.status(500).json({
      error: { code: "internal_error", message: "An unexpected server error occurred" },
    });
  });

  return app;
}

function sameOriginMutations(request: Request, _response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    next();
    return;
  }
  const origin = request.get("origin");
  const host = request.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        next(new AppError(403, "origin_forbidden", "Cross-origin process control is not allowed"));
        return;
      }
    } catch {
      next(new AppError(403, "origin_forbidden", "Invalid Origin header"));
      return;
    }
  }
  next();
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}
