export const CUA_DRIVER_POLICY_VERSION = "1";

export const CUA_DRIVER_REQUIRED_TOOLS = [
  "start_session",
  "get_session_state",
  "end_session",
  "health_report",
  "check_permissions",
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_accessibility_tree",
  "launch_app",
  "bring_to_front",
  "click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
] as const;

export const CUA_DRIVER_DENIED_TOOLS = [
  "kill_app",
  "start_recording",
  "stop_recording",
  "replay",
  "update",
  "browser",
  "page",
  "desktop",
  "escalate",
] as const;

export const CUA_DRIVER_POLICY_YAML = `allow:
  tools:
${CUA_DRIVER_REQUIRED_TOOLS.map((tool) => `    - ${tool}`).join("\n")}
deny:
  tools:
${CUA_DRIVER_DENIED_TOOLS.map((tool) => `    - ${tool}`).join("\n")}
`;

export const CUA_DRIVER_POLICY_SHA256 =
  "520983778cb0b26ca1c909cc71c50852b54c0c5b10add02ec21b6002026be12b";
