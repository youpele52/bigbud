import { useEffect, useId, useRef, type ComponentProps, type CSSProperties } from "react";

import {
  AGENT_WORKING_BLOB_DEFAULT_SIZE,
  AGENT_WORKING_BLOB_TONES,
  type AgentWorkingBlobColors,
  type AgentWorkingBlobTone,
} from "~/constants/agentWorkingBlob";
import { usePrefersReducedMotion } from "~/hooks/usePrefersReducedMotion";
import { cn } from "~/lib/utils";
import {
  BLOB_VIEWBOX,
  clampBlobSize,
  createBlobMotion,
  isBlobSettled,
  layoutBlob,
  stepBlobMotion,
  toSvgId,
  type BlobLayout,
  type BlobMotion,
} from "./agent-working-blob.logic";
import { observeBlobVisibility, subscribeBlobFrames } from "./agent-working-blob.ticker";

export type AgentWorkingBlobState = "working" | "done";

export interface AgentWorkingBlobProps extends Omit<
  ComponentProps<"svg">,
  "children" | "width" | "height" | "viewBox" | "colors"
> {
  state?: AgentWorkingBlobState;
  /** CSS pixels; clamped to a minimum so it still fits inline, with no maximum. */
  size?: number;
  /** Preset colours; `colors` overrides individual entries. */
  tone?: AgentWorkingBlobTone;
  colors?: Partial<AgentWorkingBlobColors>;
}

const STOP_OFFSETS = [0, 0.38, 0.62, 1] as const;

function applyLayout(svg: SVGSVGElement, layout: BlobLayout): void {
  const circles = svg.querySelectorAll<SVGCircleElement>("[data-blob-drop]");
  const drops = [layout.core, ...layout.satellites];
  circles.forEach((circle, index) => {
    const drop = drops[index];
    if (!drop) return;
    circle.setAttribute("cx", drop.cx.toFixed(2));
    circle.setAttribute("cy", drop.cy.toFixed(2));
    circle.setAttribute("r", drop.r.toFixed(2));
  });
  const sheen = svg.querySelector<SVGEllipseElement>("[data-blob-sheen]");
  sheen?.setAttribute("cx", layout.sheen.cx.toFixed(2));
  sheen?.setAttribute("cy", layout.sheen.cy.toFixed(2));
}

/**
 * Liquid "agent is working" loader: droplets split from and melt back into a core while the colour
 * quietly shifts; when done they merge into one glowing drop. Every instance shares one animation
 * loop and sits idle while off screen, settled, or when the OS asks for reduced motion.
 */
export function AgentWorkingBlob({
  state = "working",
  size = AGENT_WORKING_BLOB_DEFAULT_SIZE,
  tone = "agent",
  colors,
  className,
  style,
  ...props
}: AgentWorkingBlobProps) {
  const id = toSvgId(useId());
  const svgRef = useRef<SVGSVGElement>(null);
  const motionRef = useRef<BlobMotion | null>(null);
  motionRef.current ??= createBlobMotion(state === "done");
  const reducedMotion = usePrefersReducedMotion();
  const palette = { ...AGENT_WORKING_BLOB_TONES[tone], ...colors };
  const targetMerge = state === "done" ? 1 : 0;
  const pixelSize = clampBlobSize(size);
  const initialLayout = layoutBlob(motionRef.current, 0, false);

  useEffect(() => {
    const svg = svgRef.current;
    const motion = motionRef.current;
    if (!svg || !motion) return;
    if (reducedMotion) {
      motion.merge = targetMerge;
      svg.style.setProperty("--agent-blob-mix", "1");
      applyLayout(svg, layoutBlob(motion, 0, false));
      return;
    }
    if (isBlobSettled(motion, targetMerge)) return;

    let unsubscribe: (() => void) | null = null;
    const stopFrames = () => {
      unsubscribe?.();
      unsubscribe = null;
    };
    const stopObserving = observeBlobVisibility(svg, (visible) => {
      if (!visible) return stopFrames();
      unsubscribe ??= subscribeBlobFrames((frame) => {
        stepBlobMotion(motion, frame.dt, targetMerge);
        svg.style.setProperty("--agent-blob-mix", frame.mix.toFixed(3));
        applyLayout(svg, layoutBlob(motion, frame.time, true));
        // a settled drop is static; leave the shared loop until the state changes again
        if (isBlobSettled(motion, targetMerge)) stopFrames();
      });
    });
    return () => {
      stopObserving();
      stopFrames();
    };
  }, [reducedMotion, targetMerge]);

  const cssVars = {
    "--agent-blob-working": palette.working,
    "--agent-blob-shift": palette.shift ?? palette.working,
    "--agent-blob-done": palette.done,
    "--agent-blob-glow-size": `${Math.max(2, pixelSize * 0.3).toFixed(1)}px`,
    ...style,
  } as CSSProperties;

  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      data-agent-working-blob=""
      data-state={state}
      viewBox={`0 0 ${BLOB_VIEWBOX} ${BLOB_VIEWBOX}`}
      width={pixelSize}
      height={pixelSize}
      className={cn("agent-working-blob", className)}
      style={cssVars}
      {...props}
    >
      <defs>
        <filter id={`${id}-goo`} filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10" />
        </filter>
        <linearGradient
          id={`${id}-fill`}
          gradientUnits="userSpaceOnUse"
          x1="18"
          y1="12"
          x2="82"
          y2="88"
        >
          {STOP_OFFSETS.map((offset, index) => (
            <stop key={offset} offset={offset} className={`agent-blob-stop-${index}`} />
          ))}
        </linearGradient>
        <radialGradient id={`${id}-sheen`}>
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        {/* blur + alpha threshold on a mask, so one shared gradient fills the merged shape */}
        <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <g filter={`url(#${id}-goo)`} fill="#fff">
            {[initialLayout.core, ...initialLayout.satellites].map((drop) => (
              <circle key={drop.id} data-blob-drop="" cx={drop.cx} cy={drop.cy} r={drop.r} />
            ))}
          </g>
        </mask>
      </defs>
      <g mask={`url(#${id}-mask)`}>
        <rect width="100" height="100" fill={`url(#${id}-fill)`} />
        <ellipse
          data-blob-sheen=""
          className="agent-blob-sheen"
          cx={initialLayout.sheen.cx}
          cy={initialLayout.sheen.cy}
          rx="16"
          ry="10"
          fill={`url(#${id}-sheen)`}
        />
      </g>
    </svg>
  );
}
