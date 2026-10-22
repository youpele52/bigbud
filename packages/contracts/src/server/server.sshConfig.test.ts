import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerListSshConfigHostsResult } from "./server.sshConfig";

describe("ServerListSshConfigHostsResult", () => {
  it("round-trips hosts with optional hints and per-file statuses", () => {
    const result = {
      machineName: "macbook",
      hosts: [
        {
          alias: "work-server",
          sourcePath: "~/.ssh/config",
          line: 12,
          hostName: "10.0.4.7",
          user: "deploy",
          port: "2222",
        },
        { alias: "gpu-box", sourcePath: "~/.ssh/config.d/lab", line: 3 },
      ],
      sources: [
        { path: "~/.ssh/config", kind: "user" as const, status: "loaded" as const },
        {
          path: "/etc/ssh/ssh_config",
          kind: "system" as const,
          status: "missing" as const,
        },
        {
          path: "~/.ssh/%h.conf",
          kind: "include" as const,
          status: "skipped" as const,
          message: "Includes with % tokens or environment variables are not listed.",
        },
      ],
    };

    const encoded = Schema.encodeUnknownSync(ServerListSshConfigHostsResult)(result);
    expect(Schema.decodeUnknownSync(ServerListSshConfigHostsResult)(encoded)).toEqual(result);
  });

  it("rejects an empty alias", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerListSshConfigHostsResult)({
        machineName: "macbook",
        hosts: [{ alias: " ", sourcePath: "~/.ssh/config", line: 1 }],
        sources: [],
      }),
    ).toThrow();
  });
});
