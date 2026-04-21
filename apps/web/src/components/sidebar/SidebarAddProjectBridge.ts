import { useSyncExternalStore } from "react";

type AddProjectHandlers = {
  handleStartAddProject: () => void;
  isFlowVisible: () => boolean;
};

let handlers: AddProjectHandlers | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((listener) => {
    listener();
  });
}

export function registerSidebarAddProjectHandlers(nextHandlers: AddProjectHandlers) {
  handlers = nextHandlers;
  notifyListeners();
  return () => {
    if (handlers === nextHandlers) {
      handlers = null;
      notifyListeners();
    }
  };
}

export function startSidebarAddProjectFlow() {
  handlers?.handleStartAddProject();
}

export function isSidebarAddProjectFlowVisible() {
  return handlers?.isFlowVisible() ?? false;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSidebarAddProjectFlowVisible() {
  return useSyncExternalStore(subscribe, isSidebarAddProjectFlowVisible, () => false);
}
