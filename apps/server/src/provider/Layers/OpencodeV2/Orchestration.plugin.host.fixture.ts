import type { V2ThreadOwner } from "./Orchestration.protocol.ts";
import { v2OwnerRegistration } from "./Orchestration.registration.ts";
import { v2NativeRegistrationMetadata } from "./Runtime.registration.ts";

interface Context {
  sessionID: string;
  messageID: string;
  id: string;
  agent: string;
  signal: AbortSignal;
}
export interface FixtureTool {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: Context) => Promise<{ content: string }>;
}
interface HookEvent {
  sessionID: string;
  tools: Record<string, { description: string; input: unknown }>;
}
type Handler = (
  input: unknown,
  context: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

/** Structurally matches public Promise hooks/editors; actual native conformance is tested separately. */
export function makeV2ThreadPluginHost(owner: V2ThreadOwner) {
  const tools = new Map<string, FixtureTool>();
  const hooks = new Map<string, (event: HookEvent) => Promise<void>>();
  let handlers: Record<string, Handler> = {};
  const context = {
    app: { version: "2.0.26" },
    location: { directory: owner.directory },
    tool: {
      list: async () =>
        [...tools].map(([id, tool]) => ({
          id,
          name: tool.name,
          description: tool.description,
          input: tool.input,
          execute: tool.execute,
        })),
      async transform(
        callback: (editor: {
          get: (id: string) => FixtureTool | undefined;
          add: (tool: FixtureTool) => void;
        }) => void,
      ) {
        const added: FixtureTool[] = [];
        callback({
          get: (id) => tools.get(id),
          add: (tool) => {
            added.push(tool);
            tools.set(tool.name, tool);
          },
        });
        return {
          dispose: async () => {
            for (const tool of added) if (tools.get(tool.name) === tool) tools.delete(tool.name);
          },
        };
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        if (sessionID !== owner.nativeSessionId) throw new Error("Fixture native session missing");
        return {
          id: sessionID,
          location: { directory: owner.directory },
          metadata: {
            bigbud_provider: "opencodeV2",
            bigbud_thread: owner.threadId,
            bigbud_storage: owner.storageIdentity,
            ...v2NativeRegistrationMetadata({
              registrationFamily: v2OwnerRegistration(owner).family,
              profileIssuer: owner.issuer,
            }),
          },
        };
      },
      async hook(name: string, callback: (event: HookEvent) => Promise<void>) {
        hooks.set(name, callback);
        return {
          dispose: async () => {
            hooks.delete(name);
          },
        };
      },
    },
    rpc: {
      async register(_definition: unknown, incoming: Record<string, Handler>) {
        handlers = incoming;
        return {
          dispose: async () => {
            handlers = {};
          },
        };
      },
    },
  };
  return {
    context,
    tools,
    async call(method: string, input: unknown = {}) {
      return handlers[method]!(input, { signal: new AbortController().signal });
    },
    async request(sessionID: string, kind = "context") {
      const event: HookEvent = {
        sessionID,
        tools: Object.fromEntries(
          [...tools].map(([name, tool]) => [
            name,
            { description: tool.description, input: tool.input },
          ]),
        ),
      };
      await hooks.get(kind)!(event);
      return event;
    },
  };
}
