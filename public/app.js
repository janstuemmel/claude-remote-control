const state = {
  processes: new Map(),
  health: null,
  pending: new Set(),
  loaded: false,
};

const elements = {
  health: document.querySelector("#health"),
  authDetails: document.querySelector("#auth-details"),
  claudeMissing: document.querySelector("#claude-missing"),
  claudeAuthRequired: document.querySelector("#claude-auth-required"),
  claudeAuthMessage: document.querySelector("#claude-auth-message"),
  addProcess: document.querySelector("#add-process"),
  dialog: document.querySelector("#create-dialog"),
  closeDialog: document.querySelector("#close-dialog"),
  cancelForm: document.querySelector("#cancel-form"),
  form: document.querySelector("#create-form"),
  formError: document.querySelector("#form-error"),
  submitForm: document.querySelector("#submit-form"),
  mode: document.querySelector("#spawnMode"),
  capacityField: document.querySelector("#capacity-field"),
  loading: document.querySelector("#loading"),
  empty: document.querySelector("#empty"),
  processes: document.querySelector("#processes"),
  count: document.querySelector("#process-count"),
  connection: document.querySelector("#connection-state"),
  toast: document.querySelector("#toast"),
};

elements.addProcess.addEventListener("click", () => setFormOpen(true));
elements.closeDialog.addEventListener("click", () => setFormOpen(false));
elements.cancelForm.addEventListener("click", () => setFormOpen(false));
elements.dialog.addEventListener("close", hideFormError);
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) setFormOpen(false);
});
elements.mode.addEventListener("change", updateCapacityVisibility);
elements.form.addEventListener("submit", createProcess);

await loadInitialState();
connectEvents();

async function loadInitialState() {
  try {
    const [health, response] = await Promise.all([api("/api/health"), api("/api/processes")]);
    state.health = health;
    state.processes = new Map(response.processes.map((process) => [process.id, process]));
    renderHealth();
  } catch (error) {
    showToast(error.message);
  } finally {
    state.loaded = true;
    renderProcesses();
  }
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("open", () => {
    elements.connection.textContent = "Live updates connected";
    elements.connection.classList.add("connected");
  });
  events.addEventListener("error", () => {
    elements.connection.textContent = "Reconnecting live updates…";
    elements.connection.classList.remove("connected");
  });
  events.addEventListener("snapshot", (event) => {
    const { processes } = JSON.parse(event.data);
    state.processes = new Map(processes.map((process) => [process.id, process]));
    renderProcesses();
  });
  events.addEventListener("process", (event) => {
    const { process } = JSON.parse(event.data);
    state.processes.set(process.id, process);
    renderProcesses();
  });
  events.addEventListener("log", (event) => {
    const { processId, log } = JSON.parse(event.data);
    const process = state.processes.get(processId);
    if (!process || process.logs.some((item) => item.id === log.id)) return;
    process.logs.push(log);
    if (process.logs.length > 500) process.logs.shift();
    renderProcesses();
  });
  events.addEventListener("console", (event) => {
    const { processId, lines } = JSON.parse(event.data);
    const process = state.processes.get(processId);
    if (!process) return;
    process.consoleOutput = lines;
    renderLiveConsole(processId, lines, process.logs.filter((log) => log.stream === "stderr"));
  });
}

async function createProcess(event) {
  event.preventDefault();
  hideFormError();
  const data = new FormData(elements.form);
  const mode = data.get("spawnMode");
  const body = {
    name: data.get("name"),
    cwd: data.get("cwd"),
    spawnMode: mode,
    permissionMode: data.get("permissionMode") || undefined,
    sandbox: data.get("sandbox") === "on",
    verbose: data.get("verbose") === "on",
  };
  if (mode !== "session") body.capacity = Number(data.get("capacity"));

  elements.submitForm.disabled = true;
  elements.submitForm.textContent = "Launching…";
  try {
    const response = await api("/api/processes", { method: "POST", body });
    state.processes.set(response.process.id, response.process);
    elements.form.reset();
    updateCapacityVisibility();
    setFormOpen(false);
    renderProcesses();
  } catch (error) {
    showFormError(error.message);
  } finally {
    elements.submitForm.disabled = !state.health?.compatible;
    elements.submitForm.textContent = "Launch process";
  }
}

async function processAction(id, action) {
  if (state.pending.has(id)) return;
  const process = state.processes.get(id);
  if (!process) return;
  if (action === "delete" && !window.confirm(`Delete “${process.name}”?${process.status === "running" ? " Its running process will be stopped." : ""}`)) return;

  state.pending.add(id);
  renderProcesses();
  try {
    if (action === "delete") {
      await api(`/api/processes/${id}`, { method: "DELETE" });
      state.processes.delete(id);
    } else {
      const response = await api(`/api/processes/${id}/${action}`, { method: "POST" });
      state.processes.set(id, response.process);
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    state.pending.delete(id);
    renderProcesses();
  }
}

function renderHealth() {
  const health = state.health;
  const authReady = health?.auth?.loggedIn && health.auth.authMethod === "claude.ai";
  elements.health.className = `health ${health?.ready ? "health-ok" : "health-error"}`;
  const errorLabel = !health?.available
    ? "Claude is not available"
    : !health?.compatible
      ? `Claude ${health.version ?? "version unknown"} is unsupported`
      : !health?.auth?.loggedIn
        ? "Claude login required"
        : "Claude.ai authentication required";
  const mobileErrorLabel = !health?.available
    ? "Unavailable"
    : !health?.compatible
      ? "Update Claude"
      : !health?.auth?.loggedIn
        ? "Login required"
        : "Auth error";
  elements.health.innerHTML = '<span class="status-dot"></span>';
  const fullLabel = document.createElement("span");
  fullLabel.className = "health-label-full";
  fullLabel.textContent = health?.ready ? `Claude ${health.version}` : errorLabel;
  const mobileLabel = document.createElement("span");
  mobileLabel.className = "health-label-mobile";
  mobileLabel.textContent = health?.ready ? `Claude ${health.version}` : mobileErrorLabel;
  elements.health.append(fullLabel, mobileLabel);
  renderAuthDetails(health);
  elements.claudeMissing.hidden = health?.available !== false;
  elements.claudeAuthRequired.hidden = !health?.available || authReady;
  elements.claudeAuthMessage.innerHTML = health?.auth?.loggedIn
    ? 'Remote Control requires Claude.ai authentication. Run <code>claude auth login</code> on this server and sign in with a Claude.ai account, then reload this page.'
    : 'Sign in with a Claude.ai account by running <code>claude auth login</code> on this server, then reload this page.';
  elements.submitForm.disabled = !health?.ready;
  elements.addProcess.disabled = !health?.ready;
  elements.addProcess.title = health?.ready ? "" : health?.error ?? "Claude is not ready for Remote Control";
}

function renderAuthDetails(health) {
  elements.authDetails.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = health?.ready ? "Claude is ready" : "Claude needs attention";
  elements.authDetails.append(heading);

  const details = document.createElement("dl");
  details.className = "auth-row";
  for (const [label, value] of [
    ["Version", health?.version],
    ["Signed in", health?.auth?.loggedIn ? "Yes" : "No"],
    ["Method", health?.auth?.authMethod],
    ["Provider", health?.auth?.apiProvider],
    ["Email", health?.auth?.email],
    ["Organization", health?.auth?.orgName],
    ["Organization ID", health?.auth?.orgId],
    ["Subscription", health?.auth?.subscriptionType],
  ]) {
    if (!value) continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    details.append(term, description);
  }
  elements.authDetails.append(details);

  if (!health?.ready) {
    const message = document.createElement("p");
    message.className = "auth-message auth-message-error";
    message.textContent = health?.error ?? health?.auth?.error ?? "Run claude auth login to sign in through Claude.ai.";
    elements.authDetails.append(message);
  }
}

function renderProcesses() {
  elements.loading.hidden = state.loaded;
  const processes = [...state.processes.values()].sort((a, b) => a.name.localeCompare(b.name));
  elements.empty.hidden = !state.loaded || processes.length > 0;
  elements.count.textContent = String(processes.length);

  const openLogs = new Set(
    [...elements.processes.querySelectorAll("details[open]")].map((details) => details.dataset.id),
  );
  elements.processes.replaceChildren(...processes.map((process) => createProcessCard(process, openLogs.has(process.id))));
}

function createProcessCard(process, logsOpen) {
  const card = document.createElement("article");
  card.className = "process-card";
  const busy = state.pending.has(process.id);
  const isActive = ["starting", "running", "stopping"].includes(process.status);
  const mode = process.spawnMode === "session" ? "Single session" : process.spawnMode === "same-dir" ? "Shared directory" : "Git worktrees";
  const permission = process.permissionMode === "default"
    ? "Ask before changes"
    : process.permissionMode === "acceptEdits"
      ? "Accept edits"
      : process.permissionMode === "plan"
        ? "Plan only"
        : "Claude settings";
  const started = process.startedAt ? formatDate(process.startedAt) : "Not started";

  card.innerHTML = `
    <div class="card-main">
      <div class="card-top">
        <div class="card-title"><h3>${escapeHtml(process.name)}</h3><p class="path" title="${escapeHtml(process.cwd)}">${escapeHtml(process.cwd)}</p></div>
        <span class="status status-${process.status}"><span class="status-dot"></span>${process.status}</span>
      </div>
      <div class="meta">
        <span>Mode <strong>${mode}</strong></span>
        <span>Permissions <strong>${permission}</strong></span>
        ${process.capacity ? `<span>Capacity <strong>${process.capacity}</strong></span>` : ""}
        <span>Started <strong>${started}</strong></span>
        ${process.pid ? `<span>PID <strong>${process.pid}</strong></span>` : ""}
        ${process.sandbox ? "<span><strong>Sandboxed</strong></span>" : ""}
      </div>
      ${process.lastError ? `<p class="error-message">${escapeHtml(process.lastError)}</p>` : ""}
      <div class="card-actions"></div>
    </div>`;

  const actions = card.querySelector(".card-actions");
  if (process.sessionUrl) actions.append(linkButton("Open in Claude", process.sessionUrl));
  if (isActive) actions.append(actionButton("Stop", "stop", process.id, busy || process.status === "stopping"));
  if (process.status === "stopped") actions.append(actionButton("Start", "start", process.id, busy));
  if (["running", "failed"].includes(process.status)) actions.append(actionButton("Restart", "restart", process.id, busy));
  const deleteButton = actionButton("Delete", "delete", process.id, busy || process.status === "starting" || process.status === "stopping");
  deleteButton.classList.add("button-danger", "delete");
  actions.append(deleteButton);

  const details = document.createElement("details");
  details.className = "logs";
  details.dataset.id = process.id;
  details.open = logsOpen;
  const systemLogs = process.logs.filter((log) => log.stream === "system");
  const stderrLogs = process.logs.filter((log) => log.stream === "stderr");
  const consoleOutput = process.consoleOutput ?? [];
  details.innerHTML = `<summary>Activity and console</summary>`;
  const groups = document.createElement("div");
  groups.className = "log-groups";
  groups.append(
    createLogGroup("Manager activity", systemLogs, "No lifecycle events yet", false),
    createConsoleGroup(process.id, consoleOutput, stderrLogs),
  );
  details.append(groups);
  details.addEventListener("toggle", () => {
    if (details.open) {
      for (const window of details.querySelectorAll(".log-window")) {
        window.scrollTop = window.scrollHeight;
      }
    }
  });
  card.append(details);
  return card;
}

function actionButton(label, action, id, disabled) {
  const button = document.createElement("button");
  button.className = "button button-quiet";
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", () => processAction(id, action));
  return button;
}

function linkButton(label, url) {
  const link = document.createElement("a");
  link.className = "button button-link";
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function createLogGroup(label, logs, emptyMessage, showStream) {
  const group = document.createElement("section");
  group.className = `log-group ${showStream ? "log-group-console" : "log-group-manager"}`;
  const heading = document.createElement("h4");
  heading.textContent = `${label} · ${logs.length}`;
  const window = document.createElement("div");
  window.className = "log-window";
  if (logs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = emptyMessage;
    window.append(empty);
  } else {
    for (const log of logs) window.append(createLogLine(log, showStream));
  }
  group.append(heading, window);
  return group;
}

function createConsoleGroup(processId, lines, stderrLogs) {
  const group = document.createElement("section");
  group.className = "log-group log-group-console";
  const heading = document.createElement("h4");
  heading.textContent = "Claude console · live";
  const window = document.createElement("div");
  window.className = "log-window terminal-window";
  window.dataset.processId = processId;
  populateConsoleWindow(window, lines, stderrLogs);
  group.append(heading, window);
  return group;
}

function populateConsoleWindow(window, lines, stderrLogs) {
  if (lines.length === 0 && stderrLogs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "Waiting for Claude output…";
    window.append(empty);
  } else {
    for (const message of lines) {
      const line = document.createElement("div");
      line.className = "terminal-line";
      line.textContent = message || " ";
      window.append(line);
    }
    for (const log of stderrLogs.slice(-20)) {
      const line = document.createElement("div");
      line.className = "terminal-line terminal-error";
      line.textContent = `[stderr] ${log.message}`;
      window.append(line);
    }
  }
}

function renderLiveConsole(processId, lines, stderrLogs) {
  const window = [...document.querySelectorAll(".terminal-window")]
    .find((element) => element.dataset.processId === processId);
  if (!window) return;
  const pinnedToBottom = window.scrollHeight - window.scrollTop - window.clientHeight < 24;
  window.replaceChildren();
  populateConsoleWindow(window, lines, stderrLogs);
  if (pinnedToBottom) window.scrollTop = window.scrollHeight;
}

function createLogLine(log, showStream) {
  const line = document.createElement("div");
  line.className = `log-line${showStream ? "" : " log-line-system"}`;
  const columns = [
    ["log-time", new Date(log.timestamp).toLocaleTimeString([], { hour12: false })],
    ...(showStream ? [["log-stream", log.stream]] : []),
    ["log-message", log.message],
  ];
  for (const [className, value] of columns) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = value;
    line.append(span);
  }
  return line;
}

function setFormOpen(open) {
  hideFormError();
  if (open && !elements.dialog.open) {
    elements.dialog.showModal();
    document.querySelector("#name").focus();
  } else if (!open && elements.dialog.open) {
    elements.dialog.close();
  }
}

function updateCapacityVisibility() {
  elements.capacityField.hidden = elements.mode.value === "session";
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return undefined;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body;
}

function showFormError(message) {
  elements.formError.textContent = message;
  elements.formError.hidden = false;
}

function hideFormError() {
  elements.formError.hidden = true;
  elements.formError.textContent = "";
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 5_000);
}

function formatDate(value) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}
