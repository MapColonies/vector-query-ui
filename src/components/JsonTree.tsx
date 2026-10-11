import { useState, type ReactNode } from "react";

interface Props {
  /** JSON text. Anything unparseable is shown as-is. */
  code: string;
  className?: string;
}

/**
 * Syntax-highlighted JSON with collapsible objects and arrays — for feature
 * documents, whose coordinate arrays otherwise bury the properties.
 */
export default function JsonTree({ code, className }: Props) {
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch {
    value = undefined;
  }

  return (
    <div className={`code-view json-tree mono${className ? ` ${className}` : ""}`} dir="ltr">
      {value === undefined ? code : <JsonNode value={value} />}
    </div>
  );
}

const isPrimitive = (v: unknown) => v === null || typeof v !== "object";

function Leaf({ value }: { value: unknown }) {
  if (value === null || typeof value === "boolean") {
    return <span className="tok-bool">{String(value)}</span>;
  }
  if (typeof value === "number") return <span className="tok-num">{String(value)}</span>;
  return <span className="tok-str">{JSON.stringify(value)}</span>;
}

function JsonNode({ value, trailing }: { value: unknown; trailing?: ReactNode }) {
  if (isPrimitive(value)) {
    return (
      <span>
        <Leaf value={value} />
        {trailing}
      </span>
    );
  }
  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [i, v] as const)
    : Object.entries(value as Record<string, unknown>);

  // A flat array of primitives — a coordinate pair, a list of ids — reads
  // better on one line than as one line per number.
  if (isArray && (value as unknown[]).every(isPrimitive)) {
    return (
      <span>
        <span className="tok-punc">[</span>
        {(value as unknown[]).map((v, i) => (
          <span key={i}>
            {i > 0 && <span className="tok-punc">, </span>}
            <Leaf value={v} />
          </span>
        ))}
        <span className="tok-punc">]</span>
        {trailing}
      </span>
    );
  }

  return (
    <Container
      brackets={isArray ? "[]" : "{}"}
      keyed={!isArray}
      entries={entries}
      trailing={trailing}
    />
  );
}

function Container({
  brackets,
  keyed,
  entries,
  trailing
}: {
  brackets: "{}" | "[]";
  keyed: boolean;
  entries: readonly (readonly [string | number, unknown])[];
  trailing?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, close] = brackets;

  if (entries.length === 0) {
    return (
      <span>
        <span className="tok-punc">{open + close}</span>
        {trailing}
      </span>
    );
  }

  if (collapsed) {
    return (
      <span>
        <button
          type="button"
          className="json-toggle"
          aria-label="Expand"
          onClick={() => setCollapsed(false)}
        >
          ▸
        </button>
        <span className="tok-punc">{open}</span>
        <button type="button" className="json-ellipsis" onClick={() => setCollapsed(false)}>
          … {entries.length} {keyed ? (entries.length === 1 ? "key" : "keys") : "items"} …
        </button>
        <span className="tok-punc">{close}</span>
        {trailing}
      </span>
    );
  }

  return (
    <span>
      <button
        type="button"
        className="json-toggle"
        aria-label="Collapse"
        onClick={() => setCollapsed(true)}
      >
        ▾
      </button>
      <span className="tok-punc">{open}</span>
      {entries.map(([key, v], i) => (
        <div className="json-row" key={key}>
          {keyed && (
            <>
              <span className="tok-key">{JSON.stringify(String(key))}</span>
              <span className="tok-punc">: </span>
            </>
          )}
          <JsonNode
            value={v}
            trailing={i < entries.length - 1 ? <span className="tok-punc">,</span> : undefined}
          />
        </div>
      ))}
      <span className="tok-punc">{close}</span>
      {trailing}
    </span>
  );
}
