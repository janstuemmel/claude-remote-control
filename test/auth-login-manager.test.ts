import { describe, expect, it, vi } from "vitest";
import { AuthLoginManager, extractAuthUrl, type SpawnAuthProcess } from "../src/auth/auth-login-manager.js";
import { FakeChild, nextTurn } from "./helpers.js";

describe("AuthLoginManager", () => {
  it("captures a streamed login URL, submits a token, and completes", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child.asChild()) as SpawnAuthProcess;
    const onSuccess = vi.fn();
    const manager = new AuthLoginManager(spawn, onSuccess);
    let submitted = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => { submitted += chunk; });

    expect(manager.start()).toMatchObject({ status: "running", output: "" });
    expect(spawn).toHaveBeenCalledWith("claude", ["auth", "login"], expect.objectContaining({ stdio: "pipe" }));

    child.stdout.write("Open https://claude.ai/oauth/author");
    child.stdout.write("ize?code=abc\n");
    expect(manager.get()).toMatchObject({
      status: "running",
      url: "https://claude.ai/oauth/authorize?code=abc",
    });

    manager.submitToken("  one-time-token  ");
    await nextTurn();
    expect(submitted).toBe("one-time-token\n");

    child.emit("close", 0, null);
    expect(manager.get().status).toBe("succeeded");
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("reports failed exits and rejects tokens without a running login", () => {
    const child = new FakeChild();
    const manager = new AuthLoginManager(() => child.asChild());
    expect(() => manager.submitToken("token")).toThrow("No Claude login");
    manager.start();
    child.stderr.write("Login denied\n");
    child.emit("close", 1, null);
    expect(manager.get()).toMatchObject({ status: "failed", error: "Claude login exited with code 1" });
    expect(manager.get().output).toContain("Login denied");
  });

  it("extracts a clean URL from formatted terminal output", () => {
    expect(extractAuthUrl("\u001b[32mContinue: https://example.com/login?code=1.\u001b[0m"))
      .toBe("https://example.com/login?code=1");
  });
});
