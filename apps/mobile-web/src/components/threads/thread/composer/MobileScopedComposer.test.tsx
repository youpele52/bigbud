import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MobileScopedComposer } from "./MobileScopedComposer";

const base = { value: "draft", onChange: () => undefined, onSend: () => undefined };
const question = {
  requestId: "question",
  createdAt: "2026-11-14T00:00:00Z",
  questions: [
    {
      id: "q",
      header: "Choose",
      question: "Private question",
      options: [{ label: "Option A", description: "Choice" }],
    },
  ],
} as never;
const approval = {
  requestId: "approval",
  requestKind: "command",
  createdAt: "2026-11-14T00:00:00Z",
} as never;
it.each(["read-only", "approve-only", undefined] as const)(
  "%s hides send, stop and question controls",
  (sessionScope) => {
    const html = renderToStaticMarkup(
      <MobileScopedComposer
        {...base}
        sessionScope={sessionScope}
        isRunning
        pendingUserInput={question}
        onToggleUserInputOption={() => undefined}
        onAdvanceUserInput={() => undefined}
      />,
    );
    expect(html).not.toContain("Private question");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Stop generation");
    expect(html).not.toContain("Send message");
  },
);
it("approve-only keeps approval buttons but no question/model controls", () => {
  const html = renderToStaticMarkup(
    <MobileScopedComposer
      {...base}
      sessionScope="approve-only"
      pendingApproval={approval}
      onRespondToApproval={() => undefined}
    />,
  );
  expect(html).toContain(">Approve<");
  expect(html).toContain(">Deny<");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("Stop generation");
});
it("read-only hides approvals; thread-control retains the composer", () => {
  expect(
    renderToStaticMarkup(
      <MobileScopedComposer
        {...base}
        sessionScope="read-only"
        pendingApproval={approval}
        onRespondToApproval={() => undefined}
      />,
    ),
  ).not.toContain(">Approve<");
  expect(
    renderToStaticMarkup(<MobileScopedComposer {...base} sessionScope="thread-control" />),
  ).toContain('aria-label="Message"');
});

it.each(["uncertain", "reconciling", "rejected"] as const)(
  "approve-only retains %s response status after the approval disappears",
  (status) => {
    const html = renderToStaticMarkup(
      <MobileScopedComposer
        {...base}
        sessionScope="approve-only"
        pendingApproval={null}
        decisionDelivery={{
          status,
          onCheck: () => undefined,
          onResend: status === "uncertain" ? () => undefined : undefined,
        }}
      />,
    );
    if (status === "uncertain") {
      expect(html).toContain("Check response");
      expect(html).toContain("Send response again");
    } else if (status === "reconciling") {
      expect(html).toContain("Checking whether your response was accepted");
    } else {
      expect(html).toContain("Your response was rejected");
      expect(html).toContain('data-status="error"');
      expect(html).not.toContain('data-status="loading"');
    }
  },
);
it("read-only keeps outcome checks but removes mutation resends", () => {
  const html = renderToStaticMarkup(
    <MobileScopedComposer
      {...base}
      sessionScope="read-only"
      decisionDelivery={{
        status: "uncertain",
        onCheck: () => undefined,
        onResend: () => undefined,
      }}
    />,
  );
  expect(html).toContain("Check response");
  expect(html).not.toContain("Send response again");
});
