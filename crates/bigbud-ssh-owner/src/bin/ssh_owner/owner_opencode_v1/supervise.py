# Fixed Linux proof supervisor, invoked with -I and a clean environment.
# The authenticated receipt proves wait() for the fixture server itself; it
# does not certify containment of arbitrary descendants or a hostile SSH host.
import os
import select
import signal
import subprocess
import sys
import tempfile
import time

root, nonce, host, port, *rest = sys.argv[1:]
mode = rest[0] if rest else 'fixture'
fixture = mode == 'fixture'


def receipt(text):
    print(f"\nbigbud-opencode-v1 {nonce} {text}", file=sys.stderr, flush=True)


def control(timeout):
    readable, _, _ = select.select([0], [], [], timeout)
    return os.read(0, 1) if readable else None


def serve():
    env = {
        'PATH': '/usr/bin:/bin',
        'LC_ALL': 'C',
        'OPENCODE_DISABLE_PROJECT_CONFIG': 'true',
        'OPENCODE_DISABLE_DEFAULT_PLUGINS': 'true',
        'OPENCODE_DISABLE_AUTOUPDATE': 'true',
        'OPENCODE_DISABLE_LSP_DOWNLOAD': 'true',
        'OPENCODE_DISABLE_MODELS_FETCH': 'true',
    }
    if fixture:
        with os.scandir('.') as entries:
            if next(entries, None) is not None:
                return
        state = tempfile.mkdtemp(prefix='state-', dir=root)
        # State is retained inside the disposable fixture root for fixture teardown.
        env.update({
            'HOME': state,
            'XDG_CONFIG_HOME': state + '/config',
            'XDG_DATA_HOME': state + '/data',
            'XDG_STATE_HOME': state + '/state',
            'XDG_CACHE_HOME': state + '/cache',
        })
    else:
        # Product mode: the outer recipe supplies the account's real HOME, so the
        # provider keeps its normal credentials and configuration.
        env['HOME'] = os.environ.get('HOME', '')
        if not env['HOME']:
            receipt('rejected')
            return
    receipt('prepared')
    if control(8) != b'S':
        return
    try:
        child = subprocess.Popen(
            ['/proc/self/fd/9', 'serve', '--hostname', host, '--port', port],
            stdin=subprocess.DEVNULL, env=env, pass_fds=(9,), start_new_session=True,
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
                break
    finally:
        if child.returncode is None:
            # The unreaped process still holds its PID, so its isolated group
            # cannot have been recycled between poll and killpg.
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
