import { describe, expect, it } from "vitest";
import {
  listenOwnershipControl,
  requestOwnershipControl,
  type OwnershipRequest,
} from "./backendOwnership.control";

const request: OwnershipRequest = {
  version: 1,
  action: "inspect",
  operation: "a".repeat(32),
  identity: "test-instance",
};
describe("ownership control transport", () => {
  it("authenticates and returns a bounded response over loopback", async () => {
    const calls: OwnershipRequest[] = [];
    const endpoint = await listenOwnershipControl(async (input) => {
      calls.push(input);
      return "available";
    });
    try {
      expect(await requestOwnershipControl(endpoint.control, request)).toBe("available");
      expect(calls).toEqual([request]);
    } finally {
      await endpoint.close();
    }
  });
  it("rejects an incorrect secret without invoking the handler", async () => {
    let calls = 0;
    const endpoint = await listenOwnershipControl(async () => {
      calls++;
      return "available";
    });
    try {
      await expect(
        requestOwnershipControl({ ...endpoint.control, secret: "f".repeat(64) }, request),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      await endpoint.close();
    }
  });
  it("rejects oversized identity before execution", async () => {
    let calls = 0;
    const endpoint = await listenOwnershipControl(async () => {
      calls++;
      return "available";
    });
    try {
      await expect(
        requestOwnershipControl(endpoint.control, { ...request, identity: "x".repeat(10000) }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      await endpoint.close();
    }
  });
});
