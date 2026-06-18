import { CheckIcon, CopyIcon } from "lucide-react";
import {
  Children,
  isValidElement,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { copyTextToClipboard } from "~/lib/clipboard/copyText";
import { cn } from "~/lib/utils";

import { resolveDiffThemeName } from "../../lib/diffRendering";
import { useTheme } from "../../hooks/useTheme";
import { openBrowserPanel } from "../../stores/browser/browserPanel.actions";
import { resolveMarkdownFileLinkTarget, rewriteMarkdownFileUriHref } from "../../utils/markdown";
import { SyntaxHighlightedCode } from "../chat/common/SyntaxHighlightedCode";
import { openChatFileTarget } from "../chat/common/chatFileTargets";

interface BaseMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  className?: string | undefined;
  preserveLineBreaks?: boolean;
  onFileContextMenu?: (input: {
    targetPath: string;
    workspaceRoot: string | undefined;
    kind: "file";
    x: number;
    y: number;
  }) => void;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    const onSuccess = (): void => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
      }
      setCopied(true);
      copiedTimerRef.current = setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 1200);
    };

    void copyTextToClipboard(code)
      .then(onSuccess)
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock leading-snug">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

/**
 * Convert single newlines to CommonMark hard breaks (two trailing spaces).
 * Double newlines (paragraph breaks) are left untouched.
 */
function addHardBreaks(text: string): string {
  // Match a character followed by a single newline that is not followed by another newline.
  return text.replace(/([^\n])\n(?!\n)/g, "$1  \n");
}

export const BaseMarkdown = memo(function BaseMarkdown({
  text,
  cwd,
  isStreaming = false,
  className,
  preserveLineBreaks = false,
  onFileContextMenu,
}: BaseMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);

  const markdownText = useMemo(
    () => (preserveLineBreaks ? addHardBreaks(text) : text),
    [preserveLineBreaks, text],
  );

  const markdownUrlTransform = useCallback(
    (href: string) => rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href),
    [],
  );

  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        if (!href) {
          return <a {...props} />;
        }
        const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
        if (!targetPath) {
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openBrowserPanel({ url: href });
              }}
            />
          );
        }

        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openChatFileTarget(targetPath, cwd);
            }}
            onContextMenu={
              onFileContextMenu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onFileContextMenu({
                      targetPath,
                      workspaceRoot: cwd,
                      kind: "file",
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }
                : undefined
            }
          />
        );
      },
      code({ node: _node, className: codeClassName, children, ...props }) {
        const inlineText = nodeToPlainText(children).trim();
        const targetPath = codeClassName ? null : resolveMarkdownFileLinkTarget(inlineText, cwd);
        if (!targetPath) {
          return (
            <code className={codeClassName} {...props}>
              {children}
            </code>
          );
        }

        return (
          <code
            className={cn(codeClassName, "cursor-pointer")}
            title="Double-click to open"
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openChatFileTarget(targetPath, cwd);
            }}
            onContextMenu={
              onFileContextMenu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onFileContextMenu({
                      targetPath,
                      workspaceRoot: cwd,
                      kind: "file",
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }
                : undefined
            }
            {...props}
          >
            {children}
          </code>
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <SyntaxHighlightedCode
              code={codeBlock.code}
              language={extractFenceLanguage(codeBlock.className)}
              themeName={diffThemeName}
              isStreaming={isStreaming}
              fallback={<pre {...props}>{children}</pre>}
            />
          </MarkdownCodeBlock>
        );
      },
    }),
    [cwd, diffThemeName, isStreaming, onFileContextMenu],
  );

  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {markdownText}
      </ReactMarkdown>
    </div>
  );
});

export default BaseMarkdown;
