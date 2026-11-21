import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const openFile = vi.hoisted(() => vi.fn());
vi.mock("../chat/common/chatFileTargets", () => ({ openChatFileTarget: openFile }));

import { FileOpenTargetContext } from "../files/fileOpenTarget.context";
import { BaseMarkdown } from "./BaseMarkdown";

afterEach(() => {
  document.body.innerHTML = "";
  openFile.mockReset();
});

it("opens a remote thread's file link on that thread's machine, by absolute path", async () => {
  const mounted = await render(
    <FileOpenTargetContext.Provider value="ssh:host=box&transport=agent">
      <BaseMarkdown text="[guide](docs/guide.md)" cwd="/srv/app" />
    </FileOpenTargetContext.Provider>,
  );
  try {
    await page.getByRole("link", { name: "guide" }).click();
    expect(openFile).toHaveBeenCalledExactlyOnceWith(
      "/srv/app/docs/guide.md",
      "/srv/app",
      "file",
      "ssh:host=box&transport=agent",
    );
  } finally {
    await mounted.unmount();
  }
});
