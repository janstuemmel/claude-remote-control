import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HealthStatus } from "./types.js";

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
        minimumVersion: MINIMUM_CLAUDE_VERSION,
        error: "Could not determine the installed Claude Code version",
      };
    }
    return {
      available: true,
      compatible: compareVersions(version, MINIMUM_CLAUDE_VERSION) >= 0,
      version,
      minimumVersion: MINIMUM_CLAUDE_VERSION,
    };
  } catch (error) {
    return {
      available: false,
      compatible: false,
      minimumVersion: MINIMUM_CLAUDE_VERSION,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
