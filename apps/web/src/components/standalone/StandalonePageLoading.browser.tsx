import "../../index.css";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StandalonePageLoading } from "./StandalonePageLoading";

const mountedProducer = vi.fn();
const unmountedProducer = vi.fn();

function DataProducer() {
  useEffect(() => {
    mountedProducer();
    return () => {
      unmountedProducer();
    };
  }, []);
  return <p>Available data</p>;
}

let screen: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  vi.clearAllMocks();
});

function content(loading: boolean) {
  return (
    <div className="flex flex-col" style={{ width: 700, height: 500 }}>
      <header className="h-12 shrink-0">Page controls</header>
      <StandalonePageLoading loading={loading} label="Loading page">
        <DataProducer />
      </StandalonePageLoading>
    </div>
  );
}

it("centers the exact startup logo in the body without unmounting data producers", async () => {
  screen = await render(content(true));
  await expect.element(screen.getByText("Page controls")).toBeVisible();
  await expect.element(screen.getByText("Available data")).not.toBeVisible();
  expect(mountedProducer).toHaveBeenCalledTimes(1);
  const status = screen.getByRole("status").element();
  const body = status.parentElement!.getBoundingClientRect();
  const logo = status.querySelector("svg")!;
  const bounds = logo.getBoundingClientRect();
  expect(body.height).toBe(452);
  expect((bounds.top + bounds.bottom) / 2).toBeCloseTo((body.top + body.bottom) / 2, 0);
  expect((bounds.left + bounds.right) / 2).toBeCloseTo((body.left + body.right) / 2, 0);
  expect(bounds.height).toBe(28);
  expect(logo.classList.contains("animate-pulse-slow")).toBe(true);
  expect(logo.classList.contains("motion-reduce:animate-none")).toBe(true);
  expect(logo.getAttribute("aria-hidden")).toBe("true");
  await screen.rerender(content(false));
  await expect.element(screen.getByText("Available data")).toBeVisible();
  expect(screen.getByRole("status").elements()).toHaveLength(0);
  expect(mountedProducer).toHaveBeenCalledTimes(1);
  expect(unmountedProducer).not.toHaveBeenCalled();
});
