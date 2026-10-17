import { mkdtemp, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import {
  assertWorkspaceAgentArtifactTarget,
  findWorkspaceAgentTarget,
} from "../../../../../../scripts/lib/workspace-agent-target.ts";
import { resolveLocalWorkspaceWatchAgentBinary } from "../../../remote-agent/localWorkspaceWatchAgent.binary.ts";
import { V2WindowsInspector } from "./SharedService.windows.ts";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";

it.skipIf(process.platform !== "win32")(
  "resolves and handshakes a real packaged native Windows helper from a path with spaces",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2 packaged helper "));
    const target = findWorkspaceAgentTarget(process.platform, process.arch)!;
    const directory = path.join(root, "workspace-agent", `win32-${process.arch}`);
    const binary = path.join(directory, "bigbud-remote-agent.exe");
    const inspector = new V2WindowsInspector(() =>
      resolveLocalWorkspaceWatchAgentBinary({
        environment: { BIGBUD_DESKTOP_PACKAGED: "1" },
        packageRoot: root,
        searchFrom: [],
      }),
    );
    try {
      await mkdir(directory, { recursive: true });
      await copyFile(resolveLocalWorkspaceWatchAgentBinary(), binary);
      assertWorkspaceAgentArtifactTarget(binary, target);
      const fixture = path.join(root, "private.json");
      await writeFile(fixture, "fixture");
      await ownV2WindowsFixture(root);
      expect(await inspector.request(`READ\t${Buffer.from(fixture).toString("hex")}`)).toEqual([
        Buffer.from("fixture").toString("hex"),
      ]);
    } finally {
      inspector.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

it("distinguishes Windows ARM64 and x64 PE artifacts used by the read-only helper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-pe-"));
  try {
    const file = path.join(root, "helper.exe");
    const bytes = Buffer.alloc(256);
    bytes.write("MZ");
    bytes.writeUInt32LE(128, 0x3c);
    bytes.write("PE\0\0", 128);
    bytes.writeUInt16LE(0xaa64, 132);
    await writeFile(file, bytes);
    expect(() =>
      assertWorkspaceAgentArtifactTarget(file, findWorkspaceAgentTarget("win32", "arm64")!),
    ).not.toThrow();
    expect(() =>
      assertWorkspaceAgentArtifactTarget(file, findWorkspaceAgentTarget("win32", "x64")!),
    ).toThrow("mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
