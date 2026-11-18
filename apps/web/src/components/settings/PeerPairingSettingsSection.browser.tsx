import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";
import type {
  PeerPairingRequest,
  PeerPairingResult,
  PeerPairingView,
} from "@bigbud/contracts/server/remotePeer.pairing.ts";

import { PeerPairingSettingsSection } from "./PeerPairingSettingsSection";

const PIN = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
const W = "c".repeat(32);
const coordinator = {
  authorityId: "a".repeat(32),
  publicKey: `${PIN} bigbud-peer`,
  publicKeyFile: "/state/peer-coordinator/peer_ed25519.pub",
  fingerprint: `sha256:${"b".repeat(64)}`,
};
const pairing = (overrides: Partial<PeerPairingView>): PeerPairingView => ({
  pairingId: "00000003-0000-4000-8000-000000000001",
  label: "worker-one",
  workerAuthorityId: W,
  host: "w1.example.test",
  port: 22,
  user: "bigbud",
  pinnedHostKey: PIN,
  hostKeyFingerprint: "SHA256:abc",
  hostKeyConfirmedAt: "t",
  workspaceRoot: "/srv/work",
  provider: "codex",
  runtimeMode: "approval-required",
  coordinatorKeyFingerprint: coordinator.fingerprint,
  grantId: null,
  grantRecordedAt: null,
  grantRevokedAt: null,
  createdAt: "t",
  updatedAt: "t",
  state: "awaiting-grant",
  grantCommand: `bigbud peer grant --authority ${W} --coordinator ${"a".repeat(32)}`,
  revokeCommand: null,
  setupError: null,
  unsettledDispatches: 0,
  ...overrides,
});

const fixture = vi.hoisted(() => ({
  requests: [] as unknown[],
  reply: (_request: unknown): unknown => null,
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    server: {
      peerPairing: async (request: unknown) => {
        fixture.requests.push(request);
        return fixture.reply(request);
      },
    },
  }),
}));

describe("peer pairing settings", () => {
  it("pins a scanned host key only after explicit confirmation", async () => {
    fixture.requests.length = 0;
    fixture.reply = (request) => {
      const r = request as PeerPairingRequest;
      if (r.action === "scan-host-key")
        return {
          coordinator,
          pairings: [],
          scannedHostKeys: [{ pinnedHostKey: PIN, fingerprint: "SHA256:abc" }],
        } satisfies PeerPairingResult;
      if (r.action === "save") return { coordinator, pairings: [pairing({})] };
      return { coordinator, pairings: [] };
    };
    await render(<PeerPairingSettingsSection />);
    await page.getByLabelText("Label").fill("worker-one");
    await page.getByLabelText("Worker authority id").fill(W);
    await page.getByLabelText("SSH host").fill("w1.example.test");
    await page.getByLabelText("SSH user").fill("bigbud");
    await page.getByLabelText("Worker workspace root").fill("/srv/work");
    await page.getByRole("button", { name: "Scan host key" }).click();
    await expect.element(page.getByText("SHA256:abc")).toBeVisible();
    const save = page.getByRole("button", { name: "Save connection" });
    await expect.element(save).toBeDisabled();
    await page.getByLabelText(/I confirm this fingerprint/).click();
    await save.click();
    expect(fixture.requests).toContainEqual(
      expect.objectContaining({ action: "save", confirmPin: true, pinnedHostKey: PIN }),
    );
    await expect.element(page.getByText(/bigbud peer grant --authority/)).toBeVisible();
  });

  it("revoke keeps the saved connection and shows the worker revoke command", async () => {
    const grantId = "00000001-0000-4000-8000-000000000042";
    const revokeCommand = `bigbud peer revoke --authority ${W} --grant ${grantId}`;
    fixture.reply = (request) => {
      const r = request as PeerPairingRequest;
      if (r.action === "revoke")
        return {
          coordinator,
          pairings: [
            pairing({
              state: "revoked",
              grantId,
              grantRecordedAt: "t",
              grantRevokedAt: "t2",
              revokeCommand,
            }),
          ],
        };
      return {
        coordinator,
        pairings: [pairing({ state: "active", grantId, grantRecordedAt: "t", revokeCommand })],
      };
    };
    await render(<PeerPairingSettingsSection />);
    await expect.element(page.getByText("Active", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Revoke grant" }).click();
    await expect.element(page.getByText(revokeCommand)).toBeVisible();
    await expect.element(page.getByText("Revoked", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Delete saved connection" }))
      .toBeVisible();
  });
});
