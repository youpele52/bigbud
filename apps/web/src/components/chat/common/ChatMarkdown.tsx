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
import { openPathInPreferredApp } from "../../../models/editor";
import { resolveDiffThemeName } from "../../../lib/diffRendering";
import { useTheme } from "../../../hooks/useTheme";
import { openBrowserPanel } from "../../../stores/browser/browserPanel.actions";
import { resolveMarkdownFileLinkTarget, rewriteMarkdownFileUriHref } from "../../../utils/markdown";
import { readNativeApi } from "../../../rpc/nativeApi";
import { cn } from "~/lib/utils";
import { SyntaxHighlightedCode } from "./SyntaxHighlightedCode";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  className?: string;
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

    if (typeof window !== "undefined" && window.desktopBridge?.copyToClipboard) {
      void window.desktopBridge
        .copyToClipboard(code)
        .then(onSuccess)
        .catch(() => undefined);
      return;
    }

    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
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

function openChatPath(targetPath: string): void {
  const api = readNativeApi();
  if (api) {
    void openPathInPreferredApp(api, targetPath);
  } else {
    console.warn("Native API not found. Unable to open file.");
  }
}

function ChatMarkdown({ text, cwd, isStreaming = false, className }: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownUrlTransform = useCallback((href: string) => {
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
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
              openChatPath(targetPath);
            }}
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
              openChatPath(targetPath);
            }}
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
    [cwd, diffThemeName, isStreaming],
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
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
