import { describe, expect, it } from "vitest";

import { buildCursorAcpSpawnInput } from "./CursorAcpSupport.ts";

describe("buildCursorAcpSpawnInput", () => {
  it("uses the agent binary and documented trust/acp arguments by default", () => {
    expect(buildCursorAcpSpawnInput(undefined, "/workspace/project")).toEqual({
      command: "agent",
      args: ["--trust", "acp"],
      cwd: "/workspace/project",
    });
  });

  it("uses a configured Cursor binary", () => {
    expect(
      buildCursorAcpSpawnInput(
        { binaryPath: "/opt/cursor-agent", apiEndpoint: "" },
        "/workspace/project",
      ),
    ).toEqual({
      command: "/opt/cursor-agent",
      args: ["--trust", "acp"],
      cwd: "/workspace/project",
    });
  });

  it("omits an empty endpoint", () => {
    expect(
      buildCursorAcpSpawnInput({ binaryPath: "agent", apiEndpoint: "   " }, "/workspace/project")
        .args,
    ).toEqual(["--trust", "acp"]);
  });

  it("places the endpoint and trust option before the acp subcommand", () => {
    expect(
      buildCursorAcpSpawnInput(
        { binaryPath: "agent-custom", apiEndpoint: "https://cursor.example.test" },
        "/workspace/project",
      ),
    ).toEqual({
      command: "agent-custom",
      args: ["-e", "https://cursor.example.test", "--trust", "acp"],
      cwd: "/workspace/project",
    });
  });
});
