# Shared remote session guard: shell exec leases and provider leases.
# `session_guard LIMIT COMMAND...` runs COMMAND as its own process group
# (`setsid`, or `perl setpgrp` where util-linux is absent; neither is 126)
# with the caller's stdin, stdout and stderr. A `-T` session has no PTY, so a
# closed channel sends no SIGHUP and job control is off; the watchdog kills the
# group when the SSH session process (the caller's `$PPID`) is gone or, when
# LIMIT is above 0, after LIMIT seconds. Its own output never holds the
# channel open. Returns COMMAND's exit status.
session_guard() {
  guard_session=$PPID
  guard_limit=$1
  shift
  guard_end=$(( $(date +%s) + guard_limit ))
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" <&0 &
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' "$@" <&0 &
  else
    return 126
  fi
  guard_child=$!
  (
    while { kill -0 "$guard_session" 2>/dev/null || [ -d "/proc/$guard_session" ]; } &&
      kill -0 "$guard_child" 2>/dev/null &&
      { [ "$guard_limit" -eq 0 ] || [ "$(date +%s)" -lt "$guard_end" ]; }; do
      sleep 1
    done
    kill -s TERM -- "-$guard_child" 2>/dev/null
    sleep 1
    kill -s KILL -- "-$guard_child" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  guard_watch=$!
  wait "$guard_child"
  guard_code=$?
  kill -s KILL "$guard_watch" 2>/dev/null
  return "$guard_code"
}
