import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";

// U23 live check of OpenSSH-default host-key types through the production owner, against a
// disposable sshd whose only host key is of one type. The owner's `known_hosts` is the
// target's `knownHostsFile`.
//
// BIGBUD_TEST_U23_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":"/tmp","remoteBinary":"/unused"}'
// BIGBUD_TEST_U23_EXPECT=first-use|changed
// BIGBUD_TEST_U23_KEY_TYPE=ecdsa-sha2-nistp256|ssh-rsa   (first-use)
// BIGBUD_TEST_U23_FINGERPRINT=SHA256:…                    (first-use; from `ssh-keygen -l`)
const external = readExternalV2Target(process.env.BIGBUD_TEST_U23_EXTERNAL_TARGET);
const expectation = process.env.BIGBUD_TEST_U23_EXPECT;

it.skipIf(external === undefined || expectation === undefined)(
  "inspects, approves and connects with one host-key type, or refuses a changed type",
  async () => {
    await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
      const bound = handle.target(targets[0]!.descriptor);
      if (expectation === "changed") {
        await expect(bound.inspectTrust()).rejects.toMatchObject({ code: "hostKeyChanged" });
        return;
      }
      const first = await bound.inspectTrust();
      expect(first).toMatchObject({
        state: "approvalRequired",
        keyType: process.env.BIGBUD_TEST_U23_KEY_TYPE,
        fingerprint: process.env.BIGBUD_TEST_U23_FINGERPRINT,
      });
      if (first.state !== "approvalRequired") return;
      await bound.approveTrust(first.challenge);
      await expect(bound.inspectTrust()).resolves.toMatchObject({ state: "verified" });
      await expect(bound.connect()).resolves.toMatchObject({ state: "connected" });
      await bound.disconnect();
    });
  },
  120_000,
);
