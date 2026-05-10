function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

export interface MarkdownTocItem {
  id: string;
  level: 2 | 3 | 4;
  title: string;
}

interface RenderedMarkdownSection {
  html: string;
  level?: number;
}

export interface RenderedMarkdown {
  introHtml: string;
  contentHtml: string;
  toc: MarkdownTocItem[];
}

function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|\/|#)/.test(href);
}

function isSafeImageSrc(src: string): boolean {
  return /^(https?:\/\/|\/|\.\/|\.\.\/)/.test(src);
}

function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function classAttr(className: string): string {
  return className.length > 0 ? ` class="${escapeAttribute(className)}"` : "";
}

function getHeadingClasses(level: number): string {
  if (level === 1) {
    return "md-heading md-heading--hero";
  }
  if (level === 2) {
    return "md-heading md-heading--section";
  }
  if (level === 3) {
    return "md-heading md-heading--subsection";
  }

  return "md-heading";
}

function getParagraphClasses(): string {
  return "md-paragraph";
}

function getListClasses(ordered: boolean): string {
  const listType = ordered ? "list-decimal" : "list-disc";
  return `md-list md-list--${ordered ? "ordered" : "unordered"} ${listType}`;
}

function getInlineCodeClasses(): string {
  return "markdown-inline-code";
}

function getBlockCodeClasses(): { pre: string; code: string } {
  return {
    pre: "md-code-block",
    code: "md-code",
  };
}

function getLinkClasses(): string {
  return "md-link";
}

function tokenizeInline(value: string): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  let text = value;

  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_, alt: string, src: string) => {
      const token = `%%TOKEN${tokens.length}%%`;
      tokens.push(renderImage(alt, src));
      return token;
    },
  );

  text = text.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = `%%TOKEN${tokens.length}%%`;
    tokens.push(`<code${classAttr(getInlineCodeClasses())}>${escapeHtml(code)}</code>`);
    return token;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => {
    const safeHref = href.trim();
    const token = `%%TOKEN${tokens.length}%%`;
    const linkLabel = escapeHtml(label.trim());

    if (!isSafeHref(safeHref)) {
      tokens.push(linkLabel);
      return token;
    }

    const attrs = safeHref.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : "";
    tokens.push(
      `<a href="${escapeAttribute(safeHref)}"${classAttr(getLinkClasses())}${attrs}>${linkLabel}</a>`,
    );
    return token;
  });

  return { text, tokens };
}

function restoreTokens(value: string, tokens: string[]): string {
  return value.replace(/%%TOKEN(\d+)%%/g, (_, index: string) => tokens[Number(index)] ?? "");
}

function renderInline(value: string): string {
  const { text, tokens } = tokenizeInline(value);
  let rendered = escapeHtml(text);

  rendered = rendered
    .replace(/\*\*([^*]+)\*\*/g, `<strong${classAttr("md-strong")}>$1</strong>`)
    .replace(/__([^_]+)__/g, `<strong${classAttr("md-strong")}>$1</strong>`)
    .replace(/\*([^*]+)\*/g, `<em${classAttr("italic")}>$1</em>`)
    .replace(/_([^_]+)_/g, `<em${classAttr("italic")}>$1</em>`);

  return restoreTokens(rendered, tokens);
}

function renderParagraph(lines: string[]): string {
  return `<p${classAttr(getParagraphClasses())}>${renderInline(lines.join(" "))}</p>`;
}

function renderList(lines: string[], ordered: boolean): string {
  const tag = ordered ? "ol" : "ul";
  const itemClasses = "md-list-item";
  const items = lines
    .map((line) => {
      const content = ordered ? line.replace(/^\d+\.\s+/, "") : line.replace(/^-\s+/, "");
      return `<li${classAttr(itemClasses)}>${renderInline(content)}</li>`;
    })
    .join("");

  return `<${tag}${classAttr(getListClasses(ordered))}>${items}</${tag}>`;
}

function renderCodeBlock(lines: string[]): string {
  const classes = getBlockCodeClasses();
  return `<pre${classAttr(classes.pre)}><code${classAttr(classes.code)}>${escapeHtml(lines.join("\n"))}</code></pre>`;
}

function renderImage(rawAlt: string, rawSrc: string): string {
  const src = rawSrc.trim();
  const alt = rawAlt.trim();

  if (!isSafeImageSrc(src)) {
    return "";
  }

  return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" loading="lazy" decoding="async"${classAttr("md-image")} />`;
}

function isListLine(line: string): boolean {
  return /^-\s+/.test(line) || /^\d+\.\s+/.test(line);
}

function isOrderedListLine(line: string): boolean {
  return /^\d+\.\s+/.test(line);
}

function parseImageLine(line: string): { alt: string; src: string } | undefined {
  const imageMatch = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(line);
  if (!imageMatch) {
    return undefined;
  }

  return { alt: imageMatch[1], src: imageMatch[2] };
}

function renderHeading(
  rawTitle: string,
  level: number,
  slugCounts: Map<string, number>,
): { html: string; tocItem?: MarkdownTocItem } {
  const baseSlug = slugifyHeading(rawTitle) || `section-${level}`;
  const duplicateCount = slugCounts.get(baseSlug) ?? 0;
  slugCounts.set(baseSlug, duplicateCount + 1);
  const id = duplicateCount === 0 ? baseSlug : `${baseSlug}-${duplicateCount + 1}`;
  const html = `<h${level} id="${escapeAttribute(id)}"${classAttr(getHeadingClasses(level))}>${renderInline(rawTitle)}</h${level}>`;

  if (level >= 2 && level <= 4) {
    return {
      html,
      tocItem: {
        id,
        level: level as 2 | 3 | 4,
        title: rawTitle.replace(/[`*_]/g, "").trim(),
      },
    };
  }

  return { html };
}

export function renderMarkdown(markdown: string): RenderedMarkdown {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: RenderedMarkdownSection[] = [];
  const toc: MarkdownTocItem[] = [];
  const slugCounts = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trimEnd() ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      for (index += 1; index < lines.length; index += 1) {
        const nextLine = lines[index] ?? "";
        if (nextLine.trim().startsWith("```")) {
          break;
        }
        codeLines.push(nextLine);
      }
      sections.push({ html: renderCodeBlock(codeLines) });
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const renderedHeading = renderHeading(headingMatch[2], level, slugCounts);
      sections.push({ html: renderedHeading.html, level });
      if (renderedHeading.tocItem) {
        toc.push(renderedHeading.tocItem);
      }
      continue;
    }

    const image = parseImageLine(trimmed);
    if (image) {
      sections.push({ html: renderImage(image.alt, image.src) });
      continue;
    }

    if (isListLine(trimmed)) {
      const ordered = isOrderedListLine(trimmed);
      const listLines = [trimmed];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1]?.trim() ?? "";
        if (
          nextLine.length === 0 ||
          !isListLine(nextLine) ||
          isOrderedListLine(nextLine) !== ordered
        ) {
          break;
        }
        listLines.push(nextLine);
        index += 1;
      }
      sections.push({ html: renderList(listLines, ordered) });
      continue;
    }

    const paragraphLines = [trimmed];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1]?.trim() ?? "";
      if (
        nextLine.length === 0 ||
        nextLine.startsWith("```") ||
        /^(#{1,6})\s+/.test(nextLine) ||
        parseImageLine(nextLine) !== undefined ||
        isListLine(nextLine)
      ) {
        break;
      }
      paragraphLines.push(nextLine);
      index += 1;
    }

    sections.push({ html: renderParagraph(paragraphLines) });
  }

  const firstH2Index = sections.findIndex((section) => section.level === 2);
  const introSections =
    firstH2Index === -1 ? sections : sections.slice(0, Math.max(1, firstH2Index));
  const contentSections = firstH2Index === -1 ? [] : sections.slice(firstH2Index);

  return {
    introHtml: introSections.map((section) => section.html).join(""),
    contentHtml: contentSections.map((section) => section.html).join(""),
    toc,
  };
}
