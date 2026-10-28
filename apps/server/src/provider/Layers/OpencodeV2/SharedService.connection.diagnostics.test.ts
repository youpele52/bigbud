import { expect, it, vi } from "vitest";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { v2ExecutionIssue, v2ExecutionFailureClass } from "./Adapter.execution.errors.ts";

const discovery = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }));
vi.mock("./SharedService.descriptor.ts", () => ({ resolveV2SharedConnection: discovery.resolve }));
vi.mock("./SharedService.registration.ts", async (original) => ({
  ...(await original<typeof import("./SharedService.registration.ts")>()),
  readV2SharedRegistration: discovery.read,
}));

it.each(["storage", "generation"] as const)(
  "borrow rejects a changed %s with a redacted distinction, before creating a client",
  async (kind) => {
    const expected = {
      registrationFile: "/private/service.json",
      storageIdentity: "storage",
      generation: "generation",
    };
    discovery.resolve.mockResolvedValue({
      ...expected,
      [kind === "storage" ? "storageIdentity" : "generation"]: "private changed value",
    });
    discovery.read.mockClear();
    const error = await borrowV2SharedService(expected).catch((error: unknown) => error);
    expect(error).toMatchObject({ stage: kind });
    const issue = v2ExecutionIssue(error);
    expect(issue).toContain(
      kind === "storage" ? "storage-namespace-mismatch" : "generation-mismatch",
    );
    expect(issue).not.toMatch(/private|service.json|changed value/);
    expect(v2ExecutionFailureClass(error, issue)).toBe("unsafe-to-replay");
    expect(discovery.read).not.toHaveBeenCalled();
    expect(discovery.resolve).toHaveBeenLastCalledWith(expected.registrationFile);
  },
);
