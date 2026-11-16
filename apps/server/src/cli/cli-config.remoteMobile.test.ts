import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Redacted } from "effect";
import { flagsFor, resolve } from "./cli-config.remote.test.helpers.ts";

it.layer(NodeServices.layer)("remote mobile CLI preflight", (it) => {
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "bb-rmobile-" });
    return { fs, base: path.join(root, "backend"), cwd: path.join(root, "workspace") };
  });
  it.effect("rejects missing/reused gateway credentials before directories or port probes", () =>
    Effect.gen(function* () {
      for (const secret of [undefined, "fixture-owner-secret", "bad\ncredential"]) {
        const f = yield* fixture;
        let probes = 0;
        const env = {
          BIGBUD_REMOTE_MOBILE_ENABLED: "true",
          ...(secret === undefined ? {} : { BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL: secret }),
        };
        const error = yield* resolve(
          { ...flagsFor(f.base, f.cwd), port: Option.none() },
          () => {
            probes++;
          },
          env,
        ).pipe(Effect.flip);
        expect(String(error)).toContain("separate gateway credential");
        if (secret) expect(String(error)).not.toContain(secret);
        expect(probes).toBe(0);
        expect(yield* f.fs.exists(f.base)).toBe(false);
        expect(yield* f.fs.exists(f.cwd)).toBe(false);
      }
    }),
  );
  it.effect("rejects the wrong explicit mode before reading a desktop descriptor", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const error = yield* resolve(
        {
          ...flagsFor(f.base, f.cwd),
          mode: Option.some("desktop"),
          bootstrapFd: Option.some(999999),
        },
        undefined,
        {
          BIGBUD_REMOTE_MOBILE_ENABLED: "true",
          BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL: "g".repeat(32),
        },
      ).pipe(Effect.flip);
      expect(String(error)).toContain("before desktop bootstrap");
      expect(yield* f.fs.exists(f.base)).toBe(false);
    }),
  );

  it.effect(
    "keeps remote mobile off by default and accepts only the explicit distinct configuration",
    () =>
      Effect.gen(function* () {
        const first = yield* fixture;
        const off = yield* resolve(flagsFor(first.base, first.cwd));
        expect(off.remoteMobile).toBeUndefined();
        const second = yield* fixture;
        const credential = "g".repeat(32);
        const on = yield* resolve(flagsFor(second.base, second.cwd), undefined, {
          BIGBUD_REMOTE_MOBILE_ENABLED: "true",
          BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL: credential,
        });
        expect(Redacted.value(on.remoteMobile!.gatewayCredential)).toBe(credential);
        expect(JSON.stringify(on.remoteMobile)).not.toContain(credential);
      }),
  );
});
