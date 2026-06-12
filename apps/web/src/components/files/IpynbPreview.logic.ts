export interface NotebookCell {
  cell_type: string;
  source: string[] | string;
  outputs?: NotebookOutput[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

export interface NotebookOutput {
  output_type: string;
  name?: string;
  text?: string[] | string;
  data?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookJson {
  cells: NotebookCell[];
  metadata?: { kernelspec?: { language?: string } };
  nbformat: number;
  nbformat_minor: number;
}

export function parseNotebook(contents: string): NotebookJson {
  return JSON.parse(contents) as NotebookJson;
}

export function detectNotebookLanguage(notebook: NotebookJson): string {
  const lang = notebook?.metadata?.kernelspec?.language;
  if (typeof lang === "string" && lang.length > 0) return lang;
  return "python";
}

export function cellSource(cell: NotebookCell): string {
  const source = cell.source;
  if (typeof source === "string") return source;
  return (source ?? []).join("");
}

export function getNotebookFlatSource(notebook: NotebookJson): string {
  const parts: string[] = [];

  for (let ci = 0; ci < notebook.cells.length; ci++) {
    const cell = notebook.cells[ci];
    if (!cell) continue;
    if (parts.length > 0) parts.push("\n");
    parts.push(cellSource(cell));
  }

  return parts.join("");
}

function outputText(output: NotebookOutput): string {
  const text = output.text;
  if (typeof text === "string") return text;
  return (text ?? []).join("");
}

function outputData(output: NotebookOutput): Record<string, unknown> {
  return output.data ?? {};
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001b\[([\d;]*)m/g;

function ansiCodeToStyle(code: string): string {
  const parts = code.split(";").map(Number);
  const styles: string[] = [];

  for (const part of parts) {
    switch (part) {
      case 1:
        styles.push("font-weight:bold");
        break;
      case 3:
        styles.push("font-style:italic");
        break;
      case 4:
        styles.push("text-decoration:underline");
        break;
      case 30:
        styles.push("color:#1e1e1e");
        break;
      case 31:
        styles.push("color:#cd3131");
        break;
      case 32:
        styles.push("color:#0dbc79");
        break;
      case 33:
        styles.push("color:#e5e510");
        break;
      case 34:
        styles.push("color:#2472c8");
        break;
      case 35:
        styles.push("color:#bc3fbc");
        break;
      case 36:
        styles.push("color:#11a8cd");
        break;
      case 37:
        styles.push("color:#e5e5e5");
        break;
      case 90:
        styles.push("color:#666666");
        break;
      case 91:
        styles.push("color:#ff6666");
        break;
      case 92:
        styles.push("color:#66ff66");
        break;
      case 93:
        styles.push("color:#ffff66");
        break;
      case 94:
        styles.push("color:#6699ff");
        break;
      case 95:
        styles.push("color:#ff66ff");
        break;
      case 96:
        styles.push("color:#66ffff");
        break;
      case 97:
        styles.push("color:#ffffff");
        break;
    }
  }

  return styles.join(";");
}

export function ansiToHtml(text: string): string {
  let result = "";
  let lastIndex = 0;
  let openSpan = false;

  for (const match of text.matchAll(ANSI_REGEX)) {
    const before = text
      .slice(lastIndex, match.index!)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    result += before;

    if (openSpan) {
      result += "</span>";
      openSpan = false;
    }

    if (match[1] !== "" && match[1] !== "0") {
      const style = ansiCodeToStyle(match[1] ?? "");
      if (style) {
        result += `<span style="${style}">`;
        openSpan = true;
      }
    }

    lastIndex = match.index! + match[0].length;
  }

  const remaining = text
    .slice(lastIndex)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  result += remaining;

  if (openSpan) {
    result += "</span>";
  }

  return result;
}

export interface OutputRendering {
  kind: "text" | "html" | "image" | "svg" | "error" | "stream";
  text?: string;
  html?: string;
  imageSrc?: string;
  imageType?: string;
  svgContent?: string;
  streamName?: string | undefined;
  errorName?: string | undefined;
  errorValue?: string | undefined;
  traceback?: string[] | undefined;
}

export function renderOutput(output: NotebookOutput): OutputRendering | null {
  const outputType = output.output_type;

  if (outputType === "stream") {
    return {
      kind: "stream",
      text: outputText(output),
      streamName: output.name,
    };
  }

  if (outputType === "error") {
    return {
      kind: "error",
      errorName: output.ename,
      errorValue: output.evalue,
      traceback: output.traceback,
    };
  }

  if (outputType === "display_data" || outputType === "execute_result") {
    const data = outputData(output);
    const mimeKeys = Object.keys(data);

    if (mimeKeys.includes("text/html")) {
      const htmlParts = data["text/html"];
      const html = Array.isArray(htmlParts) ? htmlParts.join("") : String(htmlParts ?? "");
      return { kind: "html", html };
    }

    if (mimeKeys.includes("image/svg+xml")) {
      const svgParts = data["image/svg+xml"];
      const svgContent = Array.isArray(svgParts) ? svgParts.join("") : String(svgParts ?? "");
      return { kind: "svg", svgContent };
    }

    if (mimeKeys.includes("image/png")) {
      return {
        kind: "image",
        imageSrc: `data:image/png;base64,${String(data["image/png"] ?? "")}`,
        imageType: "png",
      };
    }

    if (mimeKeys.includes("image/jpeg")) {
      return {
        kind: "image",
        imageSrc: `data:image/jpeg;base64,${String(data["image/jpeg"] ?? "")}`,
        imageType: "jpeg",
      };
    }

    if (mimeKeys.includes("image/gif")) {
      return {
        kind: "image",
        imageSrc: `data:image/gif;base64,${String(data["image/gif"] ?? "")}`,
        imageType: "gif",
      };
    }

    if (mimeKeys.includes("text/plain")) {
      const textParts = data["text/plain"];
      const text = Array.isArray(textParts) ? textParts.join("") : String(textParts ?? "");
      return { kind: "text", text };
    }

    return null;
  }

  return null;
}
