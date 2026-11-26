import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_CONTROL_TEMPLATE_DIR,
  renderAgentControlTemplates,
} from "./remoteAgentControl.templates.ts";

const directory = fileURLToPath(
  new URL(`../../../../${AGENT_CONTROL_TEMPLATE_DIR}/`, import.meta.url),
);

describe("U25 owner agent-control templates", () => {
  const rendered = renderAgentControlTemplates();

  it("are exactly the checked-in owner templates (regenerate with agent-control:templates)", () => {
    const files = readdirSync(directory).filter((name) => name.endsWith(".sh"));
    expect(files.toSorted()).toEqual([...rendered.keys()].toSorted());
    for (const [name, text] of rendered) {
      expect(readFileSync(`${directory}${name}`, "utf8"), name).toBe(text);
    }
  });

  it("bind every operand through the header and leave no sentinel behind", () => {
    for (const [name, text] of rendered) {
      expect(text, name).not.toMatch(/bbsent|5e175e17|987654321/);
      const arity = Number(/^\[ "\$#" -eq (\d+) \] \|\| exit 64$/m.exec(text)?.[1]);
      expect(Number.isInteger(arity), name).toBe(true);
      for (let index = 1; index <= arity; index += 1) {
        expect(text, name).toContain(`="\${${index}}"`);
      }
    }
  });

  it("read streamed bytes raw instead of from base64 script text", () => {
    expect(rendered.get("install_upload.reserved.sh")).toContain('cat > "$staged"');
    expect(rendered.get("install_upload.reserved.sh")).not.toContain("base64 --decode");
    const cas = rendered.get("registry_cas.present.sh")!;
    expect(cas).toContain('head -c "$bigbud_arg_expected_size" > "$expected"');
    expect(cas).toContain('cat > "$next"');
    expect(cas.indexOf('> "$expected"')).toBeLessThan(cas.indexOf('cat > "$next"'));
  });

  it("refuse a runtime outside the canonical layout before the legacy body runs", () => {
    const shutdown = rendered.get("supervisor_shutdown.sh")!;
    expect(shutdown.indexOf("exit 86")).toBeLessThan(shutdown.indexOf("--shutdown-supervisor"));
    expect(shutdown).toContain('"$bigbud_arg_root/runtimes/$bigbud_arg_generation"');
  });
});
