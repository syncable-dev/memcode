import React, { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactFormat } from "../src/artifact-format";
import "./style.css";
import SelectionTools from "./selection";
import Annotations from "./annotations";
const Markdown = lazy(() => import("./markdown"));
const Word = lazy(() => import("./word"));
const Spreadsheet = lazy(() => import("./spreadsheet"));
const Presentation = lazy(() => import("./presentation"));
const PDF = lazy(() => import("./pdf"));
const Media = lazy(() => import("./media"));
const TextFile = lazy(() => import("./text"));
interface DocumentData {
  name: string;
  format: ArtifactFormat;
  bytes: ArrayBuffer;
  line?: number;
  /** It belongs to no task, so there is nothing to comment on. */
  readOnly?: boolean;
}
function App() {
  const [document, setDocument] = useState<DocumentData>(),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void (async () => {
      const metaResponse = await fetch("./__meta");
      if (!metaResponse.ok) throw Error("The saved artifact is unavailable.");
      const meta = await metaResponse.json();
      let bytes = new ArrayBuffer(0);
      if (!["pdf", "video", "audio", "image"].includes(meta.format)) {
        const response = await fetch("./__document");
        if (!response.ok) throw Error("Could not load this file.");
        bytes = await response.arrayBuffer();
        if (bytes.byteLength > 25_000_000)
          throw Error("This file exceeds the 25 MB text preview limit.");
      }
      if (["docx", "xlsx", "pptx"].includes(meta.format)) {
        const { inspectOfficeZip } = await import("./zip-limits");
        inspectOfficeZip(bytes);
      }
      if (live) {
        window.document.title = meta.name;
        setDocument({ ...meta, bytes });
      }
    })().catch((e) => {
      if (live) setError(e.message);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="loading">Opening saved output…</div>}>
        {error ? (
          <div role="alert" className="viewer-error">
            <h2>Couldn’t open this artifact.</h2>
            <p>{error}</p>
          </div>
        ) : !document ? (
          <div className="loading">Opening saved output…</div>
        ) : document.format === "markdown" ? (
          <Markdown bytes={document.bytes} />
        ) : document.format === "docx" ? (
          <Word bytes={document.bytes} />
        ) : document.format === "xlsx" ? (
          <Spreadsheet bytes={document.bytes} />
        ) : document.format === "pptx" ? (
          <Presentation bytes={document.bytes} />
        ) : document.format === "pdf" ? (
          <PDF />
        ) : document.format === "video" || document.format === "audio" ? (
          <Media format={document.format} name={document.name} />
        ) : document.format === "image" ? (
          <main className="image-viewer">
            <img src="./__document" alt={document.name} />
          </main>
        ) : document.format === "text" ? (
          <TextFile
            bytes={document.bytes}
            name={document.name}
            line={document.line}
          />
        ) : (
          <div className="viewer-error">
            <h2>Save this file in a modern format.</h2>
            <p>Use .docx, .xlsx or .pptx to preview it directly.</p>
          </div>
        )}
      </Suspense>
      {document && !document.readOnly && !error && <SelectionTools />}
      {document && !document.readOnly && !error && <Annotations />}
    </ErrorBoundary>
  );
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="viewer-error" role="alert">
        {this.state.error}
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(<App />);
