import { useShallow } from "zustand/react/shallow";
import { useUiStateStore } from "../../stores/ui";

export function useSidebarUiState() {
  return useUiStateStore(
    useShallow((store) => ({
      chatsExpanded: store.chatsExpanded,
      favouritesExpanded: store.favouritesExpanded,
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
      projectsExpanded: store.projectsExpanded,
      remoteWorkspacesExpanded: store.remoteWorkspacesExpanded,
      setChatsExpanded: store.setChatsExpanded,
      setFavouritesExpanded: store.setFavouritesExpanded,
      setProjectsExpanded: store.setProjectsExpanded,
      setRemoteWorkspacesExpanded: store.setRemoteWorkspacesExpanded,
    })),
  );
}
