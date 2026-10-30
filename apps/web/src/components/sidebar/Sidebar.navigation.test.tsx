import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useSidebarState } from "./Sidebar.state";

const preferences = vi.hoisted(() => ({
  arrangement: "projects",
  isMobile: false,
  setOpenMobile: vi.fn(),
  handleNewChat: vi.fn(),
  fixedActions: null as null | { onNewChat: () => void },
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../config/env", () => ({ isElectron: false }));
vi.mock("../../stores/itutu/itutu.store", () => ({
  useItutuStore: (selector: (state: typeof preferences) => unknown) => selector(preferences),
}));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: preferences.isMobile, setOpenMobile: preferences.setOpenMobile }),
  SidebarContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./SidebarProjectItem", () => ({ BigbudLogo: () => <div>Loading threads</div> }));
vi.mock("./Sidebar.actionsSection", () => ({
  SidebarFixedActions: (props: { onNewChat: () => void; newThreadShortcutLabel: string }) => {
    preferences.fixedActions = props;
    return (
      <div>
        <button>New chat</button>
        <button>Search</button>
        <span>{props.newThreadShortcutLabel}</span>
      </div>
    );
  },
  SidebarActionsSection: () => (
    <nav>
      {["New chat", "Search", "Scheduled", "Games", "System Monitor", "Usage"].map((label) => (
        <button key={label}>{label}</button>
      ))}
    </nav>
  ),
}));
vi.mock("./Sidebar.favoritesSection", () => ({ SidebarFavoritesSection: () => null }));
vi.mock("./Sidebar.chatsSection", () => ({ SidebarChatsSection: () => null }));
vi.mock("./Sidebar.projectsSection", () => ({ SidebarProjectsSection: () => null }));
vi.mock("./Sidebar.itutuArrangementSwitch", () => ({
  SidebarItutuArrangementSwitch: () => <div>Arrangement switch</div>,
}));
vi.mock("./Sidebar.itutuSection", () => ({
  SidebarItutuSection: () => <div>Ìtútù thread groups</div>,
}));

import { SidebarNavigation } from "./Sidebar.navigation";

function renderNavigation(bootstrapComplete = true) {
  const state = {
    bootstrapComplete,
    appSettings: {},
    handleNewChat: () => {
      preferences.handleNewChat();
      return Promise.resolve();
    },
    newThreadShortcutLabel: "⌘N",
  } as ReturnType<typeof useSidebarState>;
  return renderToStaticMarkup(<SidebarNavigation state={state} />);
}

const actionLabels = ["New chat", "Search", "Scheduled", "Games", "System Monitor", "Usage"];

describe("SidebarNavigation arrangement", () => {
  beforeEach(() => {
    preferences.arrangement = "projects";
    preferences.isMobile = false;
    preferences.fixedActions = null;
    vi.clearAllMocks();
  });

  it("keeps navigation actions in Projects mode", () => {
    const html = renderNavigation();
    for (const label of actionLabels) expect(html).toContain(label);
    expect(html).toContain("Arrangement switch");
    expect(html).not.toContain("Ìtútù thread groups");
  });

  it("keeps only New chat and Search in Ìtútù mode alongside the switch and threads", () => {
    preferences.arrangement = "itutu";
    const html = renderNavigation();
    expect(html).toContain("New chat");
    expect(html).toContain("Search");
    expect(html).toContain("⌘N");
    for (const label of actionLabels.slice(2)) expect(html).not.toContain(label);
    expect(html).not.toContain("<nav>");
    expect(html).toContain("Arrangement switch");
    expect(html).toContain("Ìtútù thread groups");
  });

  it("keeps New chat and Search available while Ìtútù is loading without showing other links", () => {
    preferences.arrangement = "itutu";
    const html = renderNavigation(false);
    expect(html).toContain("New chat");
    expect(html).toContain("Search");
    for (const label of actionLabels.slice(2)) expect(html).not.toContain(label);
    expect(html).toContain("Arrangement switch");
    expect(html).toContain("Loading threads");
    expect(html).not.toContain("Ìtútù thread groups");
  });

  it.each([false, true])(
    "starts a chat with the shared mobile behavior (mobile=%s)",
    (isMobile) => {
      preferences.arrangement = "itutu";
      preferences.isMobile = isMobile;
      renderNavigation();
      expect(preferences.fixedActions).not.toBeNull();
      preferences.fixedActions!.onNewChat();
      expect(preferences.handleNewChat).toHaveBeenCalledOnce();
      if (isMobile) expect(preferences.setOpenMobile).toHaveBeenCalledWith(false);
      else expect(preferences.setOpenMobile).not.toHaveBeenCalled();
    },
  );
});
