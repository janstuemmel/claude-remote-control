import { describe, expect, it } from "vitest";
import { buildClaudeArguments, buildClaudeEnvironment } from "../src/process/command.js";
import type { ProcessDefinition } from "../src/types.js";

const base: ProcessDefinition = {
  id: "id",
  name: "My Project",
  cwd: "/tmp/project",
  spawnMode: "session",
  sandbox: false,
  verbose: false,
  desiredRunning: true,
};

describe("buildClaudeArguments", () => {
  it("builds a single-session command", () => {
    expect(buildClaudeArguments(base)).toEqual([
      "remote-control", "--name", "My Project", "--spawn", "session",
    ]);
  });

  it("adds shared capacity and optional flags", () => {
    expect(buildClaudeArguments({
      ...base,
      spawnMode: "same-dir",
      capacity: 8,
      sandbox: true,
      verbose: true,
    })).toEqual([
      "remote-control", "--name", "My Project", "--spawn", "same-dir",
      "--capacity", "8", "--verbose", "--sandbox",
    ]);
  });

  it("supports worktree mode", () => {
    expect(buildClaudeArguments({ ...base, spawnMode: "worktree", capacity: 4 }))
      .toContain("worktree");
  });

  it("passes an explicit permission mode", () => {
    expect(buildClaudeArguments({ ...base, permissionMode: "acceptEdits" }))
      .toEqual([
        "remote-control", "--name", "My Project", "--spawn", "session",
        "--permission-mode", "acceptEdits",
      ]);
  });

  it("passes the Remote Control session name prefix", () => {
    expect(buildClaudeArguments(base, { sessionNamePrefix: "build-server" }))
      .toEqual([
        "remote-control", "--name", "My Project", "--spawn", "session",
        "--remote-control-session-name-prefix", "build-server",
      ]);
  });
});

describe("buildClaudeEnvironment", () => {
  it("removes the Anthropic API key without mutating the parent environment", () => {
    const parent = { ANTHROPIC_API_KEY: "secret", PATH: "/usr/bin", KEEP_ME: "yes" };
    const child = buildClaudeEnvironment(parent);

    expect(child).toEqual({ PATH: "/usr/bin", KEEP_ME: "yes" });
    expect(parent.ANTHROPIC_API_KEY).toBe("secret");
  });
});
