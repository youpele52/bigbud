/** Private, runtime-specific remote PID evidence, removed before output/history publication. */
export function remoteShellPidPrefix(runtimeGeneration: string): string {
  return `\x1b]777;bigbud-shell-${runtimeGeneration};`;
}

export function remoteShellStartup(runtimeGeneration: string): string {
  // runtimeGeneration is a server-generated UUID, never user input. exec preserves this PID.
  return `printf '\\033]777;bigbud-shell-${runtimeGeneration};%s\\007' "$$"; exec "\${SHELL:-/bin/sh}" -l`;
}

export function createRemoteShellPidReader(
  runtimeGeneration: string,
  onPid: (pid: number) => void,
): (data: string) => string {
  const prefix = remoteShellPidPrefix(runtimeGeneration);
  let pending = "";
  let complete = false;
  return (data) => {
    if (complete) return data;
    const text = pending + data;
    pending = "";
    const start = text.indexOf(prefix);
    if (start >= 0) {
      const end = text.indexOf("\x07", start + prefix.length);
      if (end >= 0) {
        const value = text.slice(start + prefix.length, end);
        const pid = Number(value);
        if (/^\d+$/.test(value) && Number.isSafeInteger(pid) && pid > 1) {
          complete = true;
          onPid(pid);
          return text.slice(0, start) + text.slice(end + 1);
        }
      } else if (text.length - start <= prefix.length + 16) {
        pending = text.slice(start);
        return text.slice(0, start);
      }
      // Malformed evidence is ordinary output; never allow unbounded pending text.
      return text;
    }
    let suffix = Math.min(prefix.length - 1, text.length);
    while (suffix > 0 && !prefix.startsWith(text.slice(-suffix))) suffix--;
    if (suffix > 0) pending = text.slice(-suffix);
    return suffix > 0 ? text.slice(0, -suffix) : text;
  };
}
