import { ExpandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KanbanEditorOverlay } from "../kanban/KanbanEditorOverlay";
import { ResourceDetailDialog } from "../resource-monitor/ResourceDetailDialog";
import { MarkdownTable } from "./MarkdownTable";

describe("shared expand icon", () => {
  it.each([
    {
      label: "Open table",
      element: (
        <MarkdownTable>
          <tbody>
            <tr>
              <td>Example</td>
            </tr>
          </tbody>
        </MarkdownTable>
      ),
    },
    {
      label: "Enter fullscreen editor",
      element: (
        <KanbanEditorOverlay
          content=""
          cwd={undefined}
          error={null}
          mode="create"
          saving={false}
          selectedStatus="todo"
          title="Example"
          onCancel={() => {}}
          onContentChange={() => {}}
          onDelete={null}
          onSave={async () => {}}
          onStatusChange={() => {}}
          onTitleChange={() => {}}
        />
      ),
    },
    {
      label: "Expand CPU",
      element: (
        <ResourceDetailDialog title="CPU" description="CPU history" expandedContent="History">
          {(trigger) => <div>{trigger}</div>}
        </ResourceDetailDialog>
      ),
    },
  ])("renders Hugeicons ExpandIcon in $label", ({ label, element }) => {
    const markup = renderToStaticMarkup(element);
    const button = markup.match(
      new RegExp(`<button[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?<\\/button>`),
    )?.[0];

    expect(button).toBeDefined();
    expect(button).toContain(
      renderToStaticMarkup(<HugeiconsIcon aria-hidden="true" icon={ExpandIcon} />),
    );
    expect(markup).not.toContain("lucide-maximize");
  });
});
