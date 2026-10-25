import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceTemperatures } from "./ResourceTemperatures";
import { ResourceTemperatureContent } from "./ResourceTemperatureContent";
import { hottestTemperature } from "./ResourceTemperatures.logic";
import { sensorMetric, temperatureSnapshot } from "./ResourceTemperatures.fixtures";

describe("compact temperature sensor grid", () => {
  it("keeps native labels and exact readings with one hottest badge and one threshold-availability note", () => {
    const snapshot = temperatureSnapshot();
    const markup = renderToStaticMarkup(
      <ResourceTemperatures snapshot={snapshot} history={{}} current loading={false} />,
    );
    expect(markup).toContain("Hottest: 62.81 °C");
    expect(markup).toContain('title="PMU tdev3"');
    expect(markup).toContain("61.64 °C");
    expect(markup).toContain("37.00 °C");
    expect(markup.match(/Some sensors do not report critical thresholds/g)).toHaveLength(1);
    expect(markup).not.toContain("Critical: unavailable");
    expect(markup).not.toContain("text-destructive");
    expect(markup).not.toContain('role="meter"');
    for (const sensor of snapshot.temperaturesCelsius)
      expect(markup).toContain(`aria-label="Expand ${sensor.name} temperature sensor"`);
  });
  it("sorts only by name without mutating samples or guessing CPU sensor aliases", () => {
    const snapshot = temperatureSnapshot();
    const markup = renderToStaticMarkup(
      <ResourceTemperatures snapshot={snapshot} history={{}} current loading={false} />,
    );
    expect(markup.indexOf("gas gauge battery temperature sensor")).toBeLessThan(
      markup.indexOf("PMU tdev3 temperature sensor"),
    );
    expect(snapshot.temperaturesCelsius[0]!.name).toBe("PMU TP2g");
    expect(markup).not.toContain("CPU temperature");
  });
  it("takes the hottest fresh finite sample, including negative temperatures and zero", () => {
    const sensors = [
      { name: "cold", metric: sensorMetric(-20) },
      { name: "zero", metric: sensorMetric(0) },
      { name: "bad", metric: sensorMetric(NaN) },
      { name: "stale", metric: sensorMetric(300, "stale") },
    ];
    expect(hottestTemperature(sensors, true)).toEqual({ name: "zero", value: 0 });
    expect(hottestTemperature(sensors, false)).toBeUndefined();
    expect(hottestTemperature([{ name: "cold", metric: sensorMetric(-20) }], true)).toEqual({
      name: "cold",
      value: -20,
    });
  });
  it.each([undefined, sensorMetric(0, "unavailable"), sensorMetric(0, "stale"), sensorMetric(NaN)])(
    "does not infer critical colors from an unavailable threshold (%s)",
    (critical) => {
      const markup = renderToStaticMarkup(
        <ResourceTemperatureContent
          sensor={{ name: "hot", metric: sensorMetric(110) }}
          critical={critical}
          history={[]}
          current
          loading={false}
          expanded
        />,
      );
      expect(markup).not.toContain("text-destructive");
      expect(markup).not.toContain("Reported critical threshold reached");
      expect(markup).toContain("Critical threshold");
      expect(markup).toContain("Unavailable");
    },
  );
  it("marks a reached reported threshold, including genuine zero, without treating temperatures as percentages", () => {
    const markup = renderToStaticMarkup(
      <ResourceTemperatureContent
        sensor={{ name: "sensor", metric: sensorMetric(0) }}
        critical={sensorMetric(0)}
        history={[]}
        current
        loading={false}
        expanded
      />,
    );
    expect(markup).toContain("text-destructive");
    expect(markup).toContain("0.00 °C, critical threshold reached");
    expect(markup).toContain("Reported critical threshold reached");
    expect(markup).not.toContain("%");
  });
  it("does not show retained readings, hottest values or old critical alarms while disconnected", () => {
    const markup = renderToStaticMarkup(
      <ResourceTemperatures
        snapshot={temperatureSnapshot()}
        history={{}}
        current={false}
        loading={false}
      />,
    );
    expect(markup).toContain("Hottest: —");
    expect(markup).not.toContain("61.64 °C");
    expect(markup).not.toContain("text-destructive");
    expect(markup).not.toContain('data-loading="true"');
  });
  it("uses centered pending and unsupported states for an empty sensor list", () => {
    const waiting = renderToStaticMarkup(
      <ResourceTemperatures snapshot={null} history={{}} current={false} loading />,
    );
    expect(waiting).toContain("Waiting for temperature sensors");
    expect(waiting).toContain('data-loading="true"');
    const unavailable = renderToStaticMarkup(
      <ResourceTemperatures
        snapshot={{ ...temperatureSnapshot(), temperaturesCelsius: [] }}
        history={{}}
        current
        loading={false}
      />,
    );
    expect(unavailable).toContain("No supported temperature sensor reported");
    expect(unavailable).not.toContain('data-loading="true"');
  });
});
