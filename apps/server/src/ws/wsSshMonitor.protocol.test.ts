import { Effect, Queue } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  forgetSshMonitorTarget,
  forgetSshMonitorInstance,
  isHealthySshMonitorTarget,
  recordVerifiedSshMonitorTarget,
  sshMonitorCallerId,
  sshMonitorLease,
} from "../ssh/sshMonitor.connections.ts";
import { bridgeSshMonitorDisconnects } from "./wsSshMonitor.protocol.ts";

const target = "ssh:host=lifecycle&auth=ssh-key";
const otherTarget = "ssh:host=other&auth=ssh-key";

afterEach(() => {
  forgetSshMonitorTarget(target);
  forgetSshMonitorTarget(otherTarget);
});

it("releases only the closing socket lease, forwards close to RPC, and preserves a reconnect", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* Queue.unbounded<number>();
        const forwarded = yield* bridgeSshMonitorDisconnects(source, "server-one");
        const first = sshMonitorCallerId("server-one", 1)!;
        const second = sshMonitorCallerId("server-one", 2)!;
        const reconnect = sshMonitorCallerId("server-one", 3)!;
        const otherServer = sshMonitorCallerId("server-two", 1)!;
        recordVerifiedSshMonitorTarget(target, first);
        recordVerifiedSshMonitorTarget(target, second);
        recordVerifiedSshMonitorTarget(target, otherServer);
        recordVerifiedSshMonitorTarget(otherTarget, first);
        const survivingLease = sshMonitorLease(target, second)!;
        yield* Queue.offer(source, 1);
        expect(yield* Queue.take(forwarded)).toBe(1);
        expect(sshMonitorLease(target, first)).toBeNull();
        expect(sshMonitorLease(otherTarget, first)).toBeNull();
        expect(sshMonitorLease(target, second)).toBe(survivingLease);
        expect(isHealthySshMonitorTarget(target, second, survivingLease)).toBe(true);

        recordVerifiedSshMonitorTarget(target, reconnect);
        const newLease = sshMonitorLease(target, reconnect);
        yield* Queue.offer(source, 1); // A delayed duplicate close is harmless.
        expect(yield* Queue.take(forwarded)).toBe(1);
        expect(sshMonitorLease(target, reconnect)).toBe(newLease);
        expect(sshMonitorLease(target, otherServer)).not.toBeNull();
        yield* Queue.offer(source, 2);
        expect(yield* Queue.take(forwarded)).toBe(2);
        expect(sshMonitorLease(target, second)).toBeNull();
        expect(sshMonitorLease(target, reconnect)).toBe(newLease);
        forgetSshMonitorInstance("server-one");
        expect(sshMonitorLease(target, reconnect)).toBeNull();
        expect(sshMonitorLease(target, otherServer)).not.toBeNull();
      }),
    ),
  );
});
