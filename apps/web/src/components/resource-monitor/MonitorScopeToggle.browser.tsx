import "../../index.css";
import { useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { MonitorScopeToggle, type MonitorScope } from "./MonitorScopeToggle";

function ScopeFixture() {
  const [scope, setScope] = useState<MonitorScope>("system");
  return (
    <div>
      <MonitorScopeToggle scope={scope} onScopeChange={setScope} />
      <output aria-label="Selected scope">{scope}</output>
    </div>
  );
}

it("switches scopes with the existing toolbar controls and keeps one selected", async () => {
  const screen = await render(<ScopeFixture />);
  const system = screen.getByRole("button", { name: "Monitor system resources" });
  const bigbud = screen.getByRole("button", { name: "Monitor bigbud resources" });
  await expect.element(system).toHaveAttribute("aria-pressed", "true");
  await bigbud.click();
  await expect.element(bigbud).toHaveAttribute("aria-pressed", "true");
  await expect.element(system).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(screen.getByRole("status", { name: "Selected scope" }))
    .toHaveTextContent("bigbud");
  await bigbud.click();
  await expect.element(bigbud).toHaveAttribute("aria-pressed", "true");
  await system.click();
  await expect.element(system).toHaveAttribute("aria-pressed", "true");
});
