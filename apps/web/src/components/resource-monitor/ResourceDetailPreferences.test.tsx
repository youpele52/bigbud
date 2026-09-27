import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ResourceDetailPreferences } from "./ResourceDetailPreferences";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render }: { render: ReactNode }) => render,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("ResourceDetailPreferences", () => {
  it("uses labeled native checkboxes for keyboard-accessible detail controls", () => {
    const markup = renderToStaticMarkup(<ResourceDetailPreferences />);
    expect(markup).toContain('aria-label="Customize resource details"');
    expect(markup.match(/type="checkbox"/g)).toHaveLength(7);
    expect(markup).toContain("Disk details");
    expect(markup).toContain("Temperatures");
    expect(markup).toContain("Processes");
  });
});
