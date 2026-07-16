import { spawn, type IPty, type IPtyForkOptions } from "@lydell/node-pty";
import stripAnsi from "strip-ansi";
import { AppError } from "../errors.js";
import { buildClaudeEnvironment } from "../process/command.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ACCEPT_DELAY_MS = 1_200;
const MAX_OUTPUT_LENGTH = 8_000;

export type SpawnTrustPty = (
  file: string,
  args: string[],
  options: IPtyForkOptions,
) => IPty;

export class WorkspaceTrustManager {
  private active?: IPty;

  constructor(
    private readonly spawnPty: SpawnTrustPty = spawn,
    private readonly acceptDelayMs = DEFAULT_ACCEPT_DELAY_MS,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async trust(cwd: string): Promise<void> {
    if (this.active) {
      throw new AppError(409, "workspace_trust_running", "Another workspace trust prompt is already open");
    }

    await new Promise<void>((resolve, reject) => {
      let pty: IPty;
      try {
        pty = this.spawnPty("claude", [], {
          cwd,
          env: buildClaudeEnvironment(),
          name: "xterm-256color",
          cols: 100,
          rows: 30,
        });
      } catch (error) {
        reject(new AppError(500, "workspace_trust_failed", errorMessage(error)));
        return;
      }

      this.active = pty;
      let output = "";
      let accepted = false;
      let acceptTimer: NodeJS.Timeout | undefined;
      let finished = false;

      const timeout = setTimeout(() => {
        if (finished) return;
        finish(new AppError(
          504,
          "workspace_trust_timeout",
          "Claude did not show a workspace trust prompt. Open Claude manually in this directory to inspect its startup flow.",
          output.trim() || undefined,
        ));
        pty.kill();
      }, this.timeoutMs);
      timeout.unref();

      const finish = (error?: AppError) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (acceptTimer) clearTimeout(acceptTimer);
        if (this.active === pty) this.active = undefined;
        if (error) reject(error);
        else resolve();
      };

      pty.onData((chunk) => {
        const plain = stripAnsi(chunk);
        output = `${output}${plain}`.slice(-MAX_OUTPUT_LENGTH);
        if (accepted || !isWorkspaceTrustPrompt(output)) return;

        accepted = true;
        pty.write(/\(y\/n\)/i.test(output) ? "y\r" : "\r");
        // Claude persists trust as soon as the selection is confirmed, then
        // proceeds into a normal interactive session. Give it time to flush
        // that state before closing the temporary PTY.
        acceptTimer = setTimeout(() => pty.kill(), this.acceptDelayMs);
        acceptTimer.unref();
      });

      pty.onExit(() => {
        if (accepted) finish();
        else finish(new AppError(
          500,
          "workspace_trust_failed",
          "Claude exited before workspace trust could be accepted",
          output.trim() || undefined,
        ));
      });
    });
  }

  shutdown(): void {
    this.active?.kill();
    this.active = undefined;
  }
}

export function isWorkspaceTrustPrompt(output: string): boolean {
  return /Do you trust the files in this folder\?/i.test(output)
    || /trust this (?:folder|workspace)\??/i.test(output);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
