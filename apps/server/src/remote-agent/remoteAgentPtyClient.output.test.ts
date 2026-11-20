import { expect, it, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";
import { RemoteAgentPtyOutput } from "./remoteAgentPtyClient.output";

it("coalesces noisy output to one pending acknowledgement and one latest sequence", async () => {
  const waiting: Array<() => void> = [];
  const request = vi.fn(
    (frame: RemoteAgentFrame) =>
      new Promise((resolve) => {
        waiting.push(() =>
          resolve({ type: "ptyOutputAckResponse", value: { ...frame.value, accepted: true } }),
        );
      }),
  );
  const persist = vi.fn(async () => {});
  const failed = vi.fn();
  const output = new RemoteAgentPtyOutput(
    "pty",
    () => ({ request }) as unknown as RemoteAgentConnection,
    persist,
    failed,
  );
  for (let i = 1; i <= 10_000; i++) output.acknowledge(i);
  expect(request).toHaveBeenCalledTimes(1);
  waiting.shift()?.();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]?.[0]).toMatchObject({ value: { acknowledgedSequence: 10_000 } });
  waiting.shift()?.();
  await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
  expect(failed).not.toHaveBeenCalled();
  output.stop();
  output.acknowledge(10_001);
  expect(request).toHaveBeenCalledTimes(2);
});

it("does not persist rejected acknowledgements or report cancellation as failure", async () => {
  const persist = vi.fn(async () => {});
  const failed = vi.fn();
  const connection = {
    request: vi.fn(async () => ({ type: "ptyOutputAckResponse", value: { accepted: false } })),
  };
  const output = new RemoteAgentPtyOutput(
    "pty",
    () => connection as unknown as RemoteAgentConnection,
    persist,
    failed,
  );
  output.acknowledge(1);
  await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
  expect(persist).not.toHaveBeenCalled();
  output.stop();
  output.acknowledge(2);
  expect(connection.request).toHaveBeenCalledTimes(1);
});
