import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { WsConnectionDiagnosticsReport } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isOptionalWsRpcUnsupported,
  resetOptionalWsRpcSupportForTests,
} from "./protocol.optionalRpc";
import {
  attachWsConnectionDiagnosticsSender,
  attachWsConnectionDiagnosticsTransport,
  resetWsConnectionDiagnosticsReporterForTests,
  wsConnectionDiagnosticsLifecycle,
} from "./wsConnectionDiagnosticsReporter";
import { requestWsConnectionDiagnostics } from "./wsRpcClient.diagnostics";
import { WsTransport } from "./wsTransport";
import {
  MockWebSocket,
  createTransport,
  getSocket,
  registerTestHooks,
  waitFor,
} from "./wsTransport.test.helpers";

const sockets: MockWebSocket[] = [];
const transports: WsTransport[] = [];
registerTestHooks(sockets, transports);

afterEach(() => {
  resetWsConnectionDiagnosticsReporterForTests();
  resetOptionalWsRpcSupportForTests();
});

function requests(socket: MockWebSocket): Array<{ readonly id: string; readonly tag: string }> {
  return socket.sent
    .map((frame) => JSON.parse(frame))
    .filter((message) => message._tag === "Request");
}

function requestFor(socket: MockWebSocket, tag: string) {
  return requests(socket).find((request) => request.tag === tag);
}

/** What an older server's RpcServer sends for a tag it does not know: a connection-wide defect. */
function unknownTagDefect(socket: MockWebSocket, tag: string) {
  socket.serverMessage(JSON.stringify({ _tag: "Defect", defect: `Unknown request tag: ${tag}` }));
}

function answerPing(socket: MockWebSocket, requestId: string) {
  socket.serverMessage(
    JSON.stringify({
      _tag: "Exit",
      requestId,
      exit: { _tag: "Success", value: { serverTime: "2026-10-21T16:00:00.000Z" } },
    }),
  );
}

describe("optional diagnostics RPCs against an older server", () => {
  it("fails only the diagnostics request and never tears the session down", async () => {
    const protocolFailure = vi.fn();
    const transport = createTransport(transports, "ws://localhost:3020", {
      onProtocolFailure: protocolFailure,
    });
    const ping = transport.request((client) => client[WS_METHODS.serverPing]({}));
    const read = requestWsConnectionDiagnostics(transport, { limit: 10 });
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(requests(socket)).toHaveLength(2));

    unknownTagDefect(socket, WS_METHODS.serverGetWsConnectionDiagnostics);
    await expect(read).rejects.toThrow(/Unknown request tag/);
    // The unrelated request on the same socket still completes.
    answerPing(socket, requestFor(socket, WS_METHODS.serverPing)!.id);
    await expect(ping).resolves.toEqual({ serverTime: "2026-10-21T16:00:00.000Z" });
    expect(protocolFailure).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);

    // The settings poll stops asking a server that cannot answer.
    expect(isOptionalWsRpcUnsupported(WS_METHODS.serverGetWsConnectionDiagnostics)).toBe(true);
    const sentBefore = requests(socket).length;
    await expect(requestWsConnectionDiagnostics(transport, { limit: 10 })).rejects.toThrow(
      /Unknown request tag/,
    );
    expect(requests(socket)).toHaveLength(sentBefore);
  });

  it("keeps the reporter from ever causing a reconnect", async () => {
    const protocolFailure = vi.fn();
    const transport = createTransport(transports, "ws://localhost:3020", {
      ...wsConnectionDiagnosticsLifecycle,
      onProtocolFailure: protocolFailure,
    });
    attachWsConnectionDiagnosticsTransport(transport);
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    // The page-load connect report goes out on open.
    await waitFor(() =>
      expect(requestFor(socket, WS_METHODS.serverReportWsConnectionDiagnostics)).toBeDefined(),
    );
    unknownTagDefect(socket, WS_METHODS.serverReportWsConnectionDiagnostics);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(protocolFailure).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    expect(isOptionalWsRpcUnsupported(WS_METHODS.serverReportWsConnectionDiagnostics)).toBe(true);
  });

  it("still treats an unknown tag for a required RPC as a protocol failure", async () => {
    const protocolFailure = vi.fn();
    createTransport(transports, "ws://localhost:3020", { onProtocolFailure: protocolFailure });
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    unknownTagDefect(socket, WS_METHODS.serverPing);
    await waitFor(() => expect(protocolFailure).toHaveBeenCalledOnce());
  });
});

describe("reconnect-success attempt count", () => {
  it("reports the attempts it took, captured before the open reset the counter", async () => {
    const sent: WsConnectionDiagnosticsReport[] = [];
    createTransport(transports, "ws://localhost:3020", wsConnectionDiagnosticsLifecycle);
    attachWsConnectionDiagnosticsSender(async (report) => sent.push(report));
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    getSocket(sockets).close(1006, "dropped");
    // First retry fails, second opens.
    await waitFor(() => expect(sockets).toHaveLength(2), 3_000);
    getSocket(sockets).close(1006, "refused");
    await waitFor(() => expect(sockets).toHaveLength(3), 5_000);
    getSocket(sockets).open();

    await waitFor(() =>
      expect(sent.some((report) => report.trigger === "reconnect-success")).toBe(true),
    );
    expect(sent.find((report) => report.trigger === "connect")?.attempt).toBe(1);
    expect(sent.find((report) => report.trigger === "reconnect-success")?.attempt).toBe(2);
  });
});
