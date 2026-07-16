import type { ProcessDefinition } from "../types.js";

export function buildClaudeArguments(definition: ProcessDefinition): string[] {
  const args = ["remote-control", "--name", definition.name, "--spawn", definition.spawnMode];

  if (definition.spawnMode !== "session") {
    args.push("--capacity", String(definition.capacity ?? 32));
  }
  if (definition.permissionMode) args.push("--permission-mode", definition.permissionMode);
  if (definition.verbose) args.push("--verbose");
  if (definition.sandbox) args.push("--sandbox");

  return args;
}

export function buildClaudeEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.ANTHROPIC_API_KEY;
  return childEnvironment;
}
