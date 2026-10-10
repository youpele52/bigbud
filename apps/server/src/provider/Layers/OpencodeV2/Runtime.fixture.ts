import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import type {
  ModelRef,
  ModelInfo,
  InstructionEntryInfo,
  SessionInfo,
  SessionMessageInfo,
  SessionInboxUser,
  FormDetail,
  PermissionRequest,
} from "@opencode/client";
import { Effect, Layer } from "effect";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { makeOwnedClient } from "./Client.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { FixtureEvents } from "./Test.fixtures.ts";

/** Real pinned Promise client against deterministic synthetic HTTP, backed by real SQLite. */
export class V2RuntimeHttpFixture {
  readonly sessions = new Map<string, SessionInfo>();
  readonly messages = new Map<string, SessionMessageInfo[]>();
  readonly inbox = new Map<string, SessionInboxUser[]>();
  readonly instructions = new Map<string, InstructionEntryInfo[]>();
  readonly forms = new Map<string, FormDetail[]>();
  readonly permissions = new Map<string, PermissionRequest[]>();
  /** Independent configured inventory; a saved session never makes an unavailable model selectable. */
  readonly models: ModelInfo[] = [
    { providerID: "synthetic-provider", id: "synthetic-model" },
    { providerID: "synthetic-provider", id: "second-model" },
    { providerID: "synthetic", id: "model" },
  ].map(({ providerID, id }) => ({
    providerID,
    id,
    modelID: id,
    name: id,
    enabled: true,
    status: "active" as const,
    variants: [{ id: "high" }, { id: "low" }, { id: "precise" }],
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    time: { released: 1 },
    cost: [],
    limit: { context: 1000, output: 100 },
  }));
  readonly calls: {
    method: string;
    pathname: string;
    search: string;
    body: Record<string, unknown>;
  }[] = [];
  readonly source = new FixtureEvents();
  readonly deaths = new Set<() => void>();
  running = true;
  loseAck = false;
  autoComplete = true;
  fail = false;
  hideAdmission = false;
  modelUnavailable = false;
  readonly modelHttpFailures = new Map<string, number>();
  failInterrupt = false;
  readonly client = makeOwnedClient({
    endpoint: "http://127.0.0.1:45991",
    password: "synthetic-only",
    fetch: Object.assign(
      async (request: Parameters<typeof fetch>[0], init?: RequestInit) =>
        this.fetch(String(request), init),
      { preconnect: () => {} },
    ) as typeof fetch,
  });

  constructor() {
    this.client.event.subscribe = (options) =>
      this.source.subscribe(options?.signal ?? new AbortController().signal);
  }

  private async fetch(url: string, init?: RequestInit) {
    const pathname = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const body: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    this.calls.push({ method, pathname, search: new URL(url).search, body });
    if (pathname.includes("experimental/mcp")) return new Response(null, { status: 204 });
    const parts = pathname.split("/");
    const sessionId = parts[parts.indexOf("session") + 1] ?? "";
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    if (pathname === "/api/permission/saved") return response({ data: [] });
    if (pathname === "/api/model") {
      const location = { directory: new URL(url).searchParams.get("location[directory]")! };
      const status = this.modelHttpFailures.get(location.directory);
      if (status !== undefined) return new Response(null, { status });
      return response({
        location,
        data: this.modelUnavailable ? [] : this.models,
      });
    }
    if (pathname.includes("/instructions/entries")) {
      const entries = this.instructions.get(sessionId) ?? [];
      if (method === "GET") return response({ data: entries });
      const key = decodeURIComponent(parts.at(-1)!);
      this.instructions.set(sessionId, [
        ...entries.filter((entry) => entry.key !== key),
        ...(method === "PUT" ? [{ key, value: body.value as InstructionEntryInfo["value"] }] : []),
      ]);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/api/session" && method === "GET")
      return response({ data: [...this.sessions.values()], cursor: {} });
    if (pathname === "/api/session" && method === "POST") {
      const native: SessionInfo = {
        id: String(body.id),
        projectID: "synthetic",
        location: body.location as SessionInfo["location"],
        model: body.model as NonNullable<SessionInfo["model"]>,
        metadata: body.metadata as NonNullable<SessionInfo["metadata"]>,
        permissions: body.permissions as NonNullable<SessionInfo["permissions"]>,
        time: { created: 1, updated: 1 },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      if (this.sessions.has(native.id)) throw new Error("Duplicate fixture creation.");
      this.sessions.set(native.id, native);
      this.messages.set(native.id, []);
      return response({ data: native });
    }
    if (pathname === "/api/session/active") return response({ data: {} });
    if (pathname.endsWith("/model") && method === "POST") {
      const native = this.sessions.get(sessionId)!;
      this.sessions.set(sessionId, { ...native, model: body.model as ModelRef });
      return new Response(null, { status: 204 });
    }
    if (pathname.endsWith("/prompt")) {
      const nativeId = String(body.id);
      const admitted: SessionInboxUser = {
        id: nativeId,
        sessionID: sessionId,
        type: "user",
        delivery: "queue",
        time: { created: 2 },
        payload: {
          text: String(body.text),
          metadata: body.metadata as NonNullable<SessionInboxUser["payload"]["metadata"]>,
        },
      };
      if (!this.hideAdmission) {
        this.inbox.set(sessionId, [admitted]);
        const messages = this.messages.get(sessionId)!;
        const files = await Promise.all(
          ((body.files ?? []) as { uri: string; name: string }[]).map(async (file) => ({
            data: file.uri.startsWith("file:")
              ? (await readFile(fileURLToPath(file.uri))).toString("base64")
              : file.uri.split(",")[1]!,
            mime: file.uri.startsWith("file:")
              ? "image/png"
              : file.uri.slice(5, file.uri.indexOf(";")),
            source: { type: "inline" as const },
            name: file.name,
          })),
        );
        messages.push({
          id: nativeId,
          type: "user",
          text: String(body.text),
          time: { created: 2 },
          ...(body.files
            ? {
                files,
              }
            : {}),
          ...(admitted.payload.metadata ? { metadata: admitted.payload.metadata } : {}),
        });
        if (this.autoComplete) this.complete(sessionId);
      }
      if (this.loseAck) throw new Error("synthetic lost acknowledgement");
      return response({ data: admitted });
    }
    if (pathname.endsWith("/message")) {
      const search = new URL(url).searchParams;
      const start = Number(search.get("cursor") ?? 0);
      const limit = Number(search.get("limit") ?? 100);
      const messages = this.messages.get(sessionId) ?? [];
      const data = messages.slice(start, start + limit);
      return response({
        data,
        cursor: start + data.length < messages.length ? { next: String(start + data.length) } : {},
      });
    }
    if (pathname.endsWith("/inbox")) return response({ data: this.inbox.get(sessionId) ?? [] });
    if (pathname.endsWith("/permission"))
      return response({ data: this.permissions.get(sessionId) ?? [] });
    if (pathname.includes("/permission/") && method === "GET")
      return response({
        data: this.permissions.get(sessionId)?.find((item) => item.id === pathname.split("/")[5]),
      });
    if (pathname.endsWith("/form"))
      return response({
        data: (this.forms.get(sessionId) ?? []).filter((form) => form.state.status === "pending"),
      });
    if (pathname.includes("/form/") && method === "GET")
      return response({
        data: this.forms.get(sessionId)?.find((item) => item.id === pathname.split("/")[5]),
      });
    if (pathname.includes("/form/") && method === "DELETE") {
      const form = this.forms.get(sessionId)?.find((item) => item.id === pathname.split("/")[5]);
      if (!form || form.state.status !== "pending") throw new Error("Form already settled.");
      form.state = { status: "cancelled" };
      return new Response(null, { status: 204 });
    }
    if (pathname.includes("/form/") && pathname.endsWith("/reply")) {
      const form = this.forms.get(sessionId)?.find((item) => item.id === pathname.split("/")[5]);
      if (!form || form.state.status !== "pending") return response({ error: "settled" });
      form.state = {
        status: "answered",
        answer: body.answer as Extract<FormDetail["state"], { status: "answered" }>["answer"],
      };
      return new Response(null, { status: 204 });
    }
    if (pathname.endsWith("/interrupt")) {
      if (this.failInterrupt) throw new Error("Synthetic cleanup failure.");
      return response({ data: { interrupted: true } });
    }
    if (method === "PATCH" && this.sessions.has(sessionId)) {
      const native = this.sessions.get(sessionId)!;
      this.sessions.set(sessionId, {
        ...native,
        permissions: body.permissions as NonNullable<SessionInfo["permissions"]>,
      });
      return new Response(null, { status: 204 });
    }
    if (pathname.endsWith("/reply") || pathname.includes("/inbox/") || method === "PATCH")
      return new Response(null, { status: 204 });
    if (this.sessions.has(sessionId)) return response({ data: this.sessions.get(sessionId) });
    throw new Error(`Unexpected synthetic request ${method} ${pathname}`);
  }

  complete(sessionId: string, text = "authoritative full output") {
    const native = this.sessions.get(sessionId)!;
    this.messages.get(sessionId)!.push(
      {
        id: `msg_assistant_${this.messages.get(sessionId)!.length}`,
        type: "assistant",
        agent: "build",
        model: native.model!,
        time: { created: 3, completed: 4 },
        content: [{ type: "text", text }],
        finish: this.fail ? "error" : "stop",
        ...(this.fail ? { error: { type: "synthetic", message: "synthetic failure" } } : {}),
        cost: 0.001,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } },
      },
      {
        id: `msg_idle_${this.messages.get(sessionId)!.length}`,
        type: "idle",
        outcome: this.fail ? "failed" : "succeeded",
        time: { created: 5 },
      },
    );
    this.inbox.set(sessionId, []);
  }

  die() {
    this.running = false;
    for (const listener of this.deaths) listener();
  }
}

export async function withV2RuntimeFixture(
  run: (fixture: {
    runtime: OpencodeV2Runtime;
    http: V2RuntimeHttpFixture;
    directory: string;
    events: ProviderRuntimeEvent[];
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bigbud-v2-executing-fixture-"));
  const directory = path.join(root, "workspace");
  await mkdir(directory);
  const profile = path.join(root, "profile");
  await mkdir(profile, { mode: 0o700 });
  const http = new V2RuntimeHttpFixture();
  const events: ProviderRuntimeEvent[] = [];
  const manager = new OpencodeV2ServerManager({
    maxProcesses: 1,
    maxOwners: 25,
    maxQueuedEvents: 128,
    maxEventBytes: 100000,
    consumerTimeoutMs: 10000,
    start: async () => ({
      client: http.client,
      isRunning: () => http.running,
      hasExited: () => !http.running,
      onDeath: (listener) => {
        http.deaths.add(listener);
        return () => http.deaths.delete(listener);
      },
      close: async () => {
        http.die();
      },
    }),
  });
  const layer = ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* ProviderTurnAdmissions;
          const runtime = new OpencodeV2Runtime({
            manager,
            journal,
            config: {
              binaryPath: "/synthetic/opencode",
              profileRoot: profile,
              runtimeTargetId: "local",
            },
            emit: async (event) => {
              events.push(event);
            },
            pollIntervalMs: 100,
            allowLocalWorkspace: true,
          });
          try {
            yield* Effect.promise(() => run({ runtime, http, directory, events }));
          } finally {
            yield* Effect.promise(() => runtime.close());
          }
        }).pipe(Effect.provide(layer)),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
