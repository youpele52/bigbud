import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

function style(id: string) {
  return getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!);
}

describe("shared base heading typography", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(["light", "dark"])(
    "provides defaults without overriding explicit headings in %s mode",
    async (theme) => {
      const wasDark = document.documentElement.classList.contains("dark");
      document.documentElement.classList.toggle("dark", theme === "dark");
      const mounted = await render(
        <div>
          <h2 data-testid="base-h2">Section</h2>
          <h3 data-testid="base-h3">Subsection</h3>
          <h2 data-testid="explicit" className="text-xs font-normal">
            Compact heading
          </h2>
          <div className="file-preview-markdown chat-markdown">
            <h2 data-testid="preview">Preview heading</h2>
          </div>
          <div className="notebook-cell-markdown">
            <h3 data-testid="notebook">Notebook heading</h3>
          </div>
        </div>,
      );
      try {
        expect(style("base-h2").fontSize).toBe("18px");
        expect(style("base-h2").fontWeight).toBe("600");
        expect(style("base-h3").fontSize).toBe("14px");
        expect(style("base-h3").fontWeight).toBe("500");
        expect(style("explicit").fontSize).toBe("12px");
        expect(style("explicit").fontWeight).toBe("400");
        expect(Number.parseFloat(style("preview").fontSize)).toBeCloseTo(21.6);
        expect(style("preview").fontWeight).toBe("700");
        expect(style("notebook").fontSize).toBe("19px");
        expect(style("notebook").fontWeight).toBe("700");
      } finally {
        await mounted.unmount();
        document.documentElement.classList.toggle("dark", wasDark);
      }
    },
  );
});
