import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildClaudeEnvironment } from "./process/command.js";
import type { ClaudeAuthStatus, HealthStatus } from "./types.js";

const execFileAsync = promisify(execFile);
export const MINIMUM_CLAUDE_VERSION = "2.1.51";

export async function checkClaudeHealth(): Promise<HealthStatus> {
  try {
    const { stdout, stderr } = await execFileAsync("claude", ["--version"], { timeout: 5_000 });
    const output = `${stdout}\n${stderr}`;
    const version = output.match(/\d+\.\d+\.\d+/)?.[0];
    if (!version) {
      return {
        available: true,
        compatible: false,
        ready: false,
        minimumVersion: MINIMUM_CLAUDE_VERSION,
        auth: { loggedIn: false, error: "Authentication was not checked" },
        error: "Could not determine the installed Claude Code version",
      };
    }
    const compatible = compareVersions(version, MINIMUM_CLAUDE_VERSION) >= 0;
    const auth = await checkClaudeAuth();
    const authReady = isRemoteControlAuthReady(auth);
    return {
      available: true,
      compatible,
      ready: compatible && authReady,
      version,
      minimumVersion: MINIMUM_CLAUDE_VERSION,
      auth,
      error: !compatible
        ? `Claude Code ${MINIMUM_CLAUDE_VERSION} or newer is required`
        : authReady
          ? undefined
          : auth.error ?? "Sign in to Claude.ai to use Remote Control",
    };
  } catch (error) {
    return {
      available: false,
      compatible: false,
      ready: false,
      minimumVersion: MINIMUM_CLAUDE_VERSION,
      auth: { loggedIn: false, error: "Claude Code is not available" },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status", "--json"], {
      timeout: 5_000,
      env: buildClaudeEnvironment(),
    });
    return parseClaudeAuthStatus(stdout);
  } catch (error) {
    return {
      loggedIn: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseClaudeAuthStatus(output: string): ClaudeAuthStatus {
  const value = JSON.parse(output) as Record<string, unknown>;
  return {
    loggedIn: value.loggedIn === true,
    authMethod: stringValue(value.authMethod),
    apiProvider: stringValue(value.apiProvider),
    email: stringValue(value.email),
    orgId: stringValue(value.orgId),
    orgName: stringValue(value.orgName),
    subscriptionType: stringValue(value.subscriptionType),
  };
}

export function isRemoteControlAuthReady(auth: ClaudeAuthStatus): boolean {
  return auth.loggedIn && auth.authMethod === "claude.ai";
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
