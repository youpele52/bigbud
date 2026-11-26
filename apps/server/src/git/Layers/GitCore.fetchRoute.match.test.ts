import { describe, expect, it } from "vitest";

import {
  classifyRemoteUrl,
  nonInteractiveSshCommand,
  remoteMatchesTarget,
  type RemoteRoute,
} from "./GitCore.fetchRoute.match.ts";

function ssh(url: string) {
  const route = classifyRemoteUrl(url);
  if (route.kind !== "ssh") throw new Error(`not ssh: ${url}`);
  return route as Extract<RemoteRoute, { kind: "ssh" }>;
}

describe("bigbud target matching (U14)", () => {
  const target = { hosts: ["vm.example", "10.0.0.5"], user: "dev", port: 2222 };

  it("matches only on a genuine host/user/port agreement", () => {
    expect(remoteMatchesTarget(ssh("ssh://dev@vm.example:2222/srv/r.git"), target)).toBe(true);
    expect(remoteMatchesTarget(ssh("ssh://dev@10.0.0.5:2222/srv/r.git"), target)).toBe(true);
    expect(remoteMatchesTarget(ssh("ssh://git@vm.example:2222/srv/r.git"), target)).toBe(false);
    expect(remoteMatchesTarget(ssh("ssh://dev@vm.example:22/srv/r.git"), target)).toBe(false);
    expect(remoteMatchesTarget(ssh("git@github.com:o/r.git"), target)).toBe(false);
  });

  it("treats an unstated user or port as unable to disprove the match", () => {
    expect(remoteMatchesTarget(ssh("vm.example:srv/r.git"), target)).toBe(true);
    expect(remoteMatchesTarget(ssh("dev@vm.example:srv/r.git"), target)).toBe(true);
    expect(remoteMatchesTarget(ssh("git@vm.example:r.git"), { hosts: ["vm.example"] })).toBe(true);
  });
});

describe("non-interactive user SSH command", () => {
  it("extends a plain ssh invocation", () => {
    expect(nonInteractiveSshCommand("ssh -i ~/.ssh/work -p 2200")).toBe(
      "ssh -i ~/.ssh/work -p 2200 -o BatchMode=yes",
    );
    expect(nonInteractiveSshCommand("/usr/bin/ssh -F /dev/null")).toBe(
      "/usr/bin/ssh -F /dev/null -o BatchMode=yes",
    );
  });

  it("leaves wrappers and shell syntax unchanged", () => {
    for (const command of ["my-ssh-wrapper", "ssh -i k; echo", 'ssh -o "X=1"', "ssh -- host"]) {
      expect(nonInteractiveSshCommand(command)).toBeUndefined();
    }
  });
});
