import { Sector } from "recharts";
import type { PieSectorShapeProps } from "recharts/types/polar/Pie";

/** Highlight bigbud's slice with the raised rim from the interactive pie design. */
export function renderCapacitySector({
  index,
  isActive,
  outerRadius = 0,
  ...props
}: PieSectorShapeProps) {
  const sector = {
    cx: props.cx,
    cy: props.cy,
    innerRadius: props.innerRadius,
    startAngle: props.startAngle,
    endAngle: props.endAngle,
    fill: props.fill,
    stroke: props.stroke,
    strokeWidth: props.strokeWidth,
  };
  const highlighted = index === 0 || isActive;
  return (
    <g data-recharts-item-index={index} data-recharts-item-id={props["data-recharts-item-id"]}>
      <Sector {...sector} outerRadius={outerRadius + (highlighted ? 3 : 0)} />
      {highlighted ? (
        <Sector {...sector} outerRadius={outerRadius + 9} innerRadius={outerRadius + 5} />
      ) : null}
    </g>
  );
}
