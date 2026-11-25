# Fixed OpenCode v2 supervisor, invoked with -I and a clean environment.
# The owner keeps the outer stdin as its control channel. The credential arrives
# there after the launch signal, never in argv, and the child's own stdin is the
# v2 ownership lease. An authenticated receipt proves wait() for the server.
import os
import select
import signal
import subprocess
import sys
import time

cwd, nonce, host, port = sys.argv[1:5]
profile = os.path.join(
    os.environ.get('HOME', ''), '.local', 'state', 'bigbud', 'opencode-v2'
)


def receipt(text):
    print(f"\nbigbud-opencode-v2 {nonce} {text}", file=sys.stderr, flush=True)


def control(timeout):
    readable, _, _ = select.select([0], [], [], timeout)
    return os.read(0, 1) if readable else None


def credential(deadline):
    data = b''
    while time.monotonic() < deadline:
        byte = control(min(.05, max(0.0, deadline - time.monotonic())))
        if byte is None:
            continue
        if byte == b'' or byte == b'\n':
            return data.decode('ascii', 'ignore') if byte == b'\n' else None
        data += byte
        if len(data) > 64:
            return None
    return None


def environment():
    home = os.environ.get('HOME', '')
    if not home:
        return None
    try:
        os.makedirs(profile, mode=0o700, exist_ok=True)
        os.chmod(profile, 0o700)
    except OSError:
        return None
    return {
        'PATH': '/usr/bin:/bin',
        'LC_ALL': 'C',
        'HOME': home,
        'XDG_CONFIG_HOME': profile + '/config',
        'XDG_DATA_HOME': profile + '/data',
        'XDG_STATE_HOME': profile + '/state',
        'XDG_CACHE_HOME': profile + '/cache',
        'OPENCODE_CONFIG_DIR': profile + '/config/opencode',
        'OPENCODE_DB': profile + '/data/opencode/opencode.db',
        'OPENCODE_CONFIG_PROJECT_DISABLE': '1',
        'OPENCODE_DISABLE_MODELS_FETCH': '1',
    }


def serve():
    env = environment()
    if env is None:
        receipt('rejected')
        return
    receipt('prepared')
    if control(8) != b'S':
        return
    secret = credential(time.monotonic() + 4)
    if (
        secret is None
        or len(secret) != 64
        or any(character not in '0123456789abcdef' for character in secret)
    ):
        receipt('rejected')
        return
    env['OPENCODE_PASSWORD'] = secret
    try:
        child = subprocess.Popen(
            ['/proc/self/fd/9', 'serve', '--stdio', f'--hostname={host}', f'--port={port}'],
            cwd=cwd, stdin=subprocess.PIPE, env=env, pass_fds=(9,), start_new_session=True,
        )
    except OSError:
        receipt('rejected')
        return
    os.close(9)
    try:
        expires = time.monotonic() + 3
        while True:
            code = child.poll()
            if code is not None:
                receipt(f'exit {code}')
                return
            now = time.monotonic()
            if now >= expires:
                break
            command = control(min(.05, expires - now))
            if command == b'H':
                expires = time.monotonic() + 3
            elif command is not None:
                # EOF or an unexpected byte ends this lease.
                break
    finally:
        if child.returncode is None:
            try:
                child.stdin.close()
            except OSError:
                pass
            try:
                receipt(f'exit {child.wait(timeout=.5)}')
            except subprocess.TimeoutExpired:
                # The unreaped process still holds its PID, so its isolated
                # group cannot have been recycled between poll and killpg.
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=.5)
                receipt('reaped')


# An sshd hangup cannot bypass the bounded stdin/heartbeat watchdog. SIGKILL or
# other external interference can still prevent a receipt; the owner fences it.
signal.signal(signal.SIGHUP, signal.SIG_IGN)
serve()
