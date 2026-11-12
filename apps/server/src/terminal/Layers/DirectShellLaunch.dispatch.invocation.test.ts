import { expect, it, vi } from "vitest";
import {
  deferred,
  fixture,
  ownerKey,
  pane,
  request,
} from "./DirectShellLaunch.dispatch.test.helpers";

it("dispatches exact stored SSH account, port, cwd, executable and argv with honest metadata", async () => {
  const f = fixture();
  const input = request();
  const result = await f.controller()(input);
  const plan = f.transport.mock.calls[0]![0];
  expect(plan.transport).toBe("ssh");
  expect(plan.launch).toEqual(f.entries.get(ownerKey)!.intent.launch);
  expect(plan.invocation.command).toBe("ssh");
  expect(plan.invocation.args.slice(0, -1)).toEqual([
    "-tt",
    "-o",
    "BatchMode=yes",
    "-p",
    "2222",
    "tester@example.test",
  ]);
  const command = plan.invocation.args.at(-1)!;
  expect(command).toMatch(/^'\/bin\/sh' '-c' /);
  expect(command).toContain('test "$(/usr/bin/id -un)" = "$1" || exit 79');
  expect(command).toContain('shift; cd "$1" 2>/dev/null || exit 77; shift; exec "$@"');
  expect(
    command.endsWith(
      "'sh' 'tester' '/srv/project with '\\''quotes'\\''' '/usr/bin/zsh' '-o' 'nopromptsp' 'argument with '\\''quotes'\\''' ''",
    ),
  ).toBe(true);
  expect(result).toMatchObject({
    action: "dispatched",
    owner: { state: "may-have-been-sent", intent: input.intent },
    shellUnconfirmedLaunch: {
      status: "unconfirmed",
      requestedProfile: input.intent.launch.requestedProfile,
    },
  });
  for (const value of [result, plan]) {
    expect(value).not.toHaveProperty("shellLaunchIdentity");
    expect(value).not.toHaveProperty("actualIdentity");
    expect(value).not.toHaveProperty("launchStatus", "confirmed");
  }
  expect(plan.launch).not.toHaveProperty("identity");
});

it("dispatches pinned WSL distribution/account/UID with exact stored argv and cwd", async () => {
  const f = fixture();
  const input = request(true);
  await f.controller()(input);
  const plan = f.transport.mock.calls[0]![0];
  expect(plan.transport).toBe("wsl");
  expect(plan.invocation.command).toMatch(/System32[\\/]wsl\.exe$/);
  expect(plan.invocation.args.slice(0, 5)).toEqual([
    "--distribution",
    "Ubuntu",
    "--user",
    "tester",
    "--exec",
  ]);
  const suffix = [
    "sh",
    "tester",
    "1000",
    input.intent.launch.cwd,
    input.intent.launch.executable,
    ...input.intent.launch.args,
  ];
  expect(plan.invocation.args.slice(-suffix.length)).toEqual(suffix);
  expect(plan.invocation.args.at(-suffix.length - 1)).toContain('test "$(/usr/bin/id -u)" = "$2"');
  expect(plan.launch).toEqual(input.intent.launch);
  if (plan.transport !== "wsl") throw new Error("Expected WSL plan");
  expect(plan.wslIdentity).toEqual(input.intent.wslIdentity);
  expect(plan.wslIdentity).not.toBe(input.intent.wslIdentity);
  expect(plan.invocation.args).not.toContain("-lc");
});

it("only forwards copied terminal/locale overrides, never desktop environment or secrets", async () => {
  const f = fixture();
  await f.controller()({
    ...request(),
    runtimeEnv: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_TIME: "C",
      HOME: "/desktop",
      PATH: "/desktop/bin",
      SHELL: "/desktop/shell",
      SECRET: "private-value",
      LC_bad: "bad-locale-name",
    },
  });
  const text = JSON.stringify(f.transport.mock.calls[0]![0]);
  for (const value of ["TERM=xterm-256color", "LANG=en_US.UTF-8", "LC_TIME=C"])
    expect(text).toContain(value);
  for (const value of ["/desktop", "private-value", "bad-locale-name"])
    expect(text).not.toContain(value);
});

it("detaches canonical stored intent from reserve responses before claim awaits", async () => {
  const f = fixture();
  const reserve = vi.mocked(f.store.reserve).getMockImplementation()!;
  let response: Awaited<ReturnType<typeof reserve>> | undefined;
  vi.mocked(f.store.reserve).mockImplementation(async (owner) => {
    response = await reserve(owner);
    return response;
  });
  const gate = deferred();
  const entered = deferred();
  const claim = vi.mocked(f.store.claimDispatch).getMockImplementation()!;
  vi.mocked(f.store.claimDispatch).mockImplementation(async (...args) => {
    entered.release();
    await gate.promise;
    return claim(...args);
  });
  const pending = f.controller()(request());
  await entered.promise;
  (response!.owner.intent.launch.args as string[]).push("response-mutated");
  Object.assign(response!.owner.intent.launch, { cwd: "/response-mutated" });
  gate.release();
  const output = await pending;
  expect(output).toMatchObject({ owner: { intent: request().intent } });
  expect(f.transport.mock.calls[0]![0].launch).toEqual(f.entries.get(ownerKey)!.intent.launch);
  expect(JSON.stringify(output)).not.toContain("response-mutated");
});

it("never converts transport completion or recovery into confirmed identity or owner release", async () => {
  const f = fixture();
  const dispatch = f.controller();
  const sent = await dispatch(request());
  const recovered = await dispatch({ ...pane, recoverOnly: true });
  expect(recovered).toMatchObject({
    action: "retained",
    shellUnconfirmedLaunch: { status: "unconfirmed" },
  });
  expect(sent).toMatchObject({ shellUnconfirmedLaunch: { status: "unconfirmed" } });
  expect(f.entries.get(ownerKey)?.state).toBe("may-have-been-sent");
  expect(f.store.cancelPrepared).not.toHaveBeenCalled();
  expect(f.transport).toHaveBeenCalledTimes(1);
});
