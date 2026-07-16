import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonStateStore } from "../src/storage/state-store.js";
import type { ProcessDefinition } from "../src/types.js";

describe("JsonStateStore", () => {
  it("returns an empty list when no state exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crc-state-"));
    await expect(new JsonStateStore(join(directory, "nested", "state.json")).load()).resolves.toEqual([]);
  });

  it("atomically saves and loads definitions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crc-state-"));
    const file = join(directory, "state.json");
    const store = new JsonStateStore(file);
    const definition: ProcessDefinition = {
      id: "one", name: "One", cwd: directory, spawnMode: "session",
      sandbox: false, verbose: false, desiredRunning: true,
    };
    await store.save([definition]);
    await expect(store.load()).resolves.toEqual([definition]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
  });
});
