import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ProcessManager } from "../src/process/process-manager.js";
import { createApp } from "../src/server/app.js";
import type { HealthStatus } from "../src/types.js";
import { FakeChild, MemoryStateStore, nextTurn } from "./helpers.js";

const healthy: HealthStatus = {
  available: true,
  compatible: true,
  version: "2.1.170",
  minimumVersion: "2.1.51",
};

describe("HTTP API", () => {
  it("creates, lists, stops, restarts, and deletes a process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-api-"));
    const children = new Map<number, FakeChild>();
    let nextPid = 1_000;
    const manager = new ProcessManager(
      new MemoryStateStore(),
      () => {
        const child = new FakeChild(nextPid++);
        children.set(child.pid, child);
        queueMicrotask(() => child.emit("spawn"));
        return child.asChild();
      },
      (pid, signal) => children.get(pid)?.emit("close", 0, signal),
    );
    const app = createApp({ manager, publicDirectory: join(process.cwd(), "public"), getHealth: async () => healthy });

    const created = await request(app).post("/api/processes").send({ name: "API", cwd, spawnMode: "session" }).expect(201);
    const id = created.body.process.id;
    await nextTurn();
    const list = await request(app).get("/api/processes").expect(200);
    expect(list.body.processes).toHaveLength(1);
    expect(list.body.processes[0]).toMatchObject({ id, status: "running" });

    await request(app).post(`/api/processes/${id}/stop`).expect(200).expect(({ body }) => {
      expect(body.process).toMatchObject({ status: "stopped", desiredRunning: false });
    });
    await request(app).post(`/api/processes/${id}/restart`).expect(200);
    await request(app).delete(`/api/processes/${id}`).expect(204);
    await request(app).get("/api/processes").expect(200).expect(({ body }) => {
      expect(body.processes).toEqual([]);
    });
  });

  it("returns structured validation, health, conflict, and origin errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-api-"));
    const child = new FakeChild();
    const manager = new ProcessManager(new MemoryStateStore(), () => child.asChild());
    const app = createApp({ manager, publicDirectory: join(process.cwd(), "public"), getHealth: async () => healthy });

    await request(app).post("/api/processes").send({ name: "Missing", cwd: "/definitely/missing", spawnMode: "session" })
      .expect(400).expect(({ body }) => expect(body.error.code).toBe("validation_error"));
    await request(app).post("/api/processes").set("Origin", "http://evil.example").send({ name: "Bad", cwd, spawnMode: "session" })
      .expect(403).expect(({ body }) => expect(body.error.code).toBe("origin_forbidden"));

    const unavailableApp = createApp({
      manager,
      publicDirectory: join(process.cwd(), "public"),
      getHealth: async () => ({ ...healthy, available: false, compatible: false, error: "missing" }),
    });
    await request(unavailableApp).post("/api/processes").send({ name: "No Claude", cwd, spawnMode: "session" })
      .expect(503).expect(({ body }) => expect(body.error.code).toBe("claude_unavailable"));
  });

  it("opens an SSE stream with an initial snapshot", async () => {
    const manager = new ProcessManager(new MemoryStateStore());
    const app = createApp({ manager, publicDirectory: join(process.cwd(), "public"), getHealth: async () => healthy });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    expect(firstChunk).toContain("event: snapshot");
    expect(firstChunk).toContain('"processes":[]');
    await reader.cancel();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
