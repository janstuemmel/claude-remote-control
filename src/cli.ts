#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthLoginManager } from "./auth/auth-login-manager.js";
import { checkClaudeHealth } from "./health.js";
import { ProcessManager } from "./process/process-manager.js";
import { createApp } from "./server/app.js";
import { JsonStateStore } from "./storage/state-store.js";
import { WorkspaceTrustManager } from "./trust/workspace-trust-manager.js";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: "3000" },
    "data-dir": { type: "string", default: join(homedir(), ".claude-remote-control") },
    "remote-control-session-name-prefix": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Error: --port must be an integer between 1 and 65535");
  process.exit(1);
}

const host = values.host!;
const dataDirectory = values["data-dir"]!;
const rawSessionNamePrefix = values["remote-control-session-name-prefix"];
const sessionNamePrefix = rawSessionNamePrefix?.trim();
if (rawSessionNamePrefix !== undefined && (
  !sessionNamePrefix
  || sessionNamePrefix.length > 100
  || /\p{Cc}/u.test(sessionNamePrefix)
)) {
  console.error("Error: --remote-control-session-name-prefix must be 1-100 characters without control characters");
  process.exit(1);
}
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDirectory = join(packageDirectory, "public");
const manager = new ProcessManager(
  new JsonStateStore(join(dataDirectory, "state.json")),
  undefined,
  undefined,
  { sessionNamePrefix },
);

try {
  await manager.initialize();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

let healthPromise = checkClaudeHealth();
const authLoginManager = new AuthLoginManager(undefined, () => {
  healthPromise = checkClaudeHealth();
  void healthPromise
    .then(async (health) => {
      if (health.ready) await manager.restartDesiredProcesses();
    })
    .catch((error) => console.warn(`Could not restart processes after authentication: ${error.message}`));
});
const workspaceTrustManager = new WorkspaceTrustManager();
const app = createApp({
  manager,
  publicDirectory,
  authLoginManager,
  workspaceTrustManager,
  getHealth: async () => {
    const health = await healthPromise;
    // Refresh failures so installing/upgrading Claude does not require restarting this manager.
    if (!health.ready) healthPromise = checkClaudeHealth();
    return health;
  },
});

const server = app.listen(port, host, () => {
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const localUrl = `http://${formatHost(browserHost)}:${port}`;

  console.log("\nClaude Remote Control Manager is running");
  console.log(`Local:   ${localUrl}`);
  for (const address of lanAddresses(host)) console.log(`Network: http://${formatHost(address)}:${port}`);
});

server.on("error", async (error) => {
  console.error(`Server failed: ${error.message}`);
  await manager.shutdown();
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}; stopping managed processes…`);
  server.closeAllConnections();
  server.close();
  authLoginManager.shutdown();
  workspaceTrustManager.shutdown();
  await manager.shutdown();
  console.log("Stopped.");
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

function lanAddresses(boundHost: string): string[] {
  if (boundHost !== "0.0.0.0" && boundHost !== "::") return [];
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4") addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function formatHost(value: string): string {
  return value.includes(":") ? `[${value}]` : value;
}

function printHelp(): void {
  console.log(`Claude Remote Control Manager

Usage: claude-remote-control [options]

Options:
  --host <address>    Address to bind (default: 0.0.0.0)
  --port <number>     Port to listen on (default: 3000)
  --data-dir <path>   Persistent data directory (default: ~/.claude-remote-control)
  --remote-control-session-name-prefix <prefix>
                       Prefix for all Claude Remote Control session names
  -h, --help          Show this help`);
}
