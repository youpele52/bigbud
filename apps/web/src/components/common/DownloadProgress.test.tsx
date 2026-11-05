import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DownloadProgress } from "./DownloadProgress";

describe("shared download progress", () => {
  it("preserves app-update label and determinate progress accessibility", () => {
    const html = renderToStaticMarkup(<DownloadProgress label="Downloading update" percent={53} />);
    expect(html).toContain('aria-label="Downloading update"');
    expect(html).toContain('aria-valuenow="53"');
    expect(html).toContain("Download progress: 53%");
    expect(html).toContain("53%");
  });

  it("keeps simultaneous downloads independent and supports actual-byte detail and cancel actions", () => {
    const html = renderToStaticMarkup(
      <>
        <DownloadProgress label="Downloading update" percent={53} />
        <DownloadProgress
          label="Downloading Copilot"
          percent={25}
          detail="30 MB / 120 MB"
          action={<button type="button">Cancel Copilot download</button>}
        />
      </>,
    );
    expect(html).toContain('aria-label="Downloading update"');
    expect(html).toContain('aria-valuenow="53"');
    expect(html).toContain('aria-label="Downloading Copilot"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("30 MB / 120 MB");
    expect(html).toContain("Cancel Copilot download");
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses indeterminate progress for unknown/invalid %s",
    (percent) => {
      const html = renderToStaticMarkup(
        <DownloadProgress label="Verifying Copilot" percent={percent} />,
      );
      expect(html).not.toContain("aria-valuenow");
      expect(html).toContain("Verifying Copilot");
      expect(html).not.toContain("NaN");
    },
  );

  it.each([
    [-10, 0],
    [120, 100],
  ])("clamps %s to %s", (percent, expected) => {
    const html = renderToStaticMarkup(
      <DownloadProgress label="Downloading update" percent={percent!} />,
    );
    expect(html).toContain(`aria-valuenow="${expected}"`);
  });
});
