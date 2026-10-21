import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { makeOwnedClient, v2Request } from "./Client.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { v2SharedToolPolicy } from "./Runtime.policy.shared.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
if (process.env.BIGBUD_OPENCODE_V2_REQUIRED_NATIVE === "1" && !binary)
  throw new Error("Required native subagent permission probe needs an approved fixture binary.");

// Negative prerequisite probe, NOT G4 qualification: manually linked, idle native
// sessions exercise the actual evaluator, without prompts or any model requests.
it.skipIf(!binary)(
  "native inherited session grants can override stricter child agent rules; configured rules and pending decisions stay distinct",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!, async (file) => {
      const config = JSON.parse(await readFile(file, "utf8"));
      config.agents["g4-restricted"] = {
        description: "Disposable permission prerequisite probe",
        mode: "subagent",
        permissions: [
          { action: "read", resource: "*", effect: "ask" },
          { action: "edit", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
        ],
      };
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    });
    try {
      const registration = await readV2SharedRegistration(fixture.file);
      const client = makeOwnedClient({
        endpoint: registration.endpoint.url,
        password: registration.endpoint.auth!.password,
      });
      for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
        const permissions = v2SharedToolPolicy(mode, undefined, true);
        const parent = await v2Request("g4 parent.create", (signal) =>
          client.session.create(
            { location: { directory: fixture.workspace }, permissions },
            { signal },
          ),
        );
        const inherited = await v2Request("g4 inherited child.create", (signal) =>
          client.session.create({ parentID: parent.id, agent: "g4-restricted" }, { signal }),
        );
        expect(inherited.parentID).toBe(parent.id);
        expect(inherited.location.directory).toBe(parent.location.directory);
        expect(inherited.permissions).toEqual(permissions);
        const edit = await v2Request("g4 inherited edit evaluation", (signal) =>
          client.permission.create(
            { sessionID: inherited.id, action: "edit", resources: ["fixture.txt"] },
            { signal },
          ),
        );
        // Appending the parent's rules is not intersection: even ask overrides the
        // child's configured deny. No edit is executed by permission.create.
        expect(edit.effect).toBe(mode === "approval-required" ? "ask" : "allow");
        if (edit.effect === "ask")
          await v2Request("g4 reject inherited request", (signal) =>
            client.permission.reply(
              { sessionID: inherited.id, requestID: edit.id, decision: "reject" },
              { signal },
            ),
          );
        const strict = await v2Request("g4 explicit child.create", (signal) =>
          client.session.create(
            { parentID: parent.id, agent: "g4-restricted", permissions: [] },
            { signal },
          ),
        );
        const denied = await v2Request("g4 configured deny", (signal) =>
          client.permission.create(
            { sessionID: strict.id, action: "edit", resources: ["fixture.txt"] },
            { signal },
          ),
        );
        expect(denied.effect).toBe("deny");
        const ask = async (sessionID: string) =>
          v2Request("g4 configured ask", (signal) =>
            client.permission.create(
              { sessionID, action: "read", resources: ["fixture.txt"] },
              { signal },
            ),
          );
        const first = await ask(strict.id);
        const sibling = await v2Request("g4 sibling.create", (signal) =>
          client.session.create(
            { parentID: parent.id, agent: "g4-restricted", permissions: [] },
            { signal },
          ),
        );
        const second = await ask(sibling.id);
        expect(first.effect).toBe("ask");
        expect(second.effect).toBe("ask");
        const pending = (sessionID: string) =>
          v2Request("g4 permission.list", (signal) =>
            client.permission.list({ sessionID }, { signal }),
          );
        expect(await pending(strict.id)).toMatchObject([{ id: first.id, sessionID: strict.id }]);
        await v2Request("g4 reject exact child", (signal) =>
          client.permission.reply(
            { sessionID: strict.id, requestID: first.id, decision: "reject" },
            { signal },
          ),
        );
        expect(await pending(strict.id)).toEqual([]);
        expect(await pending(sibling.id)).toMatchObject([{ id: second.id, sessionID: sibling.id }]);
        await v2Request("g4 approve once exact sibling", (signal) =>
          client.permission.reply(
            { sessionID: sibling.id, requestID: second.id, decision: "once" },
            { signal },
          ),
        );
        expect(
          await v2Request("g4 saved approvals", (signal) =>
            client.permission.saved.list({ projectID: parent.projectID }, { signal }),
          ),
        ).toEqual([]);
      }
      expect(fixture.state.modelRequests).toBe(0);
    } finally {
      await fixture.close();
    }
  },
  60000,
);
