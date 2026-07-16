# Claude Remote Control Manager

A small, local web interface for running and managing multiple [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) servers.

The server is written in TypeScript. The browser interface uses plain HTML, CSS, and JavaScript with no frontend build step.

## Requirements

- Node.js 20 or newer
- Claude Code 2.1.51 or newer
- A Claude.ai subscription login; API-key authentication does not support Remote Control
- Workspace trust accepted for every directory you launch, or confirmation through the manager when Claude requests it
- macOS or Linux

Check your setup with:

```sh
claude --version
claude auth status
```

If Remote Control reports that a project has not been trusted yet, the process card offers a **Trust directory** action. Confirming it opens a temporary interactive Claude process, accepts Claude's workspace-trust prompt, closes that process, and retries Remote Control. Only trust directories whose contents you know are safe.

## Run

Run the latest published version without installing it globally:

```sh
npx @janstuemmel/claude-remote-control
```

From a local checkout:

```sh
pnpm install
pnpm build
npx .
```

The manager listens on `0.0.0.0:3000` and prints its reachable URLs for you to open in a browser.

> **Security warning:** there is no authentication or TLS. Anyone who can reach the server can launch Claude against directories accessible to your OS user. Bind to localhost unless you intentionally need LAN access.

```sh
npx @janstuemmel/claude-remote-control --host 127.0.0.1
```

## Options

```text
--host <address>    Address to bind (default: 0.0.0.0)
--port <number>     Port to listen on (default: 3000)
--data-dir <path>   Persistent data directory (default: ~/.claude-remote-control)
--remote-control-session-name-prefix <prefix>
                    Prefix for all Claude Remote Control session names
-h, --help          Show help
```

## Process modes

- **Single session** runs `claude remote-control --spawn=session`.
- **Shared directory** allows multiple sessions to operate in one directory.
- **Git worktrees** gives each on-demand session an isolated worktree and requires a Git repository.

## Permission modes

Each definition can inherit Claude Code's configured permission mode or start Remote Control in one of its supported modes:

- **Ask before changes** (`default`) reads freely and asks before actions requiring approval.
- **Accept edits** (`acceptEdits`) automatically accepts edits and common filesystem operations.
- **Plan only** (`plan`) allows inspection and planning without editing the project.

Auto and bypass permission modes are not available in Remote Control sessions.

Definitions are saved in `~/.claude-remote-control/state.json`. Processes marked as running are relaunched the next time the manager starts. A process that crashes stays failed so that an authentication or configuration problem cannot create a restart loop.

Stopping the manager with Ctrl-C gracefully stops its child process groups while preserving their desired state. Explicitly pressing **Stop** in the UI prevents that definition from relaunching next time.

## Development

```sh
pnpm dev          # run directly from TypeScript
pnpm typecheck    # static checks
pnpm test         # automated tests
pnpm build        # compile to dist/
pnpm check        # all checks and a production build
pnpm release:check # checks and verifies the npm package contents
```

## Release

After authenticating with npm, verify and publish the current version:

```sh
pnpm release:check
npm publish
```

The package is configured as public and publishes to the npm registry. Update the version in `package.json` before each subsequent release.

The main areas are deliberately separated:

```text
src/auth/         interactive Claude authentication lifecycle
src/process/      process lifecycle, commands, and validation
src/server/       HTTP API and live event stream
src/storage/      persistent state
public/           build-free browser UI
test/             unit and API tests
```

## HTTP API

The UI uses the following same-origin endpoints:

```text
GET    /api/health
GET    /api/auth/login
POST   /api/auth/login
POST   /api/auth/login/token
GET    /api/processes
POST   /api/processes
POST   /api/processes/:id/start
POST   /api/processes/:id/stop
POST   /api/processes/:id/restart
POST   /api/processes/:id/trust
DELETE /api/processes/:id
GET    /api/events
```

`/api/events` is a Server-Sent Events stream containing snapshots, lifecycle changes, authentication updates, and new log entries. Authentication tokens are forwarded directly to the active Claude process and are not persisted.
