function shellQuote(value: string): string {
  if (/^\$HOME(?:\/[\w.+-]+)*$/.test(value)) {
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildRemoteAgentSupervisorShutdownCommand(input: {
  readonly binaryPath: string;
  readonly statePath: string;
}): string {
  return `set -eu
BIGBUD_AGENT_STATE_DIR=${shellQuote(input.statePath)} exec ${shellQuote(input.binaryPath)} --shutdown-supervisor
`;
}

export function buildRemoteAgentSupervisorPreparationCommand(
  binaryPath: string,
  connectProxy = false,
): string {
  const binary = shellQuote(binaryPath);
  return [
    "set -u",
    'socket="$HOME/.bigbud/agent/state/supervisor.sock"',
    'log="$HOME/.bigbud/agent/state/supervisor.log"',
    "status=0",
    `if ${binary} --prepare-supervisor; then status=0; else status=$?; fi`,
    'if [ "$status" -eq 10 ]; then',
    '  : > "$log"',
    `  ${binary} --supervisor >/dev/null 2>"$log" &`,
    "  supervisor_pid=$!",
    "  for attempt in 1 2 3 4 5 6 7 8 9 10; do",
    `    if [ -S "$socket" ] && ${binary} --prepare-supervisor; then status=0; break; fi`,
    "    sleep 0.1",
    "  done",
    'elif [ "$status" -ne 0 ]; then',
    '  exit "$status"',
    "fi",
    'if [ "$status" -ne 0 ]; then',
    '  if [ -s "$log" ]; then cat "$log" >&2; fi',
    '  if [ "${supervisor_pid:-}" ]; then wait "$supervisor_pid" || true; fi',
    "  exit 1",
    "fi",
    ...(connectProxy ? [`exec ${binary} --proxy`] : []),
  ].join("\n");
}

export function buildOptionalRemoteAgentSupervisorPreparationCommand(binaryPath: string): string {
  const binary = shellQuote(binaryPath);
  // Unknown flags in 0.2.205 enter stateful stdio and rotate the epoch, even with EOF.
  // Never probe that binary with --prepare-supervisor against restored live state.
  return [
    `if test -x ${binary}; then`,
    `  identity=$(${binary} --check) || exit $?`,
    '  case "$identity" in',
    "    'bigbud-remote-agent\t0.2.205\t'*)",
    "      printf '%s\\n' 'Remote agent 0.2.205 does not support safe supervisor preparation; the binary was restored, but supervisor recovery requires manual verification. Existing work was not stopped by this recovery step.' >&2",
    "      exit 1",
    "      ;;",
    "  esac",
    buildRemoteAgentSupervisorPreparationCommand(binaryPath),
    "fi",
  ].join("\n");
}

export function buildRemoteAgentProxyCommand(binaryPath: string): string {
  const binary = shellQuote(binaryPath);
  return [
    `identity=$(${binary} --check) || exit $?`,
    'case "$identity" in',
    `  'bigbud-remote-agent\t0.2.205\t'*) exec ${binary} --proxy ;;`,
    "esac",
    buildRemoteAgentSupervisorPreparationCommand(binaryPath, true),
  ].join("\n");
}
