import "../../index.css";

import type { ContextMenuItem, NativeApi } from "@bigbud/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { useCallback, useMemo, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../rpc/nativeApi";
import { DiffPanelFile } from "./DiffPanelFile";
import { useDiffAnnotateContextMenu } from "./useDiffAnnotateContextMenu";
import { useDiffAnnotateSelection } from "./useDiffAnnotateSelection";

declare module "vitest/browser" {
  interface BrowserCommands {
    dragSelectDiffLines: (
      startText: string,
      endText: string,
      rightClick: boolean,
    ) => Promise<string>;
  }
}

const FILE_PATH = "apps/mobile-web/src/context/MobileRuntimeBoundary.tsx";
// Captured from the conversation checkpoint that exposed the regression: a
// two-hunk modification whose second hunk replaces old 30-32 with new 30-33.
const PATCH = [
  `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
  `--- a/${FILE_PATH}`,
  `+++ b/${FILE_PATH}`,
  "@@ -1,5 +1,5 @@",
  ' import { QueryClientProvider } from "@tanstack/react-query";',
  '-import { useLayoutEffect, useRef, useState, type ReactNode } from "react";',
  '+import { useLayoutEffect, useState, type ReactNode } from "react";',
  " ",
  ' import type { StoredMobileSession } from "../lib/mobileSession";',
  ' import { MobileRpcProvider } from "./MobileRpcContext";',
  "@@ -27,12 +27,16 @@ export function MobileRuntimeBoundary({",
  "   readonly session: StoredMobileSession | null;",
  "   readonly children: ReactNode;",
  " }) {",
  "-  const active = useRef<{ session: StoredMobileSession | null; generation: number } | null>(null);",
  "-  if (!active.current || !sameMobileRuntimeSession(active.current.session, session)) {",
  "-    active.current = {",
  "+  const [active, setActive] = useState(() => ({",
  "+    session: session ? { ...session } : null,",
  "+    generation: 1,",
  "+  }));",
  "+  // React tracks this derived state across abandoned renders; no owner is retired here.",
  "+  if (!sameMobileRuntimeSession(active.session, session)) {",
  "+    setActive({",
  "       session: session ? { ...session } : null,",
  "-      generation: (active.current?.generation ?? 0) + 1,",
  "-    };",
  "+      generation: active.generation + 1,",
  "+    });",
  "   }",
  "-  return <MobileRuntimeOwner key={active.current.generation}>{children}</MobileRuntimeOwner>;",
  "+  return <MobileRuntimeOwner key={active.generation}>{children}</MobileRuntimeOwner>;",
  " }",
].join("\n");

function DiffFileAnnotationHarness({
  onAnnotationRequest = () => {},
}: {
  readonly onAnnotationRequest?: (annotation: {
    filePath: string;
    range: { startLine: number; endLine: number };
    selectedText: string;
  }) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pierreLineSelectionsRef = useRef(new Map());
  const fileDiff = useMemo(() => parsePatchFiles(PATCH, "shadow-selection")[0]!.files[0]!, []);
  const fileDiffByPath = useMemo(() => new Map([[FILE_PATH, fileDiff]]), [fileDiff]);
  const handleDirectAnnotation = useCallback(
    (selection: {
      filePath: string;
      range: { startLine: number; endLine: number };
      selectedText: string;
    }) => onAnnotationRequest(selection),
    [onAnnotationRequest],
  );

  useDiffAnnotateContextMenu({
    viewportRef,
    canAnnotate: true,
    cwd: "/repo",
    fileDiffByPath,
    pierreLineSelectionsRef,
    diffStyle: "unified",
    onAnnotateRequest: handleDirectAnnotation,
  });
  useDiffAnnotateSelection({
    viewportRef,
    canAnnotate: true,
    fileDiffByPath,
    onAnnotateRequest: handleDirectAnnotation,
  });

  return (
    <div ref={viewportRef} data-testid="viewport" className="h-[600px] overflow-auto">
      <DiffPanelFile
        fileDiff={fileDiff}
        filePath={FILE_PATH}
        themedFileKey="shadow-selection"
        diffRenderMode="stacked"
        diffWordWrap={false}
        resolvedTheme="dark"
        canAnnotate
        selectionOwnerFilePath={FILE_PATH}
        onOpenInFilesPanel={() => {}}
        onPierreLineSelectionChange={() => {}}
        onAnnotationRequest={handleDirectAnnotation}
      />
    </div>
  );
}

async function waitForDiffLines() {
  await vi.waitFor(() => {
    expect(
      document
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll("[data-content] [data-line]").length,
    ).toBeGreaterThan(5);
  });
}

describe("DiffPanelFile real drag annotation", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    delete window.nativeApi;
    __resetNativeApiForTests();
  });

  it("annotates a trusted drag selection whose Range boundaries were retargeted", async () => {
    const onAnnotationRequest = vi.fn();
    await render(<DiffFileAnnotationHarness onAnnotationRequest={onAnnotationRequest} />);
    await waitForDiffLines();

    const selectedText = await commands.dragSelectDiffLines(
      "const active = useRef",
      "  }));",
      false,
    );
    expect(selectedText.trim().length).toBeGreaterThan(2);

    await vi.waitFor(() => expect(onAnnotationRequest).toHaveBeenCalledOnce());
    expect(onAnnotationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: FILE_PATH,
        range: { startLine: 30, endLine: 33 },
      }),
    );
    const annotation = onAnnotationRequest.mock.calls[0]![0] as { selectedText: string };
    expect(annotation.selectedText).toContain("- active = useRef");
    expect(annotation.selectedText).toContain("+  }));");
  });

  it("offers Annotate selection in the context menu for a trusted drag selection", async () => {
    const showContextMenu = vi.fn<NativeApi["contextMenu"]["show"]>().mockResolvedValue(null);
    window.nativeApi = { contextMenu: { show: showContextMenu } } as unknown as NativeApi;
    __resetNativeApiForTests();

    await render(<DiffFileAnnotationHarness />);
    await waitForDiffLines();

    await commands.dragSelectDiffLines("const active = useRef", "  }));", true);

    await vi.waitFor(() => expect(showContextMenu).toHaveBeenCalledOnce());
    const items = showContextMenu.mock.calls[0]![0] as ReadonlyArray<ContextMenuItem>;
    expect(items.map((item) => item.label)).toContain("Annotate selection");
  });
});
