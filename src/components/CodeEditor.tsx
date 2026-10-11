import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";

// Monaco resolves its workers through this global. The `?worker` imports make
// vite bundle each one as a same-origin chunk, so the editor is fully offline
// — nothing is fetched from a CDN, which matters because the app runs on
// disconnected networks. JSON gets its own language worker (validation,
// folding); XML has no language service, so the base editor worker covers it.
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === "json" ? new JsonWorker() : new EditorWorker()
};

interface Props {
  value: string;
  language: "xml" | "json";
  /** Omit for a read-only viewer. */
  onChange?: (value: string) => void;
  className?: string;
}

/** A Monaco editor/viewer for the request, response and GeoJSON documents. */
export default function CodeEditor({ value, language, onChange, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // The editor is created once; the handler is read through a ref so a
  // re-render does not mean tearing the whole thing down.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language,
      theme: "vs-dark",
      readOnly: !onChange,
      domReadOnly: !onChange,
      automaticLayout: true,
      minimap: { enabled: false },
      wordWrap: "on",
      fontSize: 12,
      tabSize: 2,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true
    });
    editor.onDidChangeModelContent(() => onChangeRef.current?.(editor.getValue()));
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt outside changes — a regenerated request, a polygon drawn on the map —
  // without echoing the editor's own keystrokes back into it (that would move
  // the caret).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  return (
    <div ref={hostRef} dir="ltr" className={`xml-editor${className ? ` ${className}` : ""}`} />
  );
}
