import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import stripAnsi from "strip-ansi";
import { AppError } from "../errors.js";
import { buildClaudeEnvironment } from "../process/command.js";
import type { AuthLoginView } from "../types.js";

const MAX_OUTPUT_LENGTH = 20_000;
const MAX_TOKEN_LENGTH = 16_384;

export type SpawnAuthProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface AuthLoginEvents {
  change: [AuthLoginView];
}

export class AuthLoginManager extends EventEmitter<AuthLoginEvents> {
  private child?: ChildProcessWithoutNullStreams;
  private view: AuthLoginView = { status: "idle", output: "" };

  constructor(
    private readonly spawnProcess: SpawnAuthProcess = defaultSpawn,
    private readonly onSuccess: () => void = () => undefined,
  ) {
    super();
  }

  get(): AuthLoginView {
    return { ...this.view };
  }

  start(): AuthLoginView {
    if (this.child) throw new AppError(409, "auth_login_running", "A Claude login is already running");

    this.view = {
      status: "running",
      startedAt: new Date().toISOString(),
      output: "",
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess("claude", ["auth", "login"], {
        env: buildClaudeEnvironment(),
        stdio: "pipe",
      });
    } catch (error) {
      this.fail(error);
      throw new AppError(500, "auth_login_failed", this.view.error ?? "Could not start Claude login");
    }

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.appendOutput(chunk));
    child.stderr.on("data", (chunk: string) => this.appendOutput(chunk));
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.fail(error);
    });
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (code === 0) {
        this.view = { ...this.view, status: "succeeded", error: undefined };
        this.onSuccess();
      } else {
        this.view = {
          ...this.view,
          status: "failed",
          error: `Claude login exited ${signal ? `with ${signal}` : `with code ${code ?? "unknown"}`}`,
        };
      }
      this.emitChange();
    });
    this.emitChange();
    return this.get();
  }

  submitToken(value: unknown): AuthLoginView {
    if (!this.child || this.view.status !== "running") {
      throw new AppError(409, "auth_login_not_running", "No Claude login is waiting for a token");
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new AppError(400, "validation_error", "Token is required");
    }
    if (value.length > MAX_TOKEN_LENGTH) {
      throw new AppError(400, "validation_error", "Token is too long");
    }
    this.child.stdin.write(`${value.trim()}\n`);
    return this.get();
  }

  shutdown(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGTERM");
  }

  private appendOutput(rawChunk: string): void {
    const chunk = stripAnsi(rawChunk).replace(/\r\n?/g, "\n");
    const combined = `${this.view.output}${chunk}`;
    // Re-scan accumulated output because a valid-looking URL can be split
    // across stdout chunks and become longer when the next chunk arrives.
    const url = extractUrl(combined) ?? this.view.url;
    this.view = {
      ...this.view,
      url,
      output: combined.slice(-MAX_OUTPUT_LENGTH),
    };
    this.emitChange();
  }

  private fail(error: unknown): void {
    this.view = {
      ...this.view,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    this.emitChange();
  }

  private emitChange(): void {
    this.emit("change", this.get());
  }
}

export function extractAuthUrl(output: string): string | undefined {
  return extractUrl(stripAnsi(output));
}

function extractUrl(output: string): string | undefined {
  const matches = output.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const match of matches) {
    const candidate = match.replace(/[),.;\]}]+$/, "");
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch {
      // Continue scanning if terminal formatting produced a partial URL.
    }
  }
  return undefined;
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) {
  return spawn(command, [...args], options);
}
