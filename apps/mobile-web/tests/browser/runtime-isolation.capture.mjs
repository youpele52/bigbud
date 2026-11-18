import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { snapshot } from "./recovery.fixture.mjs";

export async function captureRuntimeIsolation(page, origin) {
  const directory = process.env.MOBILE_RUNTIME_OUTPUT_DIR ?? "/tmp/bigbud-mobile-runtime-isolation";
  await mkdir(directory, { recursive: true });
  const requests = [];
  const errors = [];
  const rejectedRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(message.text().replace(/([?&]token=)[^\s"']+/g, "$1[redacted]"));
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname !== "/@vite/client") return route.continue();
    rejectedRequests.push(`${url.origin}${url.pathname}`);
    return route.abort();
  });
  await page.routeWebSocket("**/*", (ws) => {
    const url = new URL(ws.url());
    if (
      url.pathname !== "/mobile-ws" ||
      !["host-a.invalid", "host-b.invalid"].includes(url.hostname)
    ) {
      rejectedRequests.push(`socket:${url.hostname}${url.pathname}`);
      return ws.close();
    }
    const host = url.hostname === "host-a.invalid" ? "A" : "B";
    const exit = (request, value) =>
      ws.send(
        JSON.stringify({
          _tag: "Exit",
          requestId: request.id,
          exit: { _tag: "Success", value },
        }),
      );
    ws.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request._tag !== "Request") return;
      requests.push({ host, tag: request.tag });
      if (request.tag === "mobile.recovery.getBaseline" && host === "A") {
        exit(request, {
          version: 1,
          recoveryAttemptId: request.payload.recoveryAttemptId,
          serverEpoch: "runtime-A",
          snapshotSequence: 0,
          snapshot: {
            ...snapshot,
            projects: snapshot.projects.map((project) =>
              Object.assign({}, project, { title: "Host A" }),
            ),
          },
          selectedThread: null,
        });
      } else if (request.tag === "mobile.recovery.subscribe" && host === "A") {
        ws.send(
          JSON.stringify({
            _tag: "Chunk",
            requestId: request.id,
            values: [
              {
                version: 1,
                route: "direct-unmanaged",
                serverEpoch: "runtime-A",
                recoveryAttemptId: request.payload.recoveryAttemptId,
                type: "caught-up",
                throughSequence: 0,
              },
            ],
          }),
        );
      }
      // B's baseline and A's dispatch are intentionally held across replacement.
    });
  });
  let observations = [];
  let stage = "initial-host-A";
  try {
    await page.goto(
      `${origin}/__mobile-runtime-isolation?strict=${process.env.MOBILE_RUNTIME_STRICT_MODE === "1" ? "1" : "0"}`,
    );
    const probe = page.locator('[data-runtime-observation="true"]');
    await page.waitForFunction(() =>
      document.querySelector("output")?.textContent?.includes('"snapshotTitle":"Host A"'),
    );
    await page.getByRole("textbox", { name: "Fixture draft" }).fill("A-only draft");
    stage = "held-command-A";
    await page.getByRole("button", { name: "Start held fixture command" }).click();
    await page.waitForFunction(() =>
      document.querySelector("output")?.textContent?.includes('"delivery":"pending"'),
    );
    const dispatchDeadline = Date.now() + 5000;
    while (
      !requests.some((item) => item.host === "A" && item.tag === "orchestration.dispatchCommand") &&
      Date.now() < dispatchDeadline
    )
      await page.waitForTimeout(20);
    assert.ok(
      requests.some((item) => item.host === "A" && item.tag === "orchestration.dispatchCommand"),
      "held A dispatch must reach the actual RPC fixture before replacement",
    );
    stage = "durable-draft-command-A";
    await page.waitForFunction(() => {
      const value = JSON.parse(document.querySelector("output")?.textContent ?? "{}");
      return (
        value.storedDraft === "A-only draft" && value.storedCommandId === "held-runtime-command"
      );
    });
    stage = "replacement-B";
    await page.getByRole("button", { name: "Select fixture B" }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("output")
        ?.textContent?.includes('"clientOrigin":"https://host-b.invalid"'),
    );
    observations = await page.evaluate(
      async () =>
        (await import("/src/test-fixtures/MobileRuntimeIsolation.fixture.tsx"))
          .runtimeIsolationObservations,
    );
    const replacement = observations.filter((item) => item.origin === "https://host-b.invalid");
    assert.ok(replacement.length > 0);
    assert.deepEqual(
      replacement.filter((item) => item.clientOrigin === "https://host-a.invalid"),
      [],
      "replacement render must synchronously fence old client",
    );
    assert.deepEqual(
      replacement.filter((item) => item.snapshotTitle === "Host A"),
      [],
      "replacement must not read old cache with colliding session IDs",
    );
    assert.deepEqual(
      replacement.filter(
        (item) =>
          item.draft !== "" ||
          item.delivery !== null ||
          item.storedDraft === "A-only draft" ||
          item.storedCommandId !== null,
      ),
      [],
      "old draft/held command callbacks must not enter replacement state",
    );
    assert.equal((await probe.innerText()).includes("A-only draft"), false);
    assert.equal(requests.filter((item) => item.tag === "orchestration.dispatchCommand").length, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(rejectedRequests, []);
    return { observations, requests, errors, rejectedRequests };
  } finally {
    await page.screenshot({ path: `${directory}/runtime.png`, animations: "disabled" });
    await writeFile(
      `${directory}/results.json`,
      JSON.stringify(
        {
          stage,
          observations,
          requests,
          errors,
          rejectedRequests,
          body: (await page.locator("body").innerText()).slice(0, 2000),
        },
        null,
        2,
      ),
    );
  }
}
