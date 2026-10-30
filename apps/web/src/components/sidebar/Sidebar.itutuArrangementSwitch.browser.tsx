import "~/index.css";
import { afterEach, beforeEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { useItutuStore } from "../../stores/itutu/itutu.store";
import { SidebarItutuArrangementSwitch } from "./Sidebar.itutuArrangementSwitch";

const originalArrangement = useItutuStore.getState().arrangement;
const originalDark = document.documentElement.classList.contains("dark");

beforeEach(() => {
  useItutuStore.setState({ arrangement: "projects" });
});

afterEach(() => {
  useItutuStore.getState().setArrangement(originalArrangement);
  document.documentElement.classList.toggle("dark", originalDark);
});

it.each(["light", "dark"])(
  "uses compact toolbar styling and preserves arrangement switching in %s mode",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const screen = await render(
      <div style={{ width: 280 }}>
        <SidebarItutuArrangementSwitch />
      </div>,
    );
    const group = screen.getByRole("group", { name: "Sidebar arrangement" });
    const projects = screen.getByRole("button", { name: "Projects", exact: true });
    const itutu = screen.getByRole("button", { name: "Ìtútù", exact: true });

    await expect.element(group).toHaveAttribute("data-variant", "toolbar");
    await expect.element(group).toHaveAttribute("data-size", "xs");
    await expect.element(projects).toHaveAttribute("aria-pressed", "true");
    await expect.element(itutu).toHaveAttribute("aria-pressed", "false");
    const wrapper = group.element().parentElement!;
    expect(getComputedStyle(wrapper).paddingBottom).toBe("0px");

    for (const button of [projects.element(), itutu.element()]) {
      const style = getComputedStyle(button);
      expect(style.fontSize).toBe("14px");
      expect(style.borderColor).toBe("rgba(0, 0, 0, 0)");
      expect(button.getBoundingClientRect().height).toBeLessThanOrEqual(28);
    }
    expect(getComputedStyle(projects.element()).backgroundColor).not.toBe(
      getComputedStyle(itutu.element()).backgroundColor,
    );

    await itutu.click();
    await expect.element(itutu).toHaveAttribute("aria-pressed", "true");
    await expect.element(projects).toHaveAttribute("aria-pressed", "false");
    expect(useItutuStore.getState().arrangement).toBe("itutu");
    // Both arrangements now share the New chat / Search block and its spacing.
    expect(getComputedStyle(wrapper).paddingBottom).toBe("0px");

    // Clicking the selected option must not leave the sidebar without an arrangement.
    await itutu.click();
    await expect.element(itutu).toHaveAttribute("aria-pressed", "true");
    expect(useItutuStore.getState().arrangement).toBe("itutu");

    await projects.click();
    await expect.element(projects).toHaveAttribute("aria-pressed", "true");
    expect(useItutuStore.getState().arrangement).toBe("projects");
    expect(getComputedStyle(wrapper).paddingBottom).toBe("0px");
  },
);
