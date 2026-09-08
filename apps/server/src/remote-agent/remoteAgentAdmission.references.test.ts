import { describe, expect, it } from "vitest";
import { reconcileSupersededRemoteAgentConnections } from "./remoteAgentAdmission.references.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";

describe("superseded remote connection reconciliation", () => {
  it("releases only an obsolete route with no durable owners", async () => {
    let state = {
      currentConnectionId: "new",
      pins: [
        { owner: "connection:old", buildId: "old-build" },
        { owner: "connection:new", buildId: "new-build" },
      ],
    };
    const control = {
      registry: {
        read: async () => state,
        update: async () => {
          state = { ...state, pins: state.pins.filter((pin) => pin.owner !== "connection:old") };
          return state;
        },
      },
    } as unknown as RemoteAgentControl;
    await reconcileSupersededRemoteAgentConnections({
      bindings: {
        getBinding: async () => undefined,
        bindConnection: async () => undefined,
        listConnectionIds: async () => ["old", "new"],
        hasDurableReferences: async (_target, connectionId) => connectionId === "new",
      },
      control,
      target: "fixture",
    });
    expect(state.pins).toEqual([{ owner: "connection:new", buildId: "new-build" }]);
  });

  it("retains an obsolete route while another controller still owns it", async () => {
    let updates = 0;
    const control = {
      registry: {
        read: async () => ({ currentConnectionId: "new", pins: [] }),
        update: async () => {
          updates++;
          return {};
        },
      },
    } as unknown as RemoteAgentControl;
    await reconcileSupersededRemoteAgentConnections({
      bindings: {
        getBinding: async () => undefined,
        bindConnection: async () => undefined,
        listConnectionIds: async () => ["old"],
        hasDurableReferences: async () => true,
      },
      control,
      target: "fixture",
    });
    expect(updates).toBe(0);
  });
});
