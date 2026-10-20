import { expect, it } from "vitest";
import { OpencodeV2SharedBindingConflict } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { v2ExecutionIssue } from "./Adapter.execution.errors.ts";
import { makeOwnedClient, v2Request } from "./Client.ts";
import { V2ResponseSizeError } from "./Client.response.ts";

it("exposes local binding conflict and response-bound details without claiming isolated mode", () => {
  const detail =
    "Shared binding reservation differs from retained material; history retained, no replay.";
  expect(v2ExecutionIssue(new OpencodeV2SharedBindingConflict({ detail }))).toBe(`V2 ${detail}`);
  expect(v2ExecutionIssue(new V2ResponseSizeError())).toBe(
    "OpenCode v2 response exceeded the decoding safety bound.",
  );
  expect(v2ExecutionIssue(new Error("V2 bound session unavailable; no replacement."))).toBe(
    "V2 bound session unavailable; no replacement.",
  );
});

it("exposes only guarded HTTP status through the real Promise client, not sensitive native response data", async () => {
  const client = makeOwnedClient({
    endpoint: "http://127.0.0.1:45991",
    password: "synthetic-secret",
    fetch: Object.assign(
      async () =>
        new Response("synthetic-secret prompt-body", {
          status: 500,
          headers: { "x-private": "synthetic-secret" },
        }),
      { preconnect: () => {} },
    ) as typeof fetch,
  });
  const error = await v2Request("session.create", (signal) =>
    client.session.create({ location: { directory: "/fixture" } }, { signal }),
  ).catch((error: unknown) => error);
  expect(v2ExecutionIssue(error)).toBe(
    "OpenCode v2 session.create returned HTTP 500; admission may be unconfirmed.",
  );
  expect(v2ExecutionIssue(error)).not.toContain("synthetic-secret");
  expect(error).not.toHaveProperty("cause");
});

it("rejects forged classifications and sensitive arbitrary SDK errors with a mode-neutral fallback", () => {
  for (const error of [
    Object.assign(new Error("synthetic-secret prompt-body"), {
      name: "V2HttpStatusError",
      status: 500,
    }),
    { _tag: "OpencodeV2SharedBindingConflict", detail: "synthetic-secret prompt-body" },
    new Error("synthetic-secret prompt-body", { cause: new Error("authorization: private") }),
  ]) {
    expect(v2ExecutionIssue(error)).toBe(
      "OpenCode v2 operation failed or remains unconfirmed; no automatic resend or provider fallback.",
    );
  }
});
