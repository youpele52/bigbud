/** Match Rust char::is_control for private paths/config text; only unit text permits LF. */
export function hasLocalSupervisorServiceControls(value: string, allowLineFeed = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && !(allowLineFeed && code === 10)) || (code >= 127 && code <= 159)) return true;
  }
  return false;
}
