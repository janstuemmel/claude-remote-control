import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessDefinition } from "../src/types.js";
import type { StateStore } from "../src/storage/state-store.js";

export class MemoryStateStore implements StateStore {
  processes: ProcessDefinition[] = [];
  saves = 0;

  async load(): Promise<ProcessDefinition[]> {
    return structuredClone(this.processes);
  }

  async save(processes: ProcessDefinition[]): Promise<void> {
    this.processes = structuredClone(processes);
    this.saves += 1;
  }
}

export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid: number;

  constructor(pid = 12_345) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    return true;
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
