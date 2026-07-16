import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import stripAnsi from "strip-ansi";
import { AppError } from "../errors.js";
import type { StateStore } from "../storage/state-store.js";
import type {
  CreateProcessInput,
  LogEntry,
  ProcessDefinition,
  ProcessStatus,
  ProcessView,
} from "../types.js";
import { buildClaudeArguments, buildClaudeEnvironment } from "./command.js";
import { TerminalScreen } from "./terminal-screen.js";
import { validateProcessInput } from "./validation.js";

const MAX_LOG_ENTRIES = 500;
const DUPLICATE_LOOKBACK = 100;
const STOP_TIMEOUT_MS = 5_000;

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type KillProcessGroup = (pid: number, signal: NodeJS.Signals) => void;

interface RuntimeProcess {
  definition: ProcessDefinition;
  status: ProcessStatus;
  child?: ChildProcessWithoutNullStreams;
  startedAt?: string;
  exitCode?: number | null;
  sessionUrl?: string;
  lastError?: string;
  logs: LogEntry[];
  nextLogId: number;
  urlScanTail: Partial<Record<"stdout" | "stderr", string>>;
  terminal: TerminalScreen;
  consoleTimer?: NodeJS.Timeout;
  stopPromise?: Promise<void>;
  resolveStop?: () => void;
  stopTimer?: NodeJS.Timeout;
  finalizedChild?: ChildProcessWithoutNullStreams;
}

export interface ProcessManagerEvents {
  process: [ProcessView];
  log: [{ processId: string; log: LogEntry }];
  console: [{ processId: string; lines: string[] }];
}

export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private readonly processes = new Map<string, RuntimeProcess>();

  constructor(
    private readonly store: StateStore,
    private readonly spawnProcess: SpawnProcess = defaultSpawn,
    private readonly killProcessGroup: KillProcessGroup = defaultKill,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    const definitions = await this.store.load();
    for (const definition of definitions) {
      this.processes.set(definition.id, createRuntime(definition));
    }

    await Promise.all(
      definitions
        .filter((definition) => definition.desiredRunning)
        .map((definition) => this.start(definition.id, false).catch(() => undefined)),
    );
  }

  list(): ProcessView[] {
    return [...this.processes.values()]
      .map(toView)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ProcessView {
    return toView(this.requireProcess(id));
  }

  async create(value: unknown): Promise<ProcessView> {
    const input: CreateProcessInput = await validateProcessInput(value, this.definitions());
    const definition: ProcessDefinition = {
      ...input,
      id: randomUUID(),
      sandbox: input.sandbox ?? false,
      verbose: input.verbose ?? false,
      desiredRunning: true,
    };
    const runtime = createRuntime(definition);
    this.processes.set(definition.id, runtime);
    await this.persist();
    this.emitProcess(runtime);

    try {
      await this.start(definition.id, false);
    } catch (error) {
      // The failed definition remains available for inspection and manual restart.
      if (!(error instanceof AppError)) throw error;
    }
    return toView(runtime);
  }

  async start(id: string, updateDesired = true): Promise<ProcessView> {
    const runtime = this.requireProcess(id);
    if (["starting", "running", "stopping"].includes(runtime.status)) {
      throw new AppError(409, "invalid_state", `Cannot start a process while it is ${runtime.status}`);
    }

    if (updateDesired) {
      runtime.definition.desiredRunning = true;
      await this.persist();
    }

    runtime.status = "starting";
    runtime.startedAt = undefined;
    runtime.exitCode = undefined;
    runtime.lastError = undefined;
    runtime.sessionUrl = undefined;
    this.clearProcessOutput(runtime);
    this.emit("console", { processId: runtime.definition.id, lines: [] });
    this.addLog(runtime, "system", `Starting claude ${buildClaudeArguments(runtime.definition).join(" ")}`);
    this.emitProcess(runtime);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess("claude", buildClaudeArguments(runtime.definition), {
        cwd: runtime.definition.cwd,
        detached: true,
        env: buildClaudeEnvironment(),
        stdio: "pipe",
      });
    } catch (error) {
      this.failStart(runtime, error);
      throw new AppError(500, "spawn_failed", runtime.lastError ?? "Could not start Claude");
    }

    runtime.child = child;
    attachTerminalReader(child.stdout, (chunk) => {
      if (runtime.child === child) this.updateConsole(runtime, chunk);
    });
    attachLineReader(child.stdout, (line) => {
      if (runtime.child === child) this.addLog(runtime, "stdout", line);
    });
    attachLineReader(child.stderr, (line) => {
      if (runtime.child === child) this.addLog(runtime, "stderr", line);
    });

    child.once("spawn", () => {
      if (runtime.child !== child || runtime.status !== "starting") return;
      runtime.status = "running";
      runtime.startedAt = new Date().toISOString();
      this.addLog(runtime, "system", `Started process ${child.pid ?? "(unknown pid)"}`);
      this.emitProcess(runtime);
    });
    child.once("error", (error) => {
      if (runtime.child !== child) return;
      this.failStart(runtime, error);
    });
    child.once("close", (code, signal) => this.finalizeExit(runtime, child, code, signal));

    return toView(runtime);
  }

  async stop(id: string, updateDesired = true): Promise<ProcessView> {
    const runtime = this.requireProcess(id);
    if (updateDesired && runtime.definition.desiredRunning) {
      runtime.definition.desiredRunning = false;
      await this.persist();
    }

    if (!runtime.child || runtime.status === "stopped" || runtime.status === "failed") {
      runtime.status = "stopped";
      runtime.lastError = undefined;
      this.emitProcess(runtime);
      return toView(runtime);
    }
    if (runtime.status === "stopping") {
      await runtime.stopPromise;
      return toView(runtime);
    }

    runtime.status = "stopping";
    this.addLog(runtime, "system", "Stopping process…");
    this.emitProcess(runtime);

    runtime.stopPromise = new Promise((resolve) => {
      runtime.resolveStop = resolve;
    });

    const pid = runtime.child.pid;
    if (pid) {
      try {
        this.killProcessGroup(pid, "SIGTERM");
      } catch (error) {
        this.addLog(runtime, "system", `SIGTERM failed: ${errorMessage(error)}`);
      }
      runtime.stopTimer = setTimeout(() => {
        if (runtime.child && runtime.status === "stopping") {
          this.addLog(runtime, "system", "Process did not stop in 5 seconds; sending SIGKILL");
          try {
            this.killProcessGroup(pid, "SIGKILL");
          } catch (error) {
            this.addLog(runtime, "system", `SIGKILL failed: ${errorMessage(error)}`);
          }
        }
      }, STOP_TIMEOUT_MS);
      runtime.stopTimer.unref();
    } else {
      runtime.child.kill("SIGTERM");
    }

    await runtime.stopPromise;
    return toView(runtime);
  }

  async restart(id: string): Promise<ProcessView> {
    const runtime = this.requireProcess(id);
    if (runtime.status === "starting" || runtime.status === "stopping") {
      throw new AppError(409, "invalid_state", `Cannot restart a process while it is ${runtime.status}`);
    }
    if (runtime.child) await this.stop(id, false);
    runtime.definition.desiredRunning = true;
    await this.persist();
    return this.start(id, false);
  }

  async restartDesiredProcesses(): Promise<void> {
    const ids = [...this.processes.values()]
      .filter((runtime) => runtime.definition.desiredRunning)
      .map((runtime) => runtime.definition.id);

    await Promise.all(ids.map(async (id) => {
      try {
        const runtime = this.requireProcess(id);
        if (runtime.status === "starting" || runtime.status === "stopping") {
          await this.stop(id, false);
        }
        await this.restart(id);
      } catch (error) {
        const runtime = this.processes.get(id);
        if (!runtime) return;
        this.addLog(runtime, "system", `Restart after authentication failed: ${errorMessage(error)}`);
        this.emitProcess(runtime);
      }
    }));
  }

  async delete(id: string): Promise<void> {
    const runtime = this.requireProcess(id);
    if (runtime.child) await this.stop(id, false);
    if (runtime.consoleTimer) clearTimeout(runtime.consoleTimer);
    this.processes.delete(id);
    await this.persist();
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.processes.values()]
        .filter((runtime) => runtime.child)
        .map((runtime) => this.stop(runtime.definition.id, false)),
    );
  }

  private failStart(runtime: RuntimeProcess, error: unknown): void {
    runtime.status = "failed";
    runtime.lastError = errorMessage(error);
    this.addLog(runtime, "system", `Failed to start: ${runtime.lastError}`);
    this.emitProcess(runtime);
  }

  private finalizeExit(
    runtime: RuntimeProcess,
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (runtime.child !== child || runtime.finalizedChild === child) return;
    runtime.finalizedChild = child;
    if (runtime.stopTimer) clearTimeout(runtime.stopTimer);

    const wasStopping = runtime.status === "stopping";
    const alreadyFailed = runtime.status === "failed";
    runtime.child = undefined;
    runtime.exitCode = code;
    runtime.status = wasStopping ? "stopped" : "failed";
    if (!wasStopping && !alreadyFailed) {
      runtime.lastError = `Claude exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})`;
    }
    this.addLog(runtime, "system", wasStopping ? "Process stopped" : runtime.lastError!);
    runtime.resolveStop?.();
    runtime.resolveStop = undefined;
    runtime.stopPromise = undefined;
    this.emitProcess(runtime);
  }

  private addLog(runtime: RuntimeProcess, stream: LogEntry["stream"], rawMessage: string): void {
    const message = stripAnsi(rawMessage).trimEnd();
    if (!message) return;
    const discoveredUrl = runtime.sessionUrl || stream === "system"
      ? undefined
      : scanForSessionUrl(runtime, stream, message);
    if (discoveredUrl) runtime.sessionUrl = discoveredUrl;
    // Stdout is a terminal UI. It is rendered into TerminalScreen instead of
    // being exposed as an append-only log stream.
    if (stream === "stdout") {
      if (discoveredUrl) this.emitProcess(runtime);
      return;
    }
    if (stream !== "system" && isRecentDuplicate(runtime.logs, stream, message)) {
      if (discoveredUrl) this.emitProcess(runtime);
      return;
    }
    const log: LogEntry = {
      id: runtime.nextLogId++,
      timestamp: new Date().toISOString(),
      stream,
      message,
    };
    runtime.logs.push(log);
    if (runtime.logs.length > MAX_LOG_ENTRIES) runtime.logs.shift();

    this.emit("log", { processId: runtime.definition.id, log });
    if (discoveredUrl) this.emitProcess(runtime);
  }

  private emitProcess(runtime: RuntimeProcess): void {
    this.emit("process", toView(runtime));
  }

  private clearProcessOutput(runtime: RuntimeProcess): void {
    runtime.logs = runtime.logs.filter((log) => log.stream === "system");
    runtime.urlScanTail = {};
    runtime.terminal.reset();
    if (runtime.consoleTimer) clearTimeout(runtime.consoleTimer);
    runtime.consoleTimer = undefined;
  }

  private updateConsole(runtime: RuntimeProcess, chunk: string): void {
    runtime.terminal.write(chunk);
    if (runtime.consoleTimer) return;
    runtime.consoleTimer = setTimeout(() => {
      runtime.consoleTimer = undefined;
      this.emit("console", {
        processId: runtime.definition.id,
        lines: runtime.terminal.toLines(),
      });
    }, 75);
    runtime.consoleTimer.unref();
  }

  private requireProcess(id: string): RuntimeProcess {
    const runtime = this.processes.get(id);
    if (!runtime) throw new AppError(404, "not_found", "Process not found");
    return runtime;
  }

  private definitions(): ProcessDefinition[] {
    return [...this.processes.values()].map((runtime) => runtime.definition);
  }

  private async persist(): Promise<void> {
    await this.store.save(this.definitions());
  }
}

function createRuntime(definition: ProcessDefinition): RuntimeProcess {
  return {
    definition,
    status: "stopped",
    logs: [],
    nextLogId: 1,
    urlScanTail: {},
    terminal: new TerminalScreen(),
  };
}

function toView(runtime: RuntimeProcess): ProcessView {
  return {
    ...runtime.definition,
    status: runtime.status,
    pid: runtime.child?.pid,
    startedAt: runtime.startedAt,
    exitCode: runtime.exitCode,
    sessionUrl: runtime.sessionUrl,
    lastError: runtime.lastError,
    logs: [...runtime.logs],
    consoleOutput: runtime.terminal.toLines(),
  };
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) {
  return spawn(command, [...args], options);
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

function attachLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    // Claude redraws its terminal status with bare carriage returns. Treat each
    // redraw as a line instead of accumulating the same message indefinitely.
    const lines = pending.split(/\r\n|[\r\n]/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  stream.on("end", () => {
    if (pending) onLine(pending);
  });
}

function attachTerminalReader(
  stream: NodeJS.ReadableStream,
  onChunk: (chunk: string) => void,
): void {
  stream.setEncoding("utf8");
  stream.on("data", onChunk);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scanForSessionUrl(
  runtime: RuntimeProcess,
  stream: "stdout" | "stderr",
  message: string,
): string | undefined {
  const combined = `${runtime.urlScanTail[stream] ?? ""}${message}`;
  runtime.urlScanTail[stream] = combined.slice(-512);
  return combined
    .match(/https:\/\/claude\.ai\/code[/?#][^\s]+/i)?.[0]
    .replace(/[),.;]+$/, "");
}

function isRecentDuplicate(
  logs: LogEntry[],
  stream: LogEntry["stream"],
  message: string,
): boolean {
  const start = Math.max(0, logs.length - DUPLICATE_LOOKBACK);
  for (let index = logs.length - 1; index >= start; index -= 1) {
    const log = logs[index];
    if (log.stream === stream && log.message === message) return true;
  }
  return false;
}
