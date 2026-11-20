import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { decodeInspectionHex } from "./localNativeInspection.ts";
import { readWindowsControlIdentity } from "./remoteAgentLocalControl.windows.identity.ts";
import { WindowsControlProcess } from "./remoteAgentLocalControl.windows.process.ts";
import {
  parseRemoteAgentControlRequest,
  REMOTE_AGENT_CONTROL_MAX_CLIENTS,
  REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES,
  type RemoteAgentControlRequest,
  type RemoteAgentControlResponse,
} from "./remoteAgentLocalControl.protocol.ts";

const hex = (text: string) => Buffer.from(text).toString("hex");
const endpointPath = (socketPath: string) => join(dirname(socketPath), "remote-agent.pipe-v1");
export class WindowsControlUnavailableError extends Error {}
const unavailable = () => new Error("The bigbud native control channel is unavailable.");
function decodeBounded(value: string) {
  if (value.length >= REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES * 2) throw unavailable();
  return decodeInspectionHex(value);
}
export async function startWindowsControlServer(input: {
  socketPath: string;
  handle: (request: RemoteAgentControlRequest) => Promise<RemoteAgentControlResponse>;
}) {
  const owner = await readWindowsControlIdentity(input.socketPath, true);
  const process = await WindowsControlProcess.open("server");
  const pending = new Set<string>();
  let ready = false;
  let closed = false;
  const opening = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(unavailable());
      void process.close();
    }, 5000);
    process.listen(
      (frame) => {
        const fields = frame.split("\t");
        if (!ready) {
          if (frame !== "READY\t1") throw unavailable();
          ready = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        const [kind, id, bytes] = fields;
        if (!id || !/^[1-9][0-9]{0,19}$/.test(id)) throw unavailable();
        if (kind === "C" && fields.length === 2) return; // Closing transport does not cancel work.
        if (kind !== "R" || fields.length !== 3 || bytes === undefined || pending.has(id))
          throw unavailable();
        let request: ReturnType<typeof parseRemoteAgentControlRequest>;
        try {
          request = parseRemoteAgentControlRequest(JSON.parse(decodeBounded(bytes)));
        } catch {
          request = { error: "Request must be valid bounded JSON." };
        }
        const reply = (value: RemoteAgentControlResponse) => {
          if (closed) return;
          const encoded = JSON.stringify(value);
          if (Buffer.byteLength(encoded) >= REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES) {
            process.send(
              `S\t${id}\t${hex(JSON.stringify({ v: 1, ok: false, error: { code: "internal", message: "Reply exceeds the control limit." } }))}`,
            );
          } else process.send(`S\t${id}\t${hex(encoded)}`);
        };
        if ("error" in request) {
          reply({ v: 1, ok: false, error: { code: "invalid-request", message: request.error } });
          return;
        }
        if (pending.size >= REMOTE_AGENT_CONTROL_MAX_CLIENTS) {
          reply({
            v: 1,
            ok: false,
            error: { code: "busy", message: "Too many concurrent requests." },
          });
          return;
        }
        pending.add(id);
        // Keep accepted operations alive after connection loss; bound admission independently.
        void Promise.resolve()
          .then(() => input.handle(request))
          .then(reply, () =>
            reply({
              v: 1,
              ok: false,
              error: { code: "internal", message: "The request could not be completed." },
            }),
          )
          .finally(() => pending.delete(id));
      },
      () => {
        closed = true;
        clearTimeout(timer);
        reject(unavailable());
      },
    );
    const name = `\\\\.\\pipe\\bigbud-remote-agent-${randomBytes(16).toString("hex")}`;
    process.send(
      [
        "SERVER",
        "1",
        hex(name),
        hex(endpointPath(input.socketPath)),
        owner.backend,
        hex(owner.filename),
        owner.fingerprint,
      ].join("\t"),
    );
  });
  try {
    await opening;
  } catch (error) {
    await process.close();
    throw error;
  }
  return {
    close: async () => {
      closed = true;
      await process.close();
    },
  };
}

export async function sendWindowsControlRequest(
  socketPath: string,
  request: RemoteAgentControlRequest,
  timeoutMs: number,
): Promise<RemoteAgentControlResponse> {
  const body = JSON.stringify({ v: 1, ...request });
  if (Buffer.byteLength(body) >= REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES)
    throw new Error("Request is too large.");
  const { owner, process } = await (async () => {
    try {
      return {
        owner: await readWindowsControlIdentity(socketPath),
        process: await WindowsControlProcess.open("client"),
      };
    } catch (cause) {
      throw new WindowsControlUnavailableError(
        "The bigbud native control channel is unavailable.",
        { cause },
      );
    }
  })();
  try {
    return await new Promise<RemoteAgentControlResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(unavailable());
          void process.close();
        },
        Math.min(timeoutMs, 40_000),
      );
      process.listen(
        (line) => {
          const fields = line.split("\t");
          if (fields.length !== 2 || fields[0] !== "REPLY") throw unavailable();
          const response = JSON.parse(decodeBounded(fields[1]!)) as RemoteAgentControlResponse;
          if (response?.v !== 1 || typeof response.ok !== "boolean") throw unavailable();
          clearTimeout(timer);
          resolve(response);
        },
        () => {
          clearTimeout(timer);
          reject(unavailable());
        },
      );
      process.send(
        ["CLIENT", "1", hex(endpointPath(socketPath)), owner.backend, hex(body)].join("\t"),
      );
    });
  } finally {
    await process.close();
  }
}
