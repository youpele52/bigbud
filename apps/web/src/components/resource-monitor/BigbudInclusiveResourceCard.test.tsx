import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_APP_HISTORY } from "~/stores/resource-monitor/resourceMonitor.appHistory";
import { BigbudInclusiveResourceCard } from "./BigbudInclusiveResourceCard";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";

const app = appMonitorSnapshot().appResources!;
const history = {
  ...EMPTY_APP_HISTORY,
  inclusiveCpu: [
    { sequence: 1, value: 10 },
    { sequence: 2, value: 18.4 },
  ],
  inclusiveMemory: [
    { sequence: 1, value: 1024 ** 3 },
    { sequence: 2, value: 2 * 1024 ** 3 },
  ],
};

describe("inclusive usage card", () => {
  it("shows independent CPU and memory charts with current values and process count", () => {
    const markup = renderToStaticMarkup(
      <BigbudInclusiveResourceCard app={app} history={history} />,
    );
    expect(markup).toContain('aria-label="Including agents/tools CPU history"');
    expect(markup).toContain('aria-label="Including agents/tools Memory history"');
    expect(markup).toContain("18.40%");
    expect(markup).toContain("2.00 GiB");
    expect(markup).toContain("20 processes");
  });
  it("reserves chart space while fresh history warms up", () => {
    const markup = renderToStaticMarkup(
      <BigbudInclusiveResourceCard app={app} history={EMPTY_APP_HISTORY} />,
    );
    expect(markup.match(/Waiting for history/g)).toHaveLength(2);
    expect(markup).not.toContain('role="img"');
  });
  it.each([undefined, { ...app, incomplete: true }])(
    "does not chart unavailable or incomplete totals",
    (resources) => {
      const markup = renderToStaticMarkup(
        <BigbudInclusiveResourceCard app={resources} history={history} />,
      );
      expect(markup).not.toContain('role="img"');
      if (!resources) expect(markup.match(/Measurements unavailable/g)).toHaveLength(2);
    },
  );
  it("does not replace an unavailable CPU value with a zero or conceal available memory", () => {
    const inclusive = { ...app.inclusive };
    delete inclusive.cpuPercent;
    const resources = { ...app, inclusive };
    const markup = renderToStaticMarkup(
      <BigbudInclusiveResourceCard app={resources} history={history} />,
    );
    expect(markup).not.toContain('aria-label="Including agents/tools CPU history"');
    expect(markup).toContain('aria-label="Including agents/tools Memory history"');
    expect(markup).toContain("Measurements unavailable");
  });
});
