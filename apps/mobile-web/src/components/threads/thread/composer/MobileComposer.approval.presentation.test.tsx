import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FloatingPendingApprovalCard } from "~/components/floating-assistant/FloatingPendingApprovalCard";
import { parityApproval } from "../../../../test-fixtures/MobileParityReference.data";
import { MobileComposer } from "./MobileComposer";

const desktop = () =>
  renderToStaticMarkup(
    <FloatingPendingApprovalCard
      approval={parityApproval}
      isResponding={false}
      onRespondToApproval={async () => {}}
    />,
  );
const mobile = () =>
  renderToStaticMarkup(
    <MobileComposer
      value=""
      onChange={() => {}}
      onSend={() => {}}
      pendingApproval={parityApproval}
      onRespondToApproval={() => {}}
    />,
  );

describe("current desktop/mobile approval presentation", () => {
  it("uses the current desktop approval title and explanation", () => {
    const reference = desktop();
    const rendered = mobile();
    expect(reference).toContain("Approval required");
    expect(reference).toContain("Command approval requested");
    expect(rendered).toContain("Approval required");
    expect(rendered).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(rendered).toContain("Command approval requested");
    expect(rendered).toContain("The agent wants to run a command that requires your approval.");
  });
  it("uses the warning surface while preserving mobile decision targets", () => {
    expect(desktop()).toContain("border-warning/35");
    const rendered = mobile();
    expect(rendered).toContain("border-warning/35");
    expect(rendered).toContain("bg-warning/5");
    expect(rendered).toContain("min-h-11");
    expect(rendered).toContain(">Deny</button>");
    expect(rendered).toContain(">Approve</button>");
  });
});
