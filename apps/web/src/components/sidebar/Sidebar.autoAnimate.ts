import { autoAnimate, type AnimationController } from "@formkit/auto-animate";
import { useCallback, useEffect, useRef } from "react";

const SIDEBAR_AUTO_ANIMATE_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

/** Attaches one AutoAnimate controller and tears it down when its ref changes or unmounts. */
export function useSidebarAutoAnimateRef(): (node: HTMLElement | null) => void {
  const controllerRef = useRef<AnimationController | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);

  const destroy = useCallback(() => {
    controllerRef.current?.destroy?.();
    controllerRef.current = null;
    nodeRef.current = null;
  }, []);

  const attach = useCallback(
    (node: HTMLElement | null) => {
      if (node === nodeRef.current) {
        return;
      }
      destroy();
      if (!node) {
        return;
      }
      nodeRef.current = node;
      controllerRef.current = autoAnimate(node, SIDEBAR_AUTO_ANIMATE_OPTIONS);
    },
    [destroy],
  );

  useEffect(() => destroy, [destroy]);

  return attach;
}
