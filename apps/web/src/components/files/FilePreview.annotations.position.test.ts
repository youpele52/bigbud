import { describe, expect, it } from "vitest";

import { annotationPanelTop } from "./FilePreview.annotations.position";

describe("annotationPanelTop", () => {
  const viewport = { viewportTop: 100, viewportHeight: 600, panelHeight: 250 };

  it("anchors below the last selected line when there is room", () => {
    expect(annotationPanelTop({ ...viewport, selectionTop: 140, selectionBottom: 240 })).toBe(248);
  });

  it("flips above only when the panel does not fit below", () => {
    expect(annotationPanelTop({ ...viewport, selectionTop: 500, selectionBottom: 580 })).toBe(242);
  });

  it("keeps a panel visible when neither side fits", () => {
    expect(annotationPanelTop({ ...viewport, selectionTop: 110, selectionBottom: 600 })).toBe(442);
  });

  it("clamps a selection that has scrolled out of view", () => {
    expect(annotationPanelTop({ ...viewport, selectionTop: 0, selectionBottom: 20 })).toBe(108);
    expect(annotationPanelTop({ ...viewport, selectionTop: 800, selectionBottom: 820 })).toBe(442);
  });

  it("accepts the exact below-fit boundary without flipping", () => {
    expect(annotationPanelTop({ ...viewport, selectionTop: 400, selectionBottom: 434 })).toBe(442);
  });
});
