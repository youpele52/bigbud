// Deterministic `/mobile-ws` stub: answers the recovery baseline and reports caught-up.
export async function installMobileWsStub(page, { snapshot, thread, serverConfig, onRequest }) {
  await page.routeWebSocket("**/mobile-ws?*", (ws) => {
    const exit = (request, value) =>
      ws.send(
        JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } }),
      );
    ws.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (request._tag !== "Request") return;
      onRequest?.(request.tag);
      if (request.tag === "subscribeServerConfig" && serverConfig) {
        ws.send(
          JSON.stringify({
            _tag: "Chunk",
            requestId: request.id,
            values: [{ version: 1, type: "snapshot", config: serverConfig }],
          }),
        );
      } else if (request.tag === "mobile.recovery.getBaseline") {
        const selected = request.payload.selectedThreadId;
        exit(request, {
          version: 1,
          recoveryAttemptId: request.payload.recoveryAttemptId,
          serverEpoch: "baseline-epoch",
          snapshotSequence: 0,
          snapshot,
          selectedThread: selected
            ? selected === thread.id
              ? { status: "present", thread }
              : { status: "missing" }
            : null,
        });
      } else if (request.tag === "mobile.recovery.subscribe") {
        ws.send(
          JSON.stringify({
            _tag: "Chunk",
            requestId: request.id,
            values: [
              {
                version: 1,
                route: "direct-unmanaged",
                serverEpoch: "baseline-epoch",
                recoveryAttemptId: request.payload.recoveryAttemptId,
                type: "caught-up",
                throughSequence: 0,
              },
            ],
          }),
        );
      }
    });
  });
}
