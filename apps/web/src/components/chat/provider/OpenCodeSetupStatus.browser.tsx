import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ServerOpencodeV2ThreadToolsSetupResult } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { OpenCodeSetupStatus } from "./OpenCodeSetupStatus";

const queued: ServerOpencodeV2ThreadToolsSetupResult = {
  status: "required",
  activationState: "waiting-for-idle",
  directory: "/workspace",
  artifactDirectoryUri: "",
  artifactDigest: "",
  issuerKeyId: "",
  configAddition: { plugins: [] },
  jobId: "a".repeat(32),
  interestId: "b".repeat(32),
  message: "Waiting for an active native prompt to finish.",
};

it("foregrounds the real queue reason and cancel control, then shows expiry and retry", async () => {
  const onCancel = vi.fn(),
    onRetry = vi.fn();
  const screen = await render(
    <OpenCodeSetupStatus result={queued} onCancel={onCancel} onRetry={onRetry} />,
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("OpenCode setup queued — waiting for idle");
  await expect.element(screen.getByRole("status")).toHaveTextContent(queued.message);
  await expect.element(screen.getByRole("button", { name: "Retry setup" })).toBeDisabled();
  await screen.getByRole("button", { name: "Cancel this setup request" }).click();
  expect(onCancel).toHaveBeenCalledOnce();
  await screen.rerender(
    <OpenCodeSetupStatus
      result={{
        ...queued,
        activationState: "deferred",
        message: "Setup deadline expired while waiting for native idle.",
      }}
      onCancel={onCancel}
      onRetry={onRetry}
    />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Setup deadline expired");
  await expect
    .element(screen.getByRole("button", { name: "Cancel this setup request" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Retry setup" }).click();
  expect(onRetry).toHaveBeenCalledOnce();
  await screen.unmount();
});
