import { describe, expect, it, vi } from "vitest";
import { fixture } from "./remoteAgentAdmission.fixtures.ts";

describe("guarded connection preparation", () => {
  it("limits request churn before any release discovery or installation", async () => {
    const f = fixture();
    const target = `rate-${crypto.randomUUID()}`;
    const failure = new Error("Metadata unavailable.");
    const prepare = vi.fn(async () => {
      throw failure;
    });
    for (let index = 0; index < 8; index++)
      await expect(f.admission.fresh(target, `attempt-${index}`, prepare)).rejects.toBe(failure);
    await expect(f.admission.fresh(target, "overflow", prepare)).rejects.toMatchObject({
      code: "ADMISSION_RATE_LIMITED",
    });
    expect(prepare).toHaveBeenCalledTimes(8);
    expect(f.connect).not.toHaveBeenCalled();
    expect((await f.control.registry.read()).admissions).toEqual([]);
  });

  it("serializes preparation and admission together so the next request observes the committed selection", async () => {
    const f = fixture();
    const target = `serial-${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstPreparation = vi.fn(async () => {
      await gate;
      return {};
    });
    const secondPreparation = vi.fn(async () => {
      expect((await f.control.registry.read()).currentConnectionId).toBe("first");
      return {};
    });
    const first = f.admission.fresh(target, "first", firstPreparation);
    const second = f.admission.fresh(target, "second", secondPreparation);
    await vi.waitFor(() => expect(firstPreparation).toHaveBeenCalledOnce());
    expect(secondPreparation).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(secondPreparation).toHaveBeenCalledOnce();
  });
});
