import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";
import { cn } from "./cn";

describe("shared status presentation", () => {
  it.each([
    ["loading", "border-l-info-foreground", true],
    ["success", "border-l-success", false],
    ["warning", "border-l-warning", false],
    ["error", "border-l-destructive", false],
    ["info", "border-l-muted-foreground", false],
  ] as const)("preserves %s semantics and content", (variant, accent, spinner) => {
    const markup = renderToStaticMarkup(
      <Alert variant={variant} aria-label="Delivery status" className="custom-alert">
        <AlertTitle>Delivery</AlertTitle>
        <AlertDescription>Keep this draft</AlertDescription>
        <AlertAction>
          <button type="button">Check delivery</button>
        </AlertAction>
      </Alert>,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Delivery status"');
    expect(markup).toContain(`data-status="${variant}"`);
    expect(markup).toContain(accent);
    expect(markup).toContain("text-sm");
    expect(markup).toContain("custom-alert");
    for (const slot of ["title", "description", "action"]) {
      expect(markup).toContain(`data-slot="alert-${slot}"`);
    }
    expect(markup.includes("animate-spin")).toBe(spinner);
    expect(markup).toContain("Keep this draft");
    expect(markup).toContain("Check delivery");
  });

  it("retains caller layout overrides without losing conditional classes", () => {
    expect(cn("p-2 text-sm", { hidden: false }, ["p-4", "font-medium"])).toBe(
      "text-sm p-4 font-medium",
    );
  });
});
