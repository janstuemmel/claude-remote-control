import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PersistedState, ProcessDefinition } from "../types.js";

const EMPTY_STATE: PersistedState = { version: 1, processes: [] };

export interface StateStore {
  load(): Promise<ProcessDefinition[]>;
  save(processes: ProcessDefinition[]): Promise<void>;
}

export class JsonStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<ProcessDefinition[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const state = JSON.parse(contents) as Partial<PersistedState>;

      if (state.version !== 1 || !Array.isArray(state.processes)) {
        throw new Error("Unsupported or malformed state file");
      }

      return state.processes as ProcessDefinition[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Could not read state from ${this.filePath}: ${errorMessage(error)}`);
    }
  }

  async save(processes: ProcessDefinition[]): Promise<void> {
    const state: PersistedState = { ...EMPTY_STATE, processes };
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;

    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
