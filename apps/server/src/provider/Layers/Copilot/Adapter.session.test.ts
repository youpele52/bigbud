import { existsSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import type {
  CopilotClientOptions,
  CopilotSession,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CopilotAdapter } from "../../Services/Copilot/Adapter.ts";
import { makeCopilotAdapterLive } from "./Adapter.ts";

class FakeCopilotSession {
  constructor(
    public readonly sessionId: string,
    readonly config: SessionConfig | ResumeSessionConfig,
  ) {}

  on(_handler: (event: SessionEvent) => void): () => void {
    return () => undefined;
  }

  async send(): Promise<void> {}
  async setModel(): Promise<void> {}
  async abort(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

class FakeCopilotClient {
  public readonly createSessionCalls: SessionConfig[] = [];
  public readonly resumeSessionCalls: Array<{
    readonly sessionId: string;
    readonly config?: ResumeSessionConfig;
  }> = [];
  public stopped = false;

  async createSession(config: SessionConfig): Promise<CopilotSession> {
    this.createSessionCalls.push(config);
    return new FakeCopilotSession("copilot-session-1", config) as unknown as CopilotSession;
  }

  async resumeSession(sessionId: string, config?: ResumeSessionConfig): Promise<CopilotSession> {
    this.resumeSessionCalls.push(config ? { sessionId, config } : { sessionId });
    return new FakeCopilotSession(
      sessionId,
      config ?? ({ onPermissionRequest: async () => ({ kind: "reject" }) } satisfies SessionConfig),
    ) as unknown as CopilotSession;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

const THREAD_ID = ThreadId.makeUnsafe("thread-copilot-remote");

describe("CopilotAdapter remote workspace sessions", () => {
  it.effect("starts remote workspace sessions locally with a remote session-fs bridge", () => {
    const client = new FakeCopilotClient();
    let createdClientOptions: CopilotClientOptions | undefined;
    const layer = makeCopilotAdapterLive({
      clientFactory: (options: CopilotClientOptions) => {
        createdClientOptions = options;
        return client as unknown as import("@github/copilot-sdk").CopilotClient;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/copilot-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "copilot",
        executionTargetId: "ssh:host=devbox&user=root&port=22",
        cwd: "/srv/project",
        runtimeMode: "approval-required",
      });

      assert.equal(session.providerRuntimeExecutionTargetId, "local");
      assert.equal(session.workspaceExecutionTargetId, "ssh:host=devbox&user=root&port=22");
      assert.equal(session.cwd, "/srv/project");

      const createdConfig = client.createSessionCalls.at(-1);
      assert.equal(!!createdConfig, true);
      if (!createdConfig) {
        return;
      }

      assert.equal(createdConfig.workingDirectory, "/srv/project");
      assert.equal(createdConfig.excludedTools?.includes("read_bash"), true);
      assert.equal(createdConfig.systemMessage?.content?.includes("remote workspace mode"), true);
      assert.equal(createdConfig.systemMessage?.content?.includes("/srv/project"), true);
      assert.equal(
        createdConfig.tools?.some((tool) => tool.name === "bash"),
        true,
      );
      assert.equal(!!createdConfig.createSessionFsHandler, true);

      assert.equal(!!createdClientOptions?.sessionFs, true);
      assert.equal(createdClientOptions?.sessionFs?.initialCwd, "/srv/project");
      assert.equal(createdClientOptions?.sessionFs?.conventions, "posix");

      const syntheticCwd = createdClientOptions?.cwd;
      assert.equal(typeof syntheticCwd, "string");
      if (!syntheticCwd) {
        return;
      }

      assert.equal(existsSync(syntheticCwd), true);
      assert.equal(existsSync(path.join(syntheticCwd, ".bigbud/session-state")), true);

      yield* adapter.stopSession(THREAD_ID);
      assert.equal(client.stopped, true);
      assert.equal(existsSync(syntheticCwd), false);
    }).pipe(Effect.provide(layer));
  });
});
