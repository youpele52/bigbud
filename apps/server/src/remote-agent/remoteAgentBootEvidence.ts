/** Linux-only boot identity. Never turn missing evidence or a same-boot wrapper death into exit. */
export function remoteAgentBootEvidenceFunctions(): string {
  return `valid_boot_id() {
  test "\${#1}" = 36 && printf '%s' "$1" | LC_ALL=C grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}
current_boot_id() {
  test "$(uname -s)" = Linux || return 1
  test -f /proc/sys/kernel/random/boot_id && test ! -L /proc/sys/kernel/random/boot_id || return 1
  boot_id=$(cat /proc/sys/kernel/random/boot_id) || return 1
  valid_boot_id "$boot_id" || return 1
  printf '%s' "$boot_id"
}
boot_relation() {
  private_file "$state/launch.boot" || { printf unknown; return; }
  recorded_boot=$(cat "$state/launch.boot") || { printf unknown; return; }
  valid_boot_id "$recorded_boot" || { printf unknown; return; }
  current_boot=$(current_boot_id) || { printf unknown; return; }
  if test "$recorded_boot" = "$current_boot"; then printf current; else printf previous; fi
}
record_launch_boot() {
  current_boot=$(current_boot_id) || return 1
  if test -e "$state/launch.boot" || test -L "$state/launch.boot"; then
    private_file "$state/launch.boot" || return 1
  fi
  boot_temporary=$(mktemp "$state/.launch-boot.XXXXXX") || return 1
  if printf '%s' "$current_boot" > "$boot_temporary" && sync -f "$boot_temporary" &&
    mv -T -- "$boot_temporary" "$state/launch.boot" && sync -f "$state"; then return 0; fi
  rm -f -- "$boot_temporary"
  return 1
}
`;
}
