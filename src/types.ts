export const SPAWN_MODES = ["session", "same-dir", "worktree"] as const;
export const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;

export type SpawnMode = (typeof SPAWN_MODES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ProcessStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface CreateProcessInput {
  name: string;
  cwd: string;
  spawnMode: SpawnMode;
  permissionMode?: PermissionMode;
  capacity?: number;
  sandbox?: boolean;
  verbose?: boolean;
}

export interface ProcessDefinition {
  id: string;
  name: string;
  cwd: string;
  spawnMode: SpawnMode;
  permissionMode?: PermissionMode;
  capacity?: number;
  sandbox: boolean;
  verbose: boolean;
  desiredRunning: boolean;
}

export interface LogEntry {
  id: number;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface ProcessView extends ProcessDefinition {
  status: ProcessStatus;
  pid?: number;
  startedAt?: string;
  exitCode?: number | null;
  sessionUrl?: string;
  lastError?: string;
  trustRequired?: boolean;
  logs: LogEntry[];
  consoleOutput: string[];
}

export interface PersistedState {
  version: 1;
  processes: ProcessDefinition[];
}

export interface HealthStatus {
  available: boolean;
  compatible: boolean;
  ready: boolean;
  version?: string;
  minimumVersion: string;
  auth: ClaudeAuthStatus;
  error?: string;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
  error?: string;
}

export type AuthLoginState = "idle" | "running" | "succeeded" | "failed";

export interface AuthLoginView {
  status: AuthLoginState;
  startedAt?: string;
  url?: string;
  output: string;
  error?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
