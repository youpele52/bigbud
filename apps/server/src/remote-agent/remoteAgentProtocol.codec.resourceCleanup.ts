import {
  type RemoteAgentResourceCleanupEntryType,
  type RemoteAgentResourceCleanupFrame,
  type RemoteAgentResourceCleanupIdentity,
  type RemoteAgentResourceCleanupOutcome,
} from "./remoteAgentProtocol.resourceCleanup.ts";
import { RemoteAgentProtocolDecodeError } from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

const entryTypes: Record<RemoteAgentResourceCleanupEntryType, number> = { file: 1, directory: 2 };
const outcomes: ReadonlyArray<RemoteAgentResourceCleanupOutcome | undefined> = [
  undefined,
  "removed",
  "already_absent",
  "resumed_and_removed",
  "identity_mismatch",
  "unsupported_entry",
  "busy",
  "permission_denied",
  "deadline_exceeded",
  "io_failure",
  "process_failure",
  "protocol_failure",
];

function identity(value: RemoteAgentResourceCleanupIdentity): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.deviceOrVolume);
  writer.fieldString(2, value.inodeOrFileId);
  writer.fieldUint(3, entryTypes[value.entryType]);
  return writer.finish();
}

function encode(frame: RemoteAgentResourceCleanupFrame): Uint8Array {
  const writer = new WireWriter();
  if (frame.type === "resourceCleanupRootBootstrapRequest") {
    writer.fieldString(1, frame.value.requestId);
    writer.fieldString(2, frame.value.platform);
    for (const root of frame.value.roots) {
      const nested = new WireWriter();
      nested.fieldString(1, root.rootId);
      nested.fieldString(2, root.path);
      nested.fieldBytes(3, identity(root.identity));
      writer.fieldBytes(3, nested.finish());
    }
  } else if (frame.type === "resourceCleanupRootBootstrapResponse") {
    writer.fieldString(1, frame.value.requestId);
    writer.fieldBool(2, frame.value.accepted);
    writer.fieldString(3, frame.value.errorCode);
    for (const root of frame.value.roots) {
      const nested = new WireWriter();
      nested.fieldString(1, root.rootId);
      nested.fieldString(2, root.rootHandle);
      writer.fieldBytes(4, nested.finish());
    }
  } else if (frame.type === "resourceCleanupRequest") {
    writer.fieldString(1, frame.value.requestId);
    writer.fieldString(2, frame.value.operationId);
    writer.fieldBytes(3, frame.value.pageDigest);
    writer.fieldUint(4, frame.value.deadlineUnixMs);
    writer.fieldString(5, frame.value.platform);
    for (const resource of frame.value.resources) {
      const nested = new WireWriter();
      nested.fieldString(1, resource.resourceId);
      nested.fieldString(2, resource.rootHandle);
      nested.fieldString(3, resource.relativePath);
      nested.fieldString(4, resource.quarantineName);
      if (resource.identity) nested.fieldBytes(5, identity(resource.identity));
      nested.fieldBytes(6, identity(resource.rootIdentity));
      nested.fieldBytes(7, identity(resource.parentIdentity));
      nested.fieldUint(8, 1);
      writer.fieldBytes(6, nested.finish());
    }
    writer.fieldBytes(7, frame.value.planDigest);
    writer.fieldBytes(8, frame.value.finalizeProofDigest);
    writer.fieldBytes(9, frame.value.authorizationDigest);
  } else if (frame.type === "resourceCleanupResponse") {
    writer.fieldString(1, frame.value.requestId);
    writer.fieldString(2, frame.value.operationId);
    for (const result of frame.value.results) {
      const nested = new WireWriter();
      nested.fieldString(1, result.resourceId);
      nested.fieldUint(2, outcomes.indexOf(result.outcome));
      nested.fieldString(3, result.errorCode);
      writer.fieldBytes(3, nested.finish());
    }
  } else if (
    frame.type === "resourceCleanupKeepAliveRequest" ||
    frame.type === "resourceCleanupKeepAliveResponse"
  ) {
    writer.fieldString(1, frame.value.requestId);
  } else {
    writer.fieldString(1, frame.value.requestId);
    writer.fieldString(2, frame.value.operationId);
    if (frame.type === "resourceCleanupCancelResponse") {
      writer.fieldBool(3, frame.value.cancellationRequested);
      writer.fieldBool(4, frame.value.terminal);
    }
  }
  return writer.finish();
}

export function encodeResourceCleanupFrame(frame: RemoteAgentResourceCleanupFrame): {
  readonly field: number;
  readonly value: Uint8Array;
} {
  const fields = {
    resourceCleanupRootBootstrapRequest: 100,
    resourceCleanupRootBootstrapResponse: 101,
    resourceCleanupRequest: 102,
    resourceCleanupResponse: 103,
    resourceCleanupKeepAliveRequest: 104,
    resourceCleanupKeepAliveResponse: 105,
    resourceCleanupCancelRequest: 106,
    resourceCleanupCancelResponse: 107,
  } as const;
  return { field: fields[frame.type], value: encode(frame) };
}

export function decodeResourceCleanupFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentResourceCleanupFrame | undefined {
  if (field < 100 || field > 107) return undefined;
  const base = { requestId: "" };
  if (field === 101) {
    const value = {
      ...base,
      accepted: false,
      errorCode: "",
      roots: [] as Array<{ rootId: string; rootHandle: string }>,
    };
    decodeMessage(bytes, (tag, wire, reader) => {
      if (tag === 1) {
        requireWireType(wire, 2);
        value.requestId = reader.string();
      } else if (tag === 2) {
        requireWireType(wire, 0);
        value.accepted = reader.uint() !== 0;
      } else if (tag === 3) {
        requireWireType(wire, 2);
        value.errorCode = reader.string();
      } else if (tag === 4) {
        requireWireType(wire, 2);
        const root = { rootId: "", rootHandle: "" };
        decodeMessage(reader.bytesValue(), (f, w, r) => {
          requireWireType(w, 2);
          if (f === 1) root.rootId = r.string();
          else if (f === 2) root.rootHandle = r.string();
          else r.skip(w);
        });
        value.roots.push(root);
      } else reader.skip(wire);
    });
    return { type: "resourceCleanupRootBootstrapResponse", value };
  }
  if (field === 103) {
    const value = {
      ...base,
      operationId: "",
      results: [] as Array<{
        resourceId: string;
        outcome: RemoteAgentResourceCleanupOutcome;
        errorCode: string;
      }>,
    };
    decodeMessage(bytes, (tag, wire, reader) => {
      if (tag === 1) {
        requireWireType(wire, 2);
        value.requestId = reader.string();
      } else if (tag === 2) {
        requireWireType(wire, 2);
        value.operationId = reader.string();
      } else if (tag === 3) {
        requireWireType(wire, 2);
        const result = {
          resourceId: "",
          outcome: undefined as RemoteAgentResourceCleanupOutcome | undefined,
          errorCode: "",
        };
        decodeMessage(reader.bytesValue(), (f, w, r) => {
          if (f === 1) {
            requireWireType(w, 2);
            result.resourceId = r.string();
          } else if (f === 2) {
            requireWireType(w, 0);
            const outcome = outcomes[r.uint()];
            if (!outcome) {
              throw new RemoteAgentProtocolDecodeError("Unknown resource cleanup outcome.");
            }
            result.outcome = outcome;
          } else if (f === 3) {
            requireWireType(w, 2);
            result.errorCode = r.string();
          } else r.skip(w);
        });
        if (!result.outcome) {
          throw new RemoteAgentProtocolDecodeError("Resource cleanup outcome is missing.");
        }
        value.results.push({ ...result, outcome: result.outcome });
      } else reader.skip(wire);
    });
    return { type: "resourceCleanupResponse", value };
  }
  if (field === 105) {
    const value = { ...base };
    decodeMessage(bytes, (tag, wire, reader) => {
      if (tag === 1) {
        requireWireType(wire, 2);
        value.requestId = reader.string();
      } else reader.skip(wire);
    });
    return { type: "resourceCleanupKeepAliveResponse", value };
  }
  if (field === 107) {
    const value = {
      ...base,
      operationId: "",
      cancellationRequested: false,
      terminal: false,
    };
    decodeMessage(bytes, (tag, wire, reader) => {
      if (tag === 1) {
        requireWireType(wire, 2);
        value.requestId = reader.string();
      } else if (tag === 2) {
        requireWireType(wire, 2);
        value.operationId = reader.string();
      } else if (tag === 3) {
        requireWireType(wire, 0);
        value.cancellationRequested = reader.uint() !== 0;
      } else if (tag === 4) {
        requireWireType(wire, 0);
        value.terminal = reader.uint() !== 0;
      } else reader.skip(wire);
    });
    return { type: "resourceCleanupCancelResponse", value };
  }
  return undefined;
}
