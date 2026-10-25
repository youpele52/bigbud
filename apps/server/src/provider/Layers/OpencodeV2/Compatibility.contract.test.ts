import { expect, it } from "vitest";
import { makeOwnedClient } from "./Client.ts";

it("preserves exact generated 2.0.26 HTTP decision/resume and instruction/removal contract fields", async () => {
  const calls: { path: string; search: string; method: string; body: unknown }[] = [];
  const client = makeOwnedClient({
    endpoint: "http://127.0.0.1:4000",
    password: "synthetic-only",
    fetch: Object.assign(
      async (request: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const path = new URL(String(request)).pathname;
        calls.push({
          path,
          search: new URL(String(request)).search,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return path.endsWith("/interrupt")
          ? new Response(JSON.stringify({ data: { interrupted: true } }), {
              headers: { "content-type": "application/json" },
            })
          : new Response(null, { status: 204 });
      },
      { preconnect: () => {} },
    ) as typeof fetch,
  });
  await client.permission.reply({
    sessionID: "ses_fixture",
    requestID: "permission_fixture",
    decision: "once",
  });
  await client.session.interrupt({ sessionID: "ses_fixture", resume: false });
  await client.session.switchModel({
    sessionID: "ses_fixture",
    model: { providerID: "fixture", id: "model", variant: "precise" },
  });
  await client.session.instructions.entry.put({
    sessionID: "ses_fixture",
    key: "bigbud.preview.v1.access",
    value: "guidance",
  });
  await client.session.remove({ sessionID: "ses_fixture" });
  await client.session.form.cancel({
    sessionID: "ses_fixture",
    formID: "frm_fixture",
    message: "unsupported",
  });
  expect(calls[0]).toMatchObject({ method: "POST", body: { decision: "once" } });
  expect(calls[1]).toMatchObject({ method: "POST", search: "?resume=false", body: undefined });
  expect(calls[2]).toMatchObject({
    method: "POST",
    body: { model: { providerID: "fixture", id: "model", variant: "precise" } },
  });
  expect(calls[3]).toMatchObject({
    method: "PUT",
    path: "/api/experimental/session/ses_fixture/instructions/entries/bigbud.preview.v1.access",
    body: { value: "guidance" },
  });
  expect(calls[4]).toMatchObject({ method: "DELETE", path: "/api/session/ses_fixture" });
  expect(calls[5]).toMatchObject({
    method: "DELETE",
    path: "/api/session/ses_fixture/form/frm_fixture",
    search: "?message=unsupported",
    body: undefined,
  });
});
