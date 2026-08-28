import { describe, expect, it } from "vitest";

import { markDevinCredentialsVerified, parseDevinVersionOutput } from "./Provider.about.ts";

describe("Devin provider authentication", () => {
  it("keeps a version-only probe unverified", () => {
    expect(parseDevinVersionOutput({ code: 0, stdout: "v1.2.3", stderr: "" }).auth.status).toBe(
      "unknown",
    );
  });

  it("marks credentials authenticated only after a successful ACP discovery", () => {
    const versionProbe = parseDevinVersionOutput({ code: 0, stdout: "v1.2.3", stderr: "" });
    expect(markDevinCredentialsVerified(versionProbe).auth.status).toBe("authenticated");
  });
});
