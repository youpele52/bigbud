import DOMPurify from "dompurify";

import { ansiToHtml, type OutputRendering } from "./IpynbPreview.logic";

export function OutputArea({ output }: { output: OutputRendering }) {
  if (output.kind === "stream") {
    return (
      <pre
        className="notebook-output-stream m-0 whitespace-pre-wrap font-mono text-xs leading-5 text-foreground/80"
        dangerouslySetInnerHTML={{ __html: ansiToHtml(output.text ?? "") }}
      />
    );
  }

  if (output.kind === "error") {
    return (
      <div className="notebook-output-error bg-destructive/10 text-destructive/90 font-mono text-xs leading-5 whitespace-pre-wrap">
        {(output.traceback ?? []).map((line, i) => {
          const key = line.length > 0 ? line.slice(0, 60) : `tb-empty-${i}`;
          return <div key={key}>{line}</div>;
        })}
        {output.errorName ? (
          <div>
            {output.errorName}: {output.errorValue ?? ""}
          </div>
        ) : null}
      </div>
    );
  }

  if (output.kind === "html") {
    const sanitized = DOMPurify.sanitize(output.html ?? "", { USE_PROFILES: { html: true } });
    return (
      <div
        className="notebook-output-html text-sm"
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  if (output.kind === "image") {
    return (
      <div className="notebook-output-image">
        <img src={output.imageSrc} alt="Cell output" className="max-w-full" />
      </div>
    );
  }

  if (output.kind === "svg") {
    return (
      <div
        className="notebook-output-svg [&>svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: output.svgContent ?? "" }}
      />
    );
  }

  if (output.kind === "text") {
    return (
      <pre className="notebook-output-text m-0 whitespace-pre-wrap font-mono text-xs leading-5 text-foreground/85">
        {output.text}
      </pre>
    );
  }

  return null;
}
