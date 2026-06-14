import { create } from "zustand";

export type GitPanelView = "changes" | "history";

interface GitPanelViewState {
  activeView: GitPanelView;
  setActiveView: (view: GitPanelView) => void;
}

export const useGitPanelViewStore = create<GitPanelViewState>((set) => ({
  activeView: "changes",
  setActiveView: (activeView) => set({ activeView }),
}));
