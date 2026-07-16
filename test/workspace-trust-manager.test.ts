import type { IDisposable, IPty } from "@lydell/node-pty";
import { describe, expect, it, vi } from "vitest";
import {
  isWorkspaceTrustPrompt,
  WorkspaceTrustManager,
} from "../src/trust/workspace-trust-manager.js";

describe("WorkspaceTrustManager", () => {
  it("accepts Claude's trust selection and closes the temporary PTY", async () => {
    const pty = new FakePty();
    const spawn = vi.fn(() => pty as unknown as IPty);
    const manager = new WorkspaceTrustManager(spawn, 0, 1_000);
    const trust = manager.trust("/tmp/project");

    pty.emitData("Do you trust the files in this ");
    pty.emitData("folder?\r\n❯ 1. Yes, proceed\r\n  2. No, exit");
    await trust;

    expect(spawn).toHaveBeenCalledWith("claude", [], expect.objectContaining({ cwd: "/tmp/project" }));
    expect(pty.writes).toEqual(["\r"]);
    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it("recognizes both selector and yes/no trust prompts", () => {
    expect(isWorkspaceTrustPrompt("Do you trust the files in this folder?")).toBe(true);
    expect(isWorkspaceTrustPrompt("Trust this workspace? (y/n)")).toBe(true);
    expect(isWorkspaceTrustPrompt("Claude is ready")).toBe(false);
  });
});

class FakePty {
  readonly writes: string[] = [];
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  readonly onData = (listener: (data: string) => void): IDisposable => {
    this.dataListeners.push(listener);
    return { dispose: () => undefined };
  };

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.push(listener);
    return { dispose: () => undefined };
  };

  readonly write = (data: string): void => {
    this.writes.push(data);
  };

  readonly kill = vi.fn(() => {
    for (const listener of this.exitListeners) listener({ exitCode: 0 });
  });

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}
