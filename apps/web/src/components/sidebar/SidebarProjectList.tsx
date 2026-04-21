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
import { type ProjectId } from "@bigbud/contracts";
import { Spinner } from "../ui/spinner";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";
import { SortableProjectItem } from "./SidebarProjectItem";

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
  bootstrapComplete: boolean;
  hasProjects: boolean;
  showEmptyState: boolean;
  onDragStart: (event: DragStartEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: (event: DragCancelEvent) => void;
  renderProjectItem: (project: RenderedProject, dragHandleProps: unknown) => ReactNode;
}

export function SidebarProjectList({
  renderedProjects,
  isManualSorting,
  bootstrapComplete,
  hasProjects,
  showEmptyState,
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

      {!bootstrapComplete ? (
        <div className="flex justify-center px-2 pt-6">
          <Spinner className="size-4 text-muted-foreground/40" />
        </div>
      ) : !hasProjects && showEmptyState ? (
        <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
          No projects yet
        </div>
      ) : null}
    </>
  );
}
