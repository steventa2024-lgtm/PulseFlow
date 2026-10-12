import type { FieldSchema, NodeManifest, WorkflowGraph } from "@pulseflow/contracts";
import type { Issue } from "../api";

const suggestions = ["$json", "$paths", "$now", "$index", "$services", "$node", "upper", "lower", "concat", "json", "slice", "len"];

export function Inspector({
  graph,
  nodeId,
  manifest,
  issues,
  onChange,
  onTest,
  testMessage,
}: {
  graph: WorkflowGraph;
  nodeId?: string;
  manifest?: NodeManifest;
  issues: Issue[];
  onChange: (parameters: Record<string, unknown>, name: string) => void;
  onTest: () => void;
  testMessage?: string;
}) {
  const node = graph.nodes.find((item) => item.id === nodeId);
  const nodeIssues = issues.filter((issue) => issue.nodeId === node?.id);
  return (
    <aside className="flex min-h-0 flex-col border-l border-line bg-panel">
      <div className="border-b border-line px-3 py-2 text-xs font-semibold tracking-wide text-muted">INSPECTOR</div>
      {!node || !manifest ? (
        <p className="p-4 text-sm text-muted">Select a node to edit its parameters. Drag a node from the library to add it.</p>
      ) : (
        <form
          className="min-h-0 flex-1 space-y-3 overflow-auto p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onTest();
          }}
        >
          <label className="block text-sm">
            <span className="text-muted">Name</span>
            <input
              value={node.name ?? manifest.title}
              onChange={(event) => onChange(node.parameters, event.target.value)}
              className="mt-1 h-8 w-full rounded-xl border border-line bg-canvas px-3"
            />
          </label>
          {manifest.fields.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={node.parameters[field.key]}
              onChange={(value) => onChange({ ...node.parameters, [field.key]: value }, node.name ?? manifest.title)}
            />
          ))}
          {manifest.permissions.length > 0 && (
            <p className="text-xs text-muted">Permissions: {manifest.permissions.join(", ")}</p>
          )}
          {manifest.dangerous && (
            <p className="rounded-xl bg-[#3A3118] px-3 py-2 text-xs text-[#F5D48A]">
              This node is off until the workflow sets allowShell and the confirmation text. It is not a security sandbox.
            </p>
          )}
          {nodeIssues.map((issue) => (
            <p key={issue.message} className="text-xs text-[#FFB4B4]">
              {issue.message}
            </p>
          ))}
          <button type="submit" className="h-8 rounded-xl border border-line px-3 text-sm hover:border-accent">
            Test node
          </button>
          {testMessage && <p className="text-xs text-muted">{testMessage}</p>}
        </form>
      )}
    </aside>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FieldSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const common = "mt-1 w-full rounded-xl border border-line bg-canvas px-3 text-sm";
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        {field.label}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="block text-sm">
        <span className="text-muted">{field.label}</span>
        <select className={`${common} h-8`} value={String(value ?? field.default ?? "")} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.type === "json" || field.type === "text" || field.type === "expression") {
    return (
      <label className="block text-sm">
        <span className="text-muted">{field.label}</span>
        <textarea
          className={`${common} min-h-20 py-2`}
          value={typeof value === "string" ? value : JSON.stringify(value ?? field.default ?? "", null, 2)}
          onChange={(event) => onChange(field.type === "json" ? parseJson(event.target.value) : event.target.value)}
        />
        {field.type === "expression" && (
          <span className="mt-1 block text-xs text-muted">Suggestions: {suggestions.join(", ")}</span>
        )}
        {field.help && <span className="mt-1 block text-xs text-muted">{field.help}</span>}
      </label>
    );
  }
  return (
    <label className="block text-sm">
      <span className="text-muted">{field.label}</span>
      <input
        className={`${common} h-8`}
        type={field.type === "number" ? "number" : "text"}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
      />
    </label>
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
