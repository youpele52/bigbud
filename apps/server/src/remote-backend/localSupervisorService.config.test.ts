import { serviceConfigFixture } from "./localSupervisorService.test.helpers.ts";
import { describe, expect, it } from "vitest";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import {
  decodeLocalSupervisorServiceConfig,
  encodeLocalSupervisorServiceConfig,
} from "./localSupervisorService.config.ts";
import { buildLocalSupervisorServiceProjection } from "./localSupervisorService.projection.ts";

describe("account-service private projection schema", () => {
  it("round-trips the complete strict projection without changing opaque artifact pins", () => {
    expect(
      decodeLocalSupervisorServiceConfig(encodeLocalSupervisorServiceConfig(serviceConfigFixture)),
    ).toEqual(serviceConfigFixture);
    expect(
      Object.isFrozen(
        decodeLocalSupervisorServiceConfig(
          encodeLocalSupervisorServiceConfig(serviceConfigFixture),
        ),
      ),
    ).toBe(true);
  });
  it.each([
    (text: string) => `${text}authority=${"a".repeat(32)}\n`,
    (text: string) => text.replace("version=1", "version=2"),
    (text: string) => text.replace("restart=no", "restart=maybe"),
    (text: string) => `${text}unknown=field\n`,
    (text: string) => text.replace("launch_attempt=original", "launch_attempt=bad\u0000"),
    (text: string) => text.replace("authority=" + "a".repeat(32), "authority=invalid"),
    (text: string) => text.replace("home=/home/service", "home="),
  ])(
    "rejects ambiguous or unsupported config instead of preserving unknown authority data",
    (corrupt) => {
      expect(() =>
        decodeLocalSupervisorServiceConfig(
          corrupt(encodeLocalSupervisorServiceConfig(serviceConfigFixture)),
        ),
      ).toThrow();
    },
  );
  it("refuses historical unbound service configs and malformed installation/reservation pins", () => {
    const current = encodeLocalSupervisorServiceConfig(serviceConfigFixture);
    const legacy = current
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("expected_installation_fingerprint=") &&
          !line.startsWith("authority_reservation_sha256="),
      )
      .join("\n");
    expect(() => decodeLocalSupervisorServiceConfig(legacy)).toThrow();
    expect(() =>
      decodeLocalSupervisorServiceConfig(
        current.replace(
          serviceConfigFixture.expected_installation_fingerprint,
          "invalid-installation",
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeLocalSupervisorServiceConfig(
        current.replace(serviceConfigFixture.authority_reservation_sha256, "invalid-reservation"),
      ),
    ).toThrow();
  });
  it("publishes only the authorized attempt/epoch/boot while preserving all artifact references", () => {
    const runtime: RemoteAgentRuntime = {
      generation: "g1",
      version: "0.3.3",
      buildDigest: "fixture",
      targetTriple: "aarch64-unknown-linux-musl",
      origin: "managed",
      socketPath: `${serviceConfigFixture.rust_state}/supervisor.sock`,
      logPath: `${serviceConfigFixture.rust_state}/supervisor.log`,
      binaryPath: serviceConfigFixture.rust_binary,
      sha256: serviceConfigFixture.rust_sha256,
      statePath: serviceConfigFixture.rust_state,
    };
    const projected = buildLocalSupervisorServiceProjection({
      runtime,
      configPath: "/private/config-v1",
      previousConfig: encodeLocalSupervisorServiceConfig(serviceConfigFixture),
      attemptId: "replacement",
      priorEpoch: "42",
      bootId: serviceConfigFixture.launch_boot,
    });
    expect(decodeLocalSupervisorServiceConfig(projected.stdin)).toEqual({
      ...serviceConfigFixture,
      launch_attempt: "replacement",
      prior_epoch: "42",
    });
    expect(() =>
      buildLocalSupervisorServiceProjection({
        runtime: { ...runtime, sha256: "f".repeat(64) },
        configPath: "/private/config-v1",
        previousConfig: encodeLocalSupervisorServiceConfig(serviceConfigFixture),
        attemptId: "replacement",
        priorEpoch: "42",
        bootId: serviceConfigFixture.launch_boot,
      }),
    ).toThrow("reserved managed runtime");
  });
});
