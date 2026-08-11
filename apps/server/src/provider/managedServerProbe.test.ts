import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { withManagedServerProbe } from "./managedServerProbe.ts";
import { OpencodeServerManager } from "./Services/Opencode/ServerManager.ts";

describe("withManagedServerProbe", () => {
  it("keeps a successful server warm", async () => {
    let releases = 0;
    let invalidations = 0;
    const result = await Effect.runPromise(
      withManagedServerProbe({
        provider: "opencode",
        binaryPath: "opencode",
        run: async () => "ready",
      }).pipe(
        Effect.provideService(OpencodeServerManager, {
          acquire: async () => ({
            client: {} as never,
            url: "http://127.0.0.1:4321",
            release: () => {
              releases += 1;
            },
            invalidate: () => {
              invalidations += 1;
            },
          }),
        }),
      ),
    );

    expect(result).toBe("ready");
    expect(releases).toBe(1);
    expect(invalidations).toBe(0);
  });

  it("invalidates the server when its health request fails", async () => {
    let releases = 0;
    let invalidations = 0;
    const result = await Effect.runPromise(
      Effect.exit(
        withManagedServerProbe({
          provider: "kilocode",
          binaryPath: "kilo",
          run: async () => {
            throw new Error("connection refused");
          },
        }).pipe(
          Effect.provideService(OpencodeServerManager, {
            acquire: async () => ({
              client: {} as never,
              url: "http://127.0.0.1:4322",
              release: () => {
                releases += 1;
              },
              invalidate: () => {
                invalidations += 1;
              },
            }),
          }),
        ),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(releases).toBe(0);
    expect(invalidations).toBe(1);
  });

  it("keeps a healthy server warm when optional catalog enrichment fails", async () => {
    let releases = 0;
    let invalidations = 0;
    const result = await Effect.runPromise(
      Effect.exit(
        withManagedServerProbe({
          provider: "opencode",
          binaryPath: "opencode",
          invalidateOnRunFailure: false,
          run: async () => {
            throw new Error("catalog response timed out");
          },
        }).pipe(
          Effect.provideService(OpencodeServerManager, {
            acquire: async () => ({
              client: {} as never,
              url: "http://127.0.0.1:4323",
              release: () => {
                releases += 1;
              },
              invalidate: () => {
                invalidations += 1;
              },
            }),
          }),
        ),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(releases).toBe(1);
    expect(invalidations).toBe(0);
  });
});
