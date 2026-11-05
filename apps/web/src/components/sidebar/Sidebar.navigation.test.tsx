import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useSidebarState } from "./Sidebar.state";

const preferences = vi.hoisted(() => ({
  arrangement: "projects",
  isMobile: false,
  setOpenMobile: vi.fn(),
  handleNewChat: vi.fn(),
  handleNewChats: vi.fn(),
  fixedActions: null as null | { onNewChat: () => void },
  mainAction: null as null | { onNewChat: () => void; newThreadShortcutLabel: string },
  chatsAction: null as null | { onNewChat: () => void; newThreadShortcutLabel: string },
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../config/env", () => ({ isElectron: false }));
vi.mock("../../stores/inyosira/inyosira.store", () => ({
  useInyosiraStore: (selector: (state: typeof preferences) => unknown) => selector(preferences),
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
  SidebarActionsSection: (props: {
    onNewChat: () => void;
    newThreadShortcutLabel: string;
    sections: { chats?: (headerProps: object) => ReactNode };
  }) => {
    preferences.mainAction = props;
    return (
      <nav>
        {["New chat", "Search", "Scheduled", "Games", "System Monitor", "Usage"].map((label) => (
          <button key={label}>{label}</button>
        ))}
        {props.sections.chats?.({})}
      </nav>
    );
  },
}));
vi.mock("./Sidebar.favoritesSection", () => ({ SidebarFavoritesSection: () => null }));
vi.mock("./Sidebar.chatsSection", () => ({
  SidebarChatsSection: (props: { onNewChat: () => void; newThreadShortcutLabel: string }) => {
    preferences.chatsAction = props;
    return null;
  },
}));
vi.mock("./Sidebar.projectsSection", () => ({ SidebarProjectsSection: () => null }));
vi.mock("./Sidebar.inyosiraArrangementSwitch", () => ({
  SidebarInyosiraArrangementSwitch: () => <div>Arrangement switch</div>,
}));
vi.mock("./Sidebar.inyosiraSection", () => ({
  SidebarInyosiraSection: () => <div>Inyosira thread groups</div>,
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
    handleNewChats: () => {
      preferences.handleNewChats();
      return Promise.resolve();
    },
    newChatShortcutLabel: "⌘N",
    newThreadShortcutLabel: "⌥⌘N",
  } as ReturnType<typeof useSidebarState>;
  return renderToStaticMarkup(<SidebarNavigation state={state} />);
}

const actionLabels = ["New chat", "Search", "Scheduled", "Games", "System Monitor", "Usage"];

describe("SidebarNavigation arrangement", () => {
  beforeEach(() => {
    preferences.arrangement = "projects";
    preferences.isMobile = false;
    preferences.fixedActions = null;
    preferences.mainAction = null;
    preferences.chatsAction = null;
    vi.clearAllMocks();
  });

  it("keeps navigation actions in Projects mode", () => {
    const html = renderNavigation();
    for (const label of actionLabels) expect(html).toContain(label);
    expect(html).toContain("Arrangement switch");
    expect(html).not.toContain("Inyosira thread groups");
  });
  it("routes the main action to the current project and the Chats action to base Chats", () => {
    renderNavigation();
    expect(preferences.mainAction?.newThreadShortcutLabel).toBe("⌘N");
    expect(preferences.chatsAction?.newThreadShortcutLabel).toBe("⌥⌘N");
    preferences.mainAction?.onNewChat();
    preferences.chatsAction?.onNewChat();
    expect(preferences.handleNewChat).toHaveBeenCalledOnce();
    expect(preferences.handleNewChats).toHaveBeenCalledOnce();
  });

  it("keeps only New chat and Search in Inyosira mode alongside the switch and threads", () => {
    preferences.arrangement = "inyosira";
    const html = renderNavigation();
    expect(html).toContain("New chat");
    expect(html).toContain("Search");
    expect(html).toContain("⌘N");
    for (const label of actionLabels.slice(2)) expect(html).not.toContain(label);
    expect(html).not.toContain("<nav>");
    expect(html).toContain("Arrangement switch");
    expect(html).toContain("Inyosira thread groups");
  });

  it("keeps New chat and Search available while Inyosira is loading without showing other links", () => {
    preferences.arrangement = "inyosira";
    const html = renderNavigation(false);
    expect(html).toContain("New chat");
    expect(html).toContain("Search");
    for (const label of actionLabels.slice(2)) expect(html).not.toContain(label);
    expect(html).toContain("Arrangement switch");
    expect(html).toContain("Loading threads");
    expect(html).not.toContain("Inyosira thread groups");
  });

  it.each([false, true])(
    "starts a chat with the shared mobile behavior (mobile=%s)",
    (isMobile) => {
      preferences.arrangement = "inyosira";
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
