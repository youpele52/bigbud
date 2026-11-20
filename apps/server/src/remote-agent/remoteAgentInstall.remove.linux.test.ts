import { afterEach, describe, expect, it } from "vitest";

import {
  REMOTE_AGENT_BACKEND_RUNTIME_PROBE,
  parseRemoteAgentBackendRuntimeProbe,
} from "./remoteAgentInstall.remove.blockers.ts";
import {
  buildRemoteAgentRemovalCommand,
  parseRemoteAgentRemovalCommandResult,
} from "./remoteAgentInstall.remove.deletion.ts";
import { buildRemoteAgentSocketLivenessCheck } from "./remoteAgentInstall.remove.supervisors.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

const HOME = "/tmp/remove-home";
const ROOT = `${HOME}/.bigbud/agent`;
const FENCE = "11111111-2222-4333-8444-555555555555";
const asHome = (command: string, path = "") =>
  `HOME=${HOME} ${path ? `PATH=${path}:$PATH ` : ""}sh -c '${command.replaceAll("'", "'\\''")}'`;

describe.runIf(linuxControlAvailable)("remote agent removal on a real filesystem", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());

  async function setup() {
    fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
    await fixture.run(`rm -rf ${HOME} /tmp/outside /tmp/fakebin; umask 077
mkdir -p ${ROOT}/bin/0.4.0/abc ${ROOT}/state ${ROOT}/staging ${ROOT}/inbox ${ROOT}/control-v1 ${ROOT}/runtimes/g1
printf agent > ${ROOT}/bin/0.4.0/abc/bigbud-remote-agent
: > ${ROOT}/inbox/.claim.lock; : > ${ROOT}/control-v1/registry.lock
printf '{"removal":{"id":"${FENCE}","controllerId":"c1","startedAt":%s000}}' "$(date +%s)" > ${ROOT}/control-v1/registry.json
mkdir -p ${HOME}/.bigbud/backend-runtimes/r1 ${HOME}/.bigbud/graph ${HOME}/.bigbud/workspace-modes
printf keep > ${HOME}/.bigbud/backend-runtimes/r1/file
mkdir -p /tmp/outside; printf outside > /tmp/outside/external-agent
ln -s /tmp/outside ${ROOT}/bin/linked-dir; ln -s /tmp/outside/external-agent ${ROOT}/bin/current`);
  }

  const remove = async (path = "") =>
    parseRemoteAgentRemovalCommandResult(
      await fixture.run(
        asHome(buildRemoteAgentRemovalCommand(ROOT, { mode: "remove", fenceId: FENCE }), path),
      ),
    );
  const resume = async () =>
    parseRemoteAgentRemovalCommandResult(
      await fixture.run(asHome(buildRemoteAgentRemovalCommand(ROOT, { mode: "resume" }))),
    );
  const agentKept = async () =>
    (await fixture.run(`cat ${ROOT}/bin/0.4.0/abc/bigbud-remote-agent`)) === "agent";

  it("renames the tree away and deletes only it, never following symlinks", async () => {
    await setup();
    await fixture.run(`rm -rf ${ROOT}/inbox`); // The claim lock is created when missing.
    expect(await remove()).toEqual({ kind: "removed" });
    expect(
      await fixture.run(`test ! -e ${ROOT}; ls -A ${HOME}/.bigbud | grep -c agent-removing || true
cat ${HOME}/.bigbud/backend-runtimes/r1/file; cat /tmp/outside/external-agent`),
    ).toBe("0\nkeepoutside");
    expect(await remove()).toEqual({ kind: "removed" });
  });

  it("refuses without its own registry fence", async () => {
    await setup();
    await fixture.run(`printf '{}' > ${ROOT}/control-v1/registry.json`);
    expect(await remove()).toEqual({ kind: "refused", reason: "fence" });
    expect(await agentKept()).toBe(true);
  });

  it("refuses a fence that is stale by the host's clock", async () => {
    await setup();
    await fixture.run(
      `printf '{"removal":{"id":"${FENCE}","controllerId":"c1","startedAt":%s000}}' "$(( $(date +%s) - 3600 ))" > ${ROOT}/control-v1/registry.json`,
    );
    expect(await remove()).toEqual({ kind: "refused", reason: "fence" });
    expect(await agentKept()).toBe(true);
  });

  it("falls back to plain recursive delete where rm lacks --one-file-system (BusyBox)", async () => {
    await setup();
    // A wrapper that rejects the GNU-only flag, like BusyBox, and otherwise runs the real tool.
    const wrapper = [
      "#!/bin/sh",
      'for argument in "$@"; do',
      '  if [ "$argument" = --one-file-system ]; then echo "unrecognized option" >&2; exit 1; fi',
      "done",
      'exec /bin/rm "$@"',
    ].join("\n");
    await fixture.runInput("mkdir -p /tmp/fakebin && cat > /tmp/fakebin/rm", `${wrapper}\n`);
    await fixture.run("chmod 755 /tmp/fakebin/rm");
    expect(await remove("/tmp/fakebin")).toEqual({ kind: "removed" });
    expect(await fixture.run(`test ! -e ${ROOT} && printf gone`)).toBe("gone");
  });

  it("tells a live supervisor socket from a stale socket file", async () => {
    await setup();
    const socket = `${ROOT}/runtimes/g1/supervisor.sock`;
    const live = () =>
      fixture.run(
        `if ${buildRemoteAgentSocketLivenessCheck(socket)}; then printf live; else printf stale; fi`,
      );
    await fixture.run(
      `node -e "require('net').createServer().listen(process.argv[1])" ${socket} >/dev/null 2>&1 & echo $! > /tmp/listener.pid; n=0; while [ ! -S ${socket} ]; do n=$((n+1)); [ $n -lt 100 ] || exit 1; sleep 0.05; done`,
    );
    expect(await live()).toBe("live");
    // SIGKILL leaves the socket file behind with no listener.
    await fixture.run(`kill -9 "$(cat /tmp/listener.pid)"; sleep 0.2; test -S ${socket}`);
    expect(await live()).toBe("stale");
  });

  it("refuses foreign-owned entries and a symlinked root before deleting anything", async () => {
    await setup();
    await fixture.run(`chown 1234 ${ROOT}/staging`);
    expect(await remove()).toEqual({ kind: "refused", reason: "foreign-owner" });
    expect(await agentKept()).toBe(true);
    await fixture.run(
      `chown 0 ${ROOT}/staging; mv ${ROOT} ${HOME}/.bigbud/real-agent; ln -s ${HOME}/.bigbud/real-agent ${ROOT}`,
    );
    await expect(remove()).rejects.toThrow();
    expect(
      await fixture.run(`cat ${HOME}/.bigbud/real-agent/bin/0.4.0/abc/bigbud-remote-agent`),
    ).toBe("agent");
  });

  it("aborts instead of passing when find fails", async () => {
    await setup();
    await fixture.run(
      `mkdir -p /tmp/fakebin; printf '#!/bin/sh\\nexit 2\\n' > /tmp/fakebin/find; chmod 755 /tmp/fakebin/find`,
    );
    await expect(remove("/tmp/fakebin")).rejects.toThrow();
    expect(await agentKept()).toBe(true);
  });

  it("waits a bounded time for the install script's inbox lock, then reports busy", async () => {
    await setup();
    await fixture.run(
      `(flock -x 8; sleep 14) 8>${ROOT}/inbox/.claim.lock >/dev/null 2>&1 & sleep 0.3`,
    );
    expect(await remove()).toEqual({ kind: "busy", lock: "inbox" });
    expect(await agentKept()).toBe(true);
  }, 40_000);

  it("refuses while a socket is still listening under the tree", async () => {
    await setup();
    const socket = `${ROOT}/runtimes/g1/supervisor.sock`;
    await fixture.run(
      `(node -e "require('net').createServer().listen(process.argv[1])" ${socket} >/dev/null 2>&1 &) ; n=0; while [ ! -S ${socket} ]; do n=$((n+1)); [ $n -lt 100 ] || exit 1; sleep 0.05; done`,
    );
    expect(await remove()).toEqual({ kind: "busy", lock: "socket" });
    expect(await agentKept()).toBe(true);
  });

  it("resume deletes only leftovers of an interrupted removal", async () => {
    await setup();
    expect(await resume()).toEqual({ kind: "none" });
    await fixture.run(
      `umask 077; mkdir -p ${HOME}/.bigbud/.agent-removing.1.2/bin; printf x > ${HOME}/.bigbud/.agent-removing.1.2/bin/file`,
    );
    expect(await resume()).toEqual({ kind: "removed" });
    expect(await fixture.run(`test ! -e ${HOME}/.bigbud/.agent-removing.1.2 && printf gone`)).toBe(
      "gone",
    );
    expect(await agentKept()).toBe(true);
  });

  it("detects a remote backend runtime that depends on the agent", async () => {
    await setup();
    const probe = async () =>
      parseRemoteAgentBackendRuntimeProbe(
        await fixture.run(asHome(REMOTE_AGENT_BACKEND_RUNTIME_PROBE)),
      );
    expect(await probe()).toEqual([]);
    await fixture.run(
      `mkdir -p ${HOME}/.bigbud/backend-services/0123456789abcdef0123456789abcdef ${HOME}/.config/systemd/user; : > ${HOME}/.config/systemd/user/bigbud-rust-1.service`,
    );
    expect((await probe()).map((blocker) => blocker.label)).toEqual([
      "Remote backend service 0123456789abcdef0123456789abcdef",
      "Remote backend unit bigbud-rust-1.service",
    ]);
  });
});
