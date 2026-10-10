import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { makeOwnedClient } from "./Client.ts";
import { readV2NativeCatalog } from "./Catalog.native.ts";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const version = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION;

it.skipIf(!binary || !version)(
  "qualifies real native shared discovery and owned-session API coexistence",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!);
    try {
      const config = await readFile(fixture.configFile);
      const registration = await readFile(fixture.file);
      const discovery = await discoverV2SharedService({ file: fixture.file });
      expect(discovery.version).toBe(version);
      expect(discovery.registration.pid).toBe(fixture.child.pid);
      expect(fixture.state.modelRequests).toBe(0);
      const client = makeOwnedClient({
        endpoint: discovery.registration.endpoint.url,
        password: discovery.registration.endpoint.auth!.password,
      });
      const location = { directory: fixture.workspace };
      const models = await readV2NativeCatalog(client, location.directory);
      expect(models.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "synthetic-model",
            providerID: "bigbud-v2-fixture",
            variants: expect.arrayContaining([expect.objectContaining({ id: "precise" })]),
          }),
        ]),
      );
      expect((await client.agent.list({ location })).data).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "qualification-reviewer" })]),
      );
      expect((await client.skill.list({ location })).data).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "example" })]),
      );
      await client.integration.list({ location }); // Metadata endpoint, never credential.list.
      await client.provider.list({ location });
      await client.mcp.list({ location });

      const model = { providerID: "bigbud-v2-fixture", id: "synthetic-model" };
      const unrelated = await client.session.create({
        id: "ses_tui_qualification",
        location,
        model,
        title: "TUI history must remain",
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "ask" },
        ],
      });
      fixture.state.tool = "shell";
      fixture.state.input = {
        command: "echo disposable",
        description: "Coexisting native permission",
      };
      await client.session.prompt({
        sessionID: unrelated.id,
        id: "msg_tui_qualification",
        text: "Synthetic sibling waits for an explicit tool approval",
        files: [],
      });
      await expect
        .poll(async () => (await client.permission.list({ sessionID: unrelated.id })).length, {
          timeout: 15000,
        })
        .toBe(1);
      const siblingPermission = await client.permission.list({ sessionID: unrelated.id });
      const siblingHistory = await client.message.list({ sessionID: unrelated.id });
      const sibling = await client.session.get({ sessionID: unrelated.id });
      expect((await client.session.active())[unrelated.id]).toBeDefined();
      const owner = await client.session.create({
        id: "ses_bigbud_qualification",
        location,
        model,
        metadata: {
          bigbud_provider: "opencodeV2",
          bigbud_thread: "qualification",
          bigbud_storage: "disposable",
        },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      });
      await client.session.update({
        sessionID: owner.id,
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "ask" },
        ],
      });
      const ask = await client.permission.create({
        sessionID: owner.id,
        action: "shell",
        resources: ["echo disposable"],
      });
      expect(ask.effect).toBe("ask");
      await client.permission.reply({ sessionID: owner.id, requestID: ask.id, decision: "reject" });
      expect(await client.permission.saved.list({ projectID: owner.projectID })).toEqual([]);
      await client.session.instructions.entry.put({
        sessionID: owner.id,
        key: "bigbud.qualification",
        value: "local synthetic only",
      });
      expect(await client.session.instructions.entry.list({ sessionID: owner.id })).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "bigbud.qualification" })]),
      );
      await client.session.instructions.entry.remove({
        sessionID: owner.id,
        key: "bigbud.qualification",
      });
      await client.session.switchModel({
        sessionID: owner.id,
        model: { ...model, variant: "precise" },
      });
      expect((await client.session.get({ sessionID: owner.id })).model?.variant).toBe("precise");
      await client.session.prompt({
        sessionID: owner.id,
        id: "msg_qualification",
        text: "delegated_thread_provenance: synthetic shared transport qualification",
        files: [],
      });
      await client.session.wait({ sessionID: owner.id }, { signal: AbortSignal.timeout(15000) });
      expect(fixture.state.modelRequests).toBeGreaterThan(0);
      expect(
        (await client.message.list({ sessionID: owner.id })).data.some(
          (message) => message.type === "user",
        ),
      ).toBe(true);
      await client.session.inbox.list({ sessionID: owner.id });
      await client.session.form.list({ sessionID: owner.id });

      // Subscription teardown is client-local, not a native shutdown or exit proof.
      const cancel = new AbortController();
      const events = client.event.subscribe({ signal: cancel.signal })[Symbol.asyncIterator]();
      expect((await events.next()).done).toBe(false);
      cancel.abort();
      await events.return?.();
      await client.session.interrupt({ sessionID: owner.id });
      expect((await client.server.info()).pid).toBe(fixture.child.pid);
      expect(await client.session.get({ sessionID: unrelated.id })).toEqual(sibling);
      expect(await client.message.list({ sessionID: unrelated.id })).toEqual(siblingHistory);
      expect(await client.permission.list({ sessionID: unrelated.id })).toEqual(siblingPermission);
      expect((await client.session.active())[unrelated.id]).toBeDefined();
      expect(await readFile(fixture.configFile)).toEqual(config);
      expect(await readFile(fixture.file)).toEqual(registration);
      expect(fixture.child.exitCode).toBeNull();
      expect((await discoverV2SharedService({ file: fixture.file })).generation).toBe(
        discovery.generation,
      );
    } finally {
      await fixture.close();
    }
  },
  60000,
);
