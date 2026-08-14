import { useCallback, useRef, type ReactNode } from "react";
import { autoAnimate } from "@formkit/auto-animate";
import {
  DndContext,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  type DragCancelEvent,
  type DragEndEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { type ProjectCatalogScope, type ProjectId } from "@bigbud/contracts";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";
import { SortableProjectItem } from "./SidebarProjectItem";
import { readNativeApi } from "../../rpc/nativeApi";
import { useStore } from "../../stores/main";
import {
  loadAllProjectCatalog,
  loadMoreProjectCatalog,
} from "../../routes/-__root.bounded-bootstrap";

const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

export interface RenderedProject {
  project: { id: ProjectId };
  [key: string]: unknown;
}

interface SidebarProjectListProps {
  renderedProjects: RenderedProject[];
  isManualSorting: boolean;
  hasProjects: boolean;
  showEmptyState: boolean;
  showLoadMore?: boolean;
  catalogScope: ProjectCatalogScope;
  onDragStart: (event: DragStartEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: (event: DragCancelEvent) => void;
  renderProjectItem: (project: RenderedProject, dragHandleProps: unknown) => ReactNode;
}

export function SidebarProjectList({
  renderedProjects,
  isManualSorting,
  hasProjects,
  showEmptyState,
  showLoadMore = false,
  catalogScope,
  onDragStart,
  onDragEnd,
  onDragCancel,
  renderProjectItem,
}: SidebarProjectListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }
    return closestCorners(args);
  }, []);

  const projectCatalogCursor = useStore((state) => state.projectCatalogCursorByScope[catalogScope]);
  const projectCatalogLoading = useStore(
    (state) => state.projectCatalogLoadingByScope[catalogScope],
  );
  const projectCatalogRemainingCount = useStore(
    (state) => state.projectCatalogRemainingCountByScope[catalogScope],
  );
  const projectCatalogError = useStore((state) => state.projectCatalogErrorByScope[catalogScope]);
  const retryCatalogHead = useStore((state) => state.projectCatalogRetryHeadByScope[catalogScope]);
  const hasMoreProjects =
    retryCatalogHead || (projectCatalogCursor !== null && projectCatalogCursor !== undefined);
  const loadMoreCount = Math.min(5, projectCatalogRemainingCount ?? 5);
  const animatedListsRef = useRef(new WeakSet<HTMLElement>());
  const attachAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedListsRef.current.add(node);
  }, []);

  return (
    <>
      {isManualSorting ? (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SidebarMenu>
            <SortableContext
              items={renderedProjects.map((rp) => rp.project.id)}
              strategy={verticalListSortingStrategy}
            >
              {renderedProjects.map((rp) => (
                <SortableProjectItem key={rp.project.id} projectId={rp.project.id}>
                  {(dragHandleProps) => renderProjectItem(rp, dragHandleProps)}
                </SortableProjectItem>
              ))}
            </SortableContext>
          </SidebarMenu>
        </DndContext>
      ) : (
        <SidebarMenu ref={attachAutoAnimateRef}>
          {renderedProjects.map((rp) => (
            <SidebarMenuItem key={rp.project.id} className="rounded-md">
              {renderProjectItem(rp, null)}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}

      {showLoadMore && hasMoreProjects ? (
        <div className="grid gap-1 px-2 pt-2">
          <button
            type="button"
            className="h-6 w-full rounded-md px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80 disabled:cursor-wait"
            disabled={projectCatalogLoading}
            onClick={() => {
              const api = readNativeApi();
              if (api)
                void loadMoreProjectCatalog({ api, scope: catalogScope }).catch(() => undefined);
            }}
          >
            {projectCatalogLoading
              ? "Loading projects..."
              : projectCatalogError
                ? "Retry loading projects"
                : `Load ${loadMoreCount} more project${loadMoreCount === 1 ? "" : "s"}`}
          </button>
          {projectCatalogRemainingCount !== null && projectCatalogRemainingCount > 5 ? (
            <button
              type="button"
              className="h-6 w-full rounded-md px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80 disabled:cursor-wait"
              disabled={projectCatalogLoading}
              onClick={() => {
                const api = readNativeApi();
                if (api)
                  void loadAllProjectCatalog({ api, scope: catalogScope }).catch(() => undefined);
              }}
            >
              {`Load all ${projectCatalogRemainingCount} projects`}
            </button>
          ) : null}
        </div>
      ) : null}

      {!hasProjects && showEmptyState ? (
        <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
          No projects yet
        </div>
      ) : null}
    </>
  );
}
