/** Pinned Codex runtime version and locked-down configuration for agent capture mode. */
export const CODEX_VERSION = "0.159.2";
// A valid capture may be repeated in dynamic-tool and completed-turn output. Bound each
// JSONL message to four accepted image payloads instead of treating network chunks as messages.
const MAX_CAPTURE_PNG_BYTES = 25 * 1024 * 1024;
const MAX_CAPTURE_REQUEST_BYTES = Math.ceil(MAX_CAPTURE_PNG_BYTES / 3) * 4 + 64 * 1024;
export const MAX_CODEX_MESSAGE_BYTES = 4 * MAX_CAPTURE_REQUEST_BYTES;

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : null;
}

// No model-callable access to the repository, operating system, connectors, or other agents.
// Environments are also explicitly empty on every thread and turn (see session-codex.ts).
export const CHAT_CONFIG = {
  cli_auth_credentials_store: "file",
  forced_login_method: "chatgpt",
  approval_policy: "never",
  sandbox_mode: "read-only",
  web_search: "disabled",
  project_doc_max_bytes: 0,
  include_environment_context: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_permissions_instructions: false,
  skills: { bundled: { enabled: false }, include_instructions: false },
  tools: { experimental_request_user_input: { enabled: false }, update_plan: { enabled: false } },
  orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
  check_for_update_on_startup: false,
  mcp_servers: {},
  plugins: {},
  shell_environment_policy: { inherit: "none" },
  history: { persistence: "none" },
  analytics: { enabled: false },
  feedback: { enabled: false },
  features: {
    shell_tool: false,
    unified_exec: false,
    apply_patch_freeform: false,
    view_image: false,
    search_tool: false,
    image_generation: false,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    computer_use: false,
    js_repl: false,
    code_mode: false,
    // Code-mode-only models wrap supplied dynamic tools in an isolated JS host.
    // The host is selected at process startup; it exposes no ambient shell/filesystem tools.
    code_mode_host: true,
    apps: false,
    plugins: false,
    hooks: false,
    plugin_hooks: false,
    multi_agent: false,
    multi_agent_v2: false,
    memories: false,
    goals: false,
    sleep_tool: false,
    tool_suggest: false,
    workspace_dependencies: false,
    artifact: false,
    chronicle: false,
    skill_search: false,
    skill_mcp_dependency_install: false,
    skip_host_skill_discovery: true,
    tool_search: false,
    request_permissions_tool: false,
    shell_snapshot: false,
    external_migration: false,
    external_agent_memory_import: false,
  },
} as const;
