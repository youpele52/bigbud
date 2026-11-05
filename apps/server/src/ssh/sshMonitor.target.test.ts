import { describe, expect, it } from "vitest";
import { validSshMonitorTarget } from "./sshMonitor.target.ts";

describe("SSH monitor argv validation", () => {
  it("rejects option-like destination, unsafe user and malformed ports before spawn", () => {
    for (const target of [
      "ssh:host=-oProxyCommand=bad",
      "ssh:host=demo&user=-oProxyCommand",
      "ssh:host=demo&port=-2",
      "ssh:host=demo&port=99999",
      "ssh:host=demo&port=22x",
      "ssh:host=demo%0Aevil",
      "ssh:host=demo&user=bad%0Auser",
    ])
      expect(validSshMonitorTarget(target)).toBe(false);
    expect(validSshMonitorTarget("ssh:host=demo&user=deploy&port=2222&auth=password")).toBe(true);
  });
});
