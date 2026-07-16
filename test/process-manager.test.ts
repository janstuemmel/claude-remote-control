import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProcessManager, type SpawnProcess } from "../src/process/process-manager.js";
import type { ProcessDefinition } from "../src/types.js";
import { FakeChild, MemoryStateStore, nextTurn } from "./helpers.js";

describe("ProcessManager", () => {
  it("launches, captures bounded logs and discovers the session URL", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const child = new FakeChild();
    const spawn = vi.fn(() => child.asChild()) as SpawnProcess;
    const manager = new ProcessManager(
      new MemoryStateStore(),
      spawn,
      undefined,
      { sessionNamePrefix: "build-server" },
    );

    const created = await manager.create({ name: "App", cwd, spawnMode: "session" });
    child.emit("spawn");
    child.stdout.write("\u001b[32mReady https://claude.ai/code/session_123.\u001b[0m\n");
    for (let index = 0; index < 505; index += 1) child.stderr.write(`line ${index}\n`);
    await nextTurn();

    const view = manager.get(created.id);
    expect(view.status).toBe("running");
    expect(view.sessionUrl).toBe("https://claude.ai/code/session_123");
    expect(view.logs).toHaveLength(500);
    expect(view.logs.at(-1)?.message).toBe("line 504");
    expect(spawn).toHaveBeenCalledWith("claude", expect.arrayContaining(["--spawn", "session"]), expect.objectContaining({ cwd, detached: true }));
    expect(spawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--remote-control-session-name-prefix", "build-server"]),
      expect.anything(),
    );
  });

  it("does not expose terminal redraws as append-only stdout logs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const child = new FakeChild();
    const manager = new ProcessManager(new MemoryStateStore(), () => child.asChild());
    const created = await manager.create({ name: "App", cwd, spawnMode: "session" });
    child.emit("spawn");

    for (let index = 0; index < 200; index += 1) {
      child.stdout.write("\u001b[2KRemote Control is ready\r");
      child.stdout.write("Waiting for a connection\r");
    }
    child.stdout.write("A genuinely new message\n");
    await nextTurn();

    expect(manager.get(created.id).logs.every((log) => log.stream !== "stdout")).toBe(true);
  });

  it("extracts a query-style session URL split across terminal lines", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const child = new FakeChild();
    const manager = new ProcessManager(new MemoryStateStore(), () => child.asChild());
    const created = await manager.create({ name: "App", cwd, spawnMode: "session" });
    child.emit("spawn");

    child.stdout.write("Continue coding in the Claude app or https://\n");
    child.stdout.write("claude.ai/code?environment=env_01UJ123\n");
    await nextTurn();

    expect(manager.get(created.id).sessionUrl)
      .toBe("https://claude.ai/code?environment=env_01UJ123");
  });

  it("accepts the first-run Remote Control prompt once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const child = new FakeChild();
    const manager = new ProcessManager(new MemoryStateStore(), () => child.asChild());
    const created = await manager.create({ name: "App", cwd, spawnMode: "session" });
    let input = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => { input += chunk; });
    child.emit("spawn");

    child.stdout.write("Take this session with you\nEnable Remote ");
    child.stdout.write("Control? (y/n)");
    child.stdout.write("\rEnable Remote Control? (y/n)");
    await nextTurn();

    expect(input).toBe("y\n");
    expect(manager.get(created.id).logs.some((log) =>
      log.stream === "system" && log.message.includes("Accepted the Claude Remote Control enable prompt"),
    )).toBe(true);
  });

  it("stops the process group and clears desired state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const child = new FakeChild(42);
    const store = new MemoryStateStore();
    const kill = vi.fn(() => child.emit("close", 0, "SIGTERM"));
    const manager = new ProcessManager(store, () => child.asChild(), kill);
    const created = await manager.create({ name: "App", cwd, spawnMode: "session" });
    child.emit("spawn");

    const stopped = await manager.stop(created.id);
    expect(kill).toHaveBeenCalledWith(42, "SIGTERM");
    expect(stopped.status).toBe("stopped");
    expect(store.processes[0].desiredRunning).toBe(false);
  });

  it("marks unexpected exits failed without an immediate restart", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const child = new FakeChild();
    const spawn = vi.fn(() => child.asChild());
    const store = new MemoryStateStore();
    const manager = new ProcessManager(store, spawn);
    const created = await manager.create({ name: "App", cwd, spawnMode: "session" });
    child.emit("spawn");
    child.emit("close", 2, null);

    expect(manager.get(created.id)).toMatchObject({ status: "failed", exitCode: 2, desiredRunning: true });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("marks a process that requires workspace trust", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const child = new FakeChild();
    const manager = new ProcessManager(new MemoryStateStore(), () => child.asChild());
    const created = await manager.create({ name: "App", cwd, spawnMode: "session" });
    child.emit("spawn");
    child.stderr.write("Workspace trust is required. Run `claude` in this project directory to accept it.\n");
    child.emit("close", 1, null);
    await nextTurn();

    expect(manager.get(created.id)).toMatchObject({ status: "failed", trustRequired: true });
  });

  it("clears previous process output when restarting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const children = [new FakeChild(101), new FakeChild(102)];
    let childIndex = 0;
    const manager = new ProcessManager(
      new MemoryStateStore(),
      () => children[childIndex++].asChild(),
      () => children[0].emit("close", 0, "SIGTERM"),
    );
    const created = await manager.create({ name: "App", cwd, spawnMode: "session" });
    children[0].emit("spawn");
    children[0].stdout.write("Old terminal output\n");
    children[0].stderr.write("Old error output\n");
    await nextTurn();

    await manager.restart(created.id);
    children[0].stdout.write("Late old output\n");
    children[0].stderr.write("Late old error\n");
    children[1].emit("spawn");
    children[1].stdout.write("New terminal output\n");
    children[1].stderr.write("New error output\n");
    await nextTurn();

    const view = manager.get(created.id);
    expect(view.consoleOutput.join("\n")).toContain("New terminal output");
    expect(view.consoleOutput.join("\n")).not.toContain("Old");
    expect(view.logs.filter((log) => log.stream === "stderr").map((log) => log.message))
      .toEqual(["New error output"]);
    expect(view.logs.some((log) => log.stream === "system")).toBe(true);
  });

  it("restarts desired processes after authentication and leaves stopped entries alone", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const store = new MemoryStateStore();
    store.processes = [
      definition("retry", "Retry", cwd, true),
      definition("stopped", "Stopped", cwd, false),
    ];
    const children: FakeChild[] = [];
    const manager = new ProcessManager(store, () => {
      const child = new FakeChild(200 + children.length);
      children.push(child);
      return child.asChild();
    });
    await manager.initialize();
    children[0].emit("error", new Error("Authentication required"));
    children[0].emit("close", 1, null);

    await manager.restartDesiredProcesses();

    expect(children).toHaveLength(2);
    expect(manager.get("retry")).toMatchObject({ status: "starting", desiredRunning: true });
    expect(manager.get("stopped")).toMatchObject({ status: "stopped", desiredRunning: false });
  });

  it("restores only definitions that were meant to be running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const store = new MemoryStateStore();
    store.processes = [definition("run", "Running", cwd, true), definition("stop", "Stopped", cwd, false)];
    const children: FakeChild[] = [];
    const manager = new ProcessManager(store, () => {
      const child = new FakeChild(100 + children.length);
      children.push(child);
      return child.asChild();
    });

    await manager.initialize();
    expect(children).toHaveLength(1);
    expect(manager.get("run").status).toBe("starting");
    expect(manager.get("stop").status).toBe("stopped");
  });

  it("preserves desired state during manager shutdown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const child = new FakeChild(55);
    const store = new MemoryStateStore();
    const manager = new ProcessManager(store, () => child.asChild(), () => child.emit("close", 0, "SIGTERM"));
    await manager.create({ name: "App", cwd, spawnMode: "session" });
    child.emit("spawn");
    await manager.shutdown();
    expect(store.processes[0].desiredRunning).toBe(true);
  });

  it("retains a failed definition after a synchronous spawn error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-manager-"));
    const manager = new ProcessManager(new MemoryStateStore(), () => { throw new Error("claude missing"); });
    const view = await manager.create({ name: "App", cwd, spawnMode: "session" });
    expect(view).toMatchObject({ status: "failed", desiredRunning: true, lastError: "claude missing" });
  });
});

function definition(id: string, name: string, cwd: string, desiredRunning: boolean): ProcessDefinition {
  return { id, name, cwd, spawnMode: "session", sandbox: false, verbose: false, desiredRunning };
}
