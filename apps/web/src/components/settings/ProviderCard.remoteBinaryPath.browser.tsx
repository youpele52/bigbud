import "../../index.css";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProviderRemoteBinaryPath } from "./ProviderCard.remoteBinaryPath";

const field = () => page.getByRole("textbox", { name: "Remote binary path (SSH)" });

it("saves blank as unset, saves a valid path, and keeps an invalid path local with an error", async () => {
  const save = vi.fn();
  const screen = await render(<ProviderRemoteBinaryPath value="/opt/opencode" onChange={save} />);
  try {
    await expect.element(field()).toHaveValue("/opt/opencode");
    await expect
      .element(page.getByText(/Leave blank to auto-discover it on the remote host/))
      .toBeVisible();

    await field().fill("");
    expect(save).toHaveBeenLastCalledWith("");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await field().fill("/usr/local/bin/opencode");
    expect(save).toHaveBeenLastCalledWith("/usr/local/bin/opencode");

    save.mockClear();
    for (const invalid of ["opencode", "/usr/../bin/opencode", " /usr/bin/opencode"]) {
      await field().fill(invalid);
      await expect.element(page.getByRole("alert")).toHaveTextContent(/absolute, normalized path/);
      await expect.element(field()).toHaveAttribute("aria-invalid", "true");
    }
    expect(save).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
