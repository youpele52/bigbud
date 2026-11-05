import { expect, it, vi } from "vitest";
import { TerminalSetupCleanup } from "./TerminalSetupCleanup";

it("releases every acquired resource in reverse order even if a disposer throws", () => {
  const resources = new TerminalSetupCleanup();
  const order: number[] = [];
  resources.add(() => {
    order.push(1);
  });
  resources.add(() => {
    order.push(2);
    throw new Error("broken disposer");
  });
  resources.add(() => {
    order.push(3);
  });
  resources.dispose();
  resources.dispose();
  expect(order).toEqual([3, 2, 1]);
});

it("releases a resource acquired after an earlier cleanup cycle", () => {
  const resources = new TerminalSetupCleanup();
  resources.dispose();
  const dispose = vi.fn();
  resources.add(dispose);
  resources.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});
