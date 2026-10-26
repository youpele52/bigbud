// These scripts run on the remote host. Local ssh termination is not remote process termination.
export const SSH_OWNED_COMMAND = [
  "dir=$1; shift",
  'test -d "$dir" || exit 125',
  "if ! command -v setsid >/dev/null 2>&1; then",
  '  printf "Cancellation-safe SSH tools require setsid on the remote host; use the remote agent instead.\\n" >&2',
  '  touch "$dir/done"; exit 125',
  "fi",
  // POSIX background jobs otherwise inherit /dev/null, discarding write/patch payloads.
  "exec 3<&0",
  // Publish the new session/process group before checking cancellation, closing the startup race.
  'setsid sh -c \'dir=$1; shift; exec 3<&-; printf "%s\\n" "$$" > "$dir/pid"; test ! -e "$dir/cancelled" || exit 130; exec "$@"\' bigbud-owned-command "$dir" "$@" <&3 &',
  "leader=$!",
  "exec 3<&-",
  'wait "$leader"; code=$?',
  'touch "$dir/done"',
  'exit "$code"',
].join("\n");

export const SSH_CANCEL_COMMAND = [
  "dir=$1",
  'test -d "$dir" || exit 1',
  'touch "$dir/cancelled" || exit 1',
  "i=0",
  'while [ "$i" -lt 100 ]; do',
  '  group=$(cat "$dir/pid" 2>/dev/null || true)',
  '  case "$group" in ""|*[!0-9]*|0|1) group= ;; esac',
  // Ignore zombies: they cannot execute, and only their remote parent can reap them.
  "  snapshot=$(ps -axo pgid=,stat=) || exit 1",
  "  live=$(printf '%s\\n' \"$snapshot\" | awk -v g=\"$group\" '$1 == g && $2 !~ /^Z/ { print 1; exit }')",
  // A published group with no executable members is terminal even if the SSH wrapper died.
  '  if [ -z "$live" ] && { [ -f "$dir/done" ] || [ -n "$group" ]; }; then exit 0; fi',
  '  if [ -n "$group" ] && [ -n "$live" ]; then',
  '    if [ "$i" -lt 20 ]; then kill -TERM -"$group" 2>/dev/null || true;',
  '    else kill -KILL -"$group" 2>/dev/null || true; fi',
  "  fi",
  "  sleep 0.05",
  "  i=$((i + 1))",
  "done",
  'printf "Remote process group termination remains unconfirmed.\\n" >&2',
  "exit 1",
].join("\n");
