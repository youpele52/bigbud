import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** The SSH daemon's startup files and this launcher must never be writable by a session. */
export async function prepareInteractiveCommand({
  root,
  home,
  folder,
  sandbox,
  commandPolicy,
}: {
  root: string;
  home: string;
  folder: string;
  sandbox: string;
  commandPolicy: string;
}) {
  const startup = path.join(root, "startup");
  const scratch = path.join(root, "scratch");
  const dispatch = path.join(startup, "dispatch.sh");
  await mkdir(startup, { mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  const systemBin = '(subpath "/bin" "/usr/bin")';
  const writable = `(subpath ${JSON.stringify(home)} ${JSON.stringify(scratch)})`;
  const tty = '(literal "/dev/null" "/dev/tty" (param "SESSION_TTY"))';
  await writeFile(
    commandPolicy,
    [
      "(version 1)",
      "(deny default)",
      "(allow process-fork)",
      `(allow process-exec ${systemBin})`,
      // Stock uname -s/-m reads exactly these two selectors on macOS.
      '(allow sysctl-read (sysctl-name "kern.ostype") (sysctl-name "hw.machine"))',
      // Allow only the tty allocated by sshd (and its controlling tty alias), not other sessions.
      `(allow file-read* file-write* file-ioctl ${tty})`,
      `(allow file-read* file-write* ${writable})`,
      `(allow file-read* (literal ${JSON.stringify(startup)} ${JSON.stringify(dispatch)}))`,
      `(allow file-read-metadata (literal "/private" "/private/tmp" ${JSON.stringify(root)}))`,
      `(allow file-read* ${systemBin} (subpath "/usr/lib" "/usr/share/terminfo" "/System/Library"))`,
      // Darwin shell startup needs the root vnode and the system /bin/sh selector.
      '(allow file-read* (literal "/" "/private/var/select/sh"))',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    dispatch,
    [
      "umask 077",
      'if [ -z "$1" ] && [ -t 0 ] && [ -t 1 ]; then',
      '  cd -P "$2" || exit 1',
      "  exec /bin/bash --noprofile --norc -i",
      "fi",
      'cd -P "$HOME" || exit 1',
      'exec /bin/sh -c "$1"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return {
    setEnv: `HOME=${startup} ZDOTDIR=${startup} PATH=/usr/bin:/bin LC_ALL=C`,
    forceCommand:
      `cd ${startup} && exec ${sandbox} -f ${commandPolicy} -D SESSION_TTY="\${SSH_TTY:-/dev/null}" ` +
      `/usr/bin/env -i HOME=${home} TMPDIR=${scratch} PATH=/usr/bin:/bin LC_ALL=C TERM="\${TERM:-dumb}" ` +
      `/bin/sh ${dispatch} "$SSH_ORIGINAL_COMMAND" '${folder.replaceAll("'", "'\\''")}'`,
  };
}
