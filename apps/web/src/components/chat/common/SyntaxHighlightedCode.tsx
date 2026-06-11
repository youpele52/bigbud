import { getSharedHighlighter } from "@pierre/diffs";
import type { DiffsHighlighter, SupportedLanguages } from "@pierre/diffs";
import React, { Suspense, use, useEffect, useMemo, type ReactNode } from "react";

import { resolveDiffThemeName, type DiffThemeName } from "../../../lib/diffRendering";
import { fnv1a32 } from "../../../lib/diffRendering";
import { LRUCache } from "../../../lib/lruCache";

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function createHighlightCacheKey(
  code: string,
  language: string,
  themeName: DiffThemeName,
  bgTransparent?: boolean,
): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}${bgTransparent ? ":tb" : ""}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      throw err;
    }
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function RenderedHighlightedCode({
  html,
  className,
}: {
  html: string;
  className?: string | undefined;
}) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki renders trusted syntax-highlighted HTML.
    <div
      className={`chat-markdown-shiki${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function RenderedShikiCodeBlock(props: {
  cacheKey: string;
  code: string;
  isStreaming: boolean;
  language: string;
  themeName: DiffThemeName;
  className?: string | undefined;
  bgTransparent?: boolean | undefined;
}) {
  const highlighter = use(getHighlighterPromise(props.language));
  const highlightedHtml = useMemo(() => {
    let html: string;
    try {
      html = highlighter.codeToHtml(props.code, { lang: props.language, theme: props.themeName });
    } catch (error) {
      console.warn(
        `Code highlighting failed for language "${props.language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      html = highlighter.codeToHtml(props.code, { lang: "text", theme: props.themeName });
    }
    if (props.bgTransparent) {
      html = html.replace(/background-color:[^;]+;?/, "");
    }
    return html;
  }, [highlighter, props.code, props.language, props.themeName, props.bgTransparent]);

  useEffect(() => {
    if (!props.isStreaming) {
      highlightedCodeCache.set(
        props.cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, props.code),
      );
    }
  }, [highlightedHtml, props.cacheKey, props.code, props.isStreaming]);

  return <RenderedHighlightedCode html={highlightedHtml} className={props.className} />;
}

function SuspenseShikiCodeBlock(props: {
  code: string;
  language: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
  className?: string | undefined;
  bgTransparent?: boolean | undefined;
}) {
  const cacheKey = createHighlightCacheKey(
    props.code,
    props.language,
    props.themeName,
    props.bgTransparent,
  );
  const cachedHighlightedHtml = !props.isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return <RenderedHighlightedCode html={cachedHighlightedHtml} className={props.className} />;
  }

  return <RenderedShikiCodeBlock cacheKey={cacheKey} {...props} />;
}

export function SyntaxHighlightedCode(props: {
  code: string;
  language: string;
  themeName: DiffThemeName;
  isStreaming?: boolean;
  fallback: ReactNode;
  className?: string | undefined;
  bgTransparent?: boolean | undefined;
}) {
  return (
    <CodeHighlightErrorBoundary fallback={props.fallback}>
      <Suspense fallback={props.fallback}>
        <SuspenseShikiCodeBlock
          code={props.code}
          language={props.language}
          themeName={props.themeName}
          isStreaming={props.isStreaming ?? false}
          className={props.className}
          bgTransparent={props.bgTransparent}
        />
      </Suspense>
    </CodeHighlightErrorBoundary>
  );
}
