import { describe, expect, it } from "vitest";
import type { ComposerAnnotationAttachment } from "../../../stores/composer";

import {
  appendBrowserAnnotationsToPrompt,
  buildTerminalAnnotationPrompt,
} from "./ChatView.annotations.logic";

describe("appendBrowserAnnotationsToPrompt", () => {
  it("appends full annotation metadata without requiring composer prompt text", () => {
    const annotation: ComposerAnnotationAttachment = {
      id: "annotation-1",
      imageId: "image-1",
      comment: "Fix this button",
      intent: "fix",
      page: { title: "Dashboard", url: "https://example.com/dashboard" },
      element: {
        selector: "#save",
        tag: "button",
        role: "button",
        text: "Save",
        ariaLabel: "Save changes",
        id: "save",
        className: "primary",
        rect: { x: 10, y: 20, width: 100, height: 32 },
      },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      createdAt: "2026-05-02T00:00:00.000Z",
    };

    expect(appendBrowserAnnotationsToPrompt("", [annotation])).toContain(
      "User instruction:\nFix this button",
    );
    expect(appendBrowserAnnotationsToPrompt("Please inspect", [annotation])).toContain(
      "Please inspect\n\nBrowser annotation",
    );
  });

  it("uses coding framing for fix intent", () => {
    const annotation: ComposerAnnotationAttachment = {
      id: "annotation-1",
      imageId: "image-1",
      comment: "Fix this",
      intent: "fix",
      page: { title: "Dashboard", url: "https://example.com/dashboard" },
      element: {
        selector: "#save",
        tag: "button",
        role: "button",
        text: "Save",
        ariaLabel: null,
        id: "save",
        className: "primary",
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      createdAt: "2026-05-02T00:00:00.000Z",
    };

    const prompt = appendBrowserAnnotationsToPrompt("", [annotation]);
    expect(prompt).toContain("make the appropriate code change");
  });

  it("uses contextual framing for context intent", () => {
    const annotation: ComposerAnnotationAttachment = {
      id: "annotation-1",
      imageId: "image-1",
      comment: "",
      intent: "context",
      page: { title: "Dashboard", url: "https://example.com/dashboard" },
      element: {
        selector: "#save",
        tag: "button",
        role: "button",
        text: "Save",
        ariaLabel: null,
        id: "save",
        className: "primary",
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      createdAt: "2026-05-02T00:00:00.000Z",
    };

    const prompt = appendBrowserAnnotationsToPrompt("", [annotation]);
    expect(prompt).toContain("Refer to the attached screenshot");
    expect(prompt).not.toContain("code change");
  });

  it("falls back when a browser annotation comment is missing at runtime", () => {
    const annotation = {
      id: "annotation-1",
      imageId: "image-1",
      comment: undefined,
      intent: "context",
      page: { title: "Dashboard", url: "https://example.com/dashboard" },
      element: {
        selector: "#save",
        tag: "button",
        role: "button",
        text: "Save",
        ariaLabel: null,
        id: "save",
        className: "primary",
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      createdAt: "2026-05-02T00:00:00.000Z",
    } as unknown as ComposerAnnotationAttachment;

    const prompt = appendBrowserAnnotationsToPrompt("", [annotation]);
    expect(prompt).toContain("User instruction:\n(no instruction provided)");
  });

  it("falls back when browser annotation element metadata is missing at runtime", () => {
    const annotation = {
      id: "annotation-1",
      imageId: "image-1",
      comment: "Check this",
      intent: "context",
      page: undefined,
      element: undefined,
      viewport: undefined,
      createdAt: "2026-05-02T00:00:00.000Z",
    } as unknown as ComposerAnnotationAttachment;

    const prompt = appendBrowserAnnotationsToPrompt("", [annotation]);
    expect(prompt).toContain("Selector: ");
    expect(prompt).toContain("Tag: unknown");
    expect(prompt).toContain("Viewport: width=0 height=0 devicePixelRatio=0");
  });

  it("omits framing for ask intent", () => {
    const annotation: ComposerAnnotationAttachment = {
      id: "annotation-1",
      imageId: "image-1",
      comment: "What does this do?",
      intent: "ask",
      page: { title: "Dashboard", url: "https://example.com/dashboard" },
      element: {
        selector: "#save",
        tag: "button",
        role: "button",
        text: "Save",
        ariaLabel: null,
        id: "save",
        className: "primary",
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      createdAt: "2026-05-02T00:00:00.000Z",
    };

    const prompt = appendBrowserAnnotationsToPrompt("", [annotation]);
    expect(prompt).not.toContain("Refer to the attached screenshot");
    expect(prompt).not.toContain("code change");
    expect(prompt).toContain("What does this do?");
  });

  it("uses neutral comment framing for comment intent", () => {
    const annotation: ComposerAnnotationAttachment = {
      id: "annotation-1",
      imageId: "image-1",
      comment: "Should this stay as-is?",
      intent: "comment",
      page: { title: "Dashboard", url: "https://example.com/dashboard" },
      element: {
        selector: "#save",
        tag: "button",
        role: "button",
        text: "Save",
        ariaLabel: null,
        id: "save",
        className: "primary",
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      createdAt: "2026-05-02T00:00:00.000Z",
    };

    const prompt = appendBrowserAnnotationsToPrompt("", [annotation]);
    expect(prompt).toContain("If the comment asks for a change, make it.");
    expect(prompt).toContain("If it asks a question, answer it.");
  });

  it("appends code annotation file and selected line context", () => {
    const annotation: ComposerAnnotationAttachment = {
      id: "code-annotation-1",
      kind: "code",
      comment: "Extract this into a helper",
      intent: "fix",
      createdAt: "2026-06-02T00:00:00.000Z",
      file: {
        projectName: "bigbud",
        cwd: "/Users/youpele/DevWorld/bigbud",
        relativePath: "apps/web/src/main.ts",
      },
      selection: {
        startLine: 20,
        endLine: 22,
        text: "const value = createValue();",
      },
    };

    const prompt = appendBrowserAnnotationsToPrompt("Please update", [annotation]);
    expect(prompt).toContain("Code annotation");
    expect(prompt).toContain("Project: bigbud");
    expect(prompt).toContain("Path: apps/web/src/main.ts");
    expect(prompt).toContain("Lines: 20-22");
    expect(prompt).toContain("const value = createValue();");
    expect(prompt).toContain("make the appropriate code change");
  });

  it("appends terminal annotation metadata and selected output", () => {
    const annotation = {
      id: "terminal-annotation-1",
      kind: "terminal" as const,
      comment: "Why did this fail?",
      intent: "ask" as const,
      createdAt: "2026-06-23T00:00:00.000Z",
      terminal: {
        terminalId: "terminal-1",
        terminalLabel: "Terminal 1",
      },
      selection: {
        startLine: 12,
        endLine: 13,
        text: "error: build failed\nexit code 1",
      },
    };

    const prompt = appendBrowserAnnotationsToPrompt("Please inspect", [annotation]);
    expect(prompt).toContain("Terminal annotation");
    expect(prompt).toContain("Label: Terminal 1");
    expect(prompt).toContain("ID: terminal-1");
    expect(prompt).toContain("Lines: 12-13");
    expect(prompt).toContain("error: build failed");
    expect(prompt).not.toContain("make the appropriate code change");
  });

  it("uses terminal fix framing for fix intent", () => {
    const prompt = buildTerminalAnnotationPrompt({
      id: "terminal-annotation-1",
      kind: "terminal",
      comment: "Fix the build",
      intent: "fix",
      createdAt: "2026-06-23T00:00:00.000Z",
      terminal: {
        terminalId: "terminal-1",
        terminalLabel: "Terminal 1",
      },
      selection: {
        startLine: 4,
        endLine: 4,
        text: "npm ERR! missing script: test",
      },
    });

    expect(prompt).toContain("make the appropriate change");
    expect(prompt).toContain("Line: 4");
  });

  it("uses terminal comment framing for comment intent", () => {
    const prompt = buildTerminalAnnotationPrompt({
      id: "terminal-annotation-1",
      kind: "terminal",
      comment: "Should we retry this?",
      intent: "comment",
      createdAt: "2026-06-23T00:00:00.000Z",
      terminal: {
        terminalId: "terminal-1",
        terminalLabel: "Terminal 1",
      },
      selection: {
        startLine: 4,
        endLine: 4,
        text: "npm ERR! missing script: test",
      },
    });

    expect(prompt).toContain("If the comment asks for a change, make it.");
    expect(prompt).toContain("If it asks a question, answer it.");
  });
});
