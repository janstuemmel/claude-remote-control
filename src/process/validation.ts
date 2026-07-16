import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AppError } from "../errors.js";
import {
  PERMISSION_MODES,
  SPAWN_MODES,
  type CreateProcessInput,
  type PermissionMode,
  type ProcessDefinition,
} from "../types.js";

const execFileAsync = promisify(execFile);

export async function validateProcessInput(
  value: unknown,
  existing: ProcessDefinition[],
): Promise<CreateProcessInput> {
  if (!isRecord(value)) throw validationError("Request body must be an object");

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) throw validationError("Name is required");
  if (name.length > 100) throw validationError("Name must be 100 characters or fewer");
  if (existing.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new AppError(409, "duplicate_name", `A process named “${name}” already exists`);
  }

  if (typeof value.cwd !== "string" || !value.cwd.trim()) {
    throw validationError("Working directory is required");
  }
  const cwd = resolve(value.cwd.trim());
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw validationError("Working directory must be a directory");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw validationError(`Working directory does not exist: ${cwd}`);
  }

  if (typeof value.spawnMode !== "string" || !SPAWN_MODES.includes(value.spawnMode as never)) {
    throw validationError("Mode must be session, same-dir, or worktree");
  }
  const spawnMode = value.spawnMode as CreateProcessInput["spawnMode"];

  let permissionMode: PermissionMode | undefined;
  if (value.permissionMode !== undefined && value.permissionMode !== "") {
    if (typeof value.permissionMode !== "string" || !PERMISSION_MODES.includes(value.permissionMode as PermissionMode)) {
      throw validationError("Permission mode must be default, acceptEdits, or plan");
    }
    permissionMode = value.permissionMode as PermissionMode;
  }

  let capacity: number | undefined;
  if (spawnMode !== "session") {
    capacity = value.capacity === undefined || value.capacity === "" ? 32 : Number(value.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000) {
      throw validationError("Capacity must be an integer between 1 and 1000");
    }
  }

  if (spawnMode === "worktree" && !(await isGitRepository(cwd))) {
    throw validationError("Worktree mode requires a Git repository");
  }

  return {
    name,
    cwd,
    spawnMode,
    permissionMode,
    capacity,
    sandbox: booleanValue(value.sandbox, "sandbox"),
    verbose: booleanValue(value.verbose, "verbose"),
  };
}

function booleanValue(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw validationError(`${field} must be a boolean`);
  return value;
}

async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(message: string): AppError {
  return new AppError(400, "validation_error", message);
}
