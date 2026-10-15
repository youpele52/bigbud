import { afterEach, describe, expect, it } from "vitest";

import { socketDiagnosticUrl } from "./wsConnectionDiagnostics";
import {
  getWsConnectionStatus,
  recordWsConnectionAttempt,
  resetWsConnectionStateForTests,
} from "./wsConnectionState";
import { buildConnectionDetails } from "../components/WebSocketConnectionSurface.blocking";

afterEach(() => resetWsConnectionStateForTests());

describe("connection diagnostics", () => {
  it("removes socket credentials, query secrets, arbitrary paths and fragments before retention", () => {
    const socket =
      "ws://user:private-password@localhost:3020/private-path?token=private-token#private-fragment";
    expect(socketDiagnosticUrl(socket)).toBe("ws://localhost:3020/ws");
    recordWsConnectionAttempt(socket);
    expect(getWsConnectionStatus().socketUrl).toBe("ws://localhost:3020/ws");
    expect(socketDiagnosticUrl("not-a-url private-token")).toBe("[invalid socket URL]");
  });

  it("never renders raw schema errors or server-supplied close reasons", () => {
    const details = buildConnectionDetails(
      {
        ...getWsConnectionStatus(),
        lastError: "SchemaError /private/provider/path value=private-key",
        closeReason: "credentials=private-credential",
        socketUrl: "ws://localhost/ws?token=private-token",
      },
      "error",
    );
    expect(details).not.toContain("private");
    expect(details).not.toContain("SchemaError");
    expect(details).toContain("lastError: WebSocket connection failed");
  });
});
