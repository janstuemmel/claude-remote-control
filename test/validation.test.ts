import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateProcessInput } from "../src/process/validation.js";
import type { ProcessDefinition } from "../src/types.js";

describe("validateProcessInput", () => {
  it("normalizes a valid input and supplies shared capacity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-validation-"));
    const input = await validateProcessInput({ name: "  Project  ", cwd, spawnMode: "same-dir" }, []);
    expect(input).toMatchObject({ name: "Project", cwd, spawnMode: "same-dir", capacity: 32 });
  });

  it("rejects missing directories and duplicate names", async () => {
    await expect(validateProcessInput({ name: "A", cwd: "/missing/crc", spawnMode: "session" }, []))
      .rejects.toMatchObject({ code: "validation_error" });

    const cwd = await mkdtemp(join(tmpdir(), "crc-validation-"));
    const existing = [{ name: "Project" }] as ProcessDefinition[];
    await expect(validateProcessInput({ name: "project", cwd, spawnMode: "session" }, existing))
      .rejects.toMatchObject({ status: 409, code: "duplicate_name" });
  });

  it("validates capacities and Git worktrees", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-validation-"));
    await expect(validateProcessInput({ name: "A", cwd, spawnMode: "same-dir", capacity: 0 }, []))
      .rejects.toMatchObject({ code: "validation_error" });
    await expect(validateProcessInput({ name: "A", cwd, spawnMode: "worktree" }, []))
      .rejects.toMatchObject({ code: "validation_error" });

    execFileSync("git", ["init", "--quiet", cwd]);
    await writeFile(join(cwd, "README.md"), "test");
    await expect(validateProcessInput({ name: "A", cwd, spawnMode: "worktree", capacity: 2 }, []))
      .resolves.toMatchObject({ spawnMode: "worktree", capacity: 2 });
  });

  it("accepts only Remote Control permission modes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crc-validation-"));
    await expect(validateProcessInput({
      name: "Plan",
      cwd,
      spawnMode: "session",
      permissionMode: "plan",
    }, [])).resolves.toMatchObject({ permissionMode: "plan" });

    await expect(validateProcessInput({
      name: "Bypass",
      cwd,
      spawnMode: "session",
      permissionMode: "bypassPermissions",
    }, [])).rejects.toMatchObject({ code: "validation_error" });
  });
});
