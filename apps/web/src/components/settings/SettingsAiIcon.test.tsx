import { AiIcon } from "../AiIcon";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsAiIcon } from "./SettingsAiIcon";
import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav.items";

describe("SettingsAiIcon", () => {
  it.each(["size-3.5 shrink-0 text-muted-foreground", "size-3"])(
    "renders Robotic artwork with the existing styling: %s",
    (className) => {
      expect(renderToStaticMarkup(<SettingsAiIcon className={className} />)).toBe(
        renderToStaticMarkup(<AiIcon className={className} />),
      );
    },
  );

  it("uses the shared artwork for the AI settings navigation entry", () => {
    expect(SETTINGS_NAV_ITEMS.find(({ to }) => to === "/settings/ai")).toEqual({
      label: "AI",
      to: "/settings/ai",
      icon: SettingsAiIcon,
    });
  });
});
