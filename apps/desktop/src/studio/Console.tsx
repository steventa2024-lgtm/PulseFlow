import { useState } from "react";
import type { ExecutionRecord, StepRecord } from "../api";

const tabs = ["Timeline", "Node IO", "Logs", "Errors", "History"] as const;

export function Console({
  execution,
  steps,
  history,
  collapsed,
  onToggle,
  onOpenExecution,
  onOpenFile,
}: {
  execution?: ExecutionRecord;
  steps: StepRecord[];
  history: ExecutionRecord[];
  collapsed: boolean;
  onToggle: () => void;
  onOpenExecution: (id: string) => void;
  onOpenFile: (name: string) => void;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Timeline");
  const errors = steps.filter((step) => step.errorMessage);
  return (
    <section className={`studio-console flex flex-col border-t border-line bg-panel ${collapsed ? "h-10" : ""}`}>
      <div className="flex h-10 items-center gap-2 px-3">
        <span className="text-xs font-semibold tracking-wide text-muted">EXECUTION CONSOLE</span>
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            className={`rounded-lg px-2 py-1 text-xs ${tab === item ? "bg-panel-2 text-ink" : "text-muted"}`}
            onClick={() => {
              setTab(item);
              if (collapsed) onToggle();
            }}
          >
            {item}
          </button>
        ))}
        <button type="button" className="ml-auto text-xs text-muted" onClick={onToggle}>
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 text-xs">
          {tab === "Timeline" && (
            <ol className="space-y-1">
              {steps.length === 0 && <li className="text-muted">Run the workflow to see a real trace.</li>}
              {steps.map((step) => (
                <li key={step.id} className="grid grid-cols-[140px_120px_1fr] gap-2">
                  <span>{step.nodeId}</span>
                  <span className={step.state === "failed" ? "text-[#FFB4B4]" : "text-ok"}>{step.state}</span>
                  <span className="text-muted">{step.startedAt ?? ""}</span>
                </li>
              ))}
            </ol>
          )}
          {tab === "Node IO" && (
            <pre className="whitespace-pre-wrap text-muted">{JSON.stringify(steps.map((step) => ({ node: step.nodeId, input: step.input, output: step.output })), null, 2)}</pre>
          )}
          {tab === "Logs" && (
            <pre className="whitespace-pre-wrap text-muted">{JSON.stringify(steps.flatMap((step) => step.logs ?? []), null, 2)}</pre>
          )}
          {tab === "Errors" && (
            <ul>
              {errors.length === 0 && <li className="text-muted">{execution?.errorSummary ?? "No errors in this run."}</li>}
              {errors.map((step) => (
                <li key={step.id}>
                  {step.nodeId}: {step.errorMessage}
                </li>
              ))}
            </ul>
          )}
          {tab === "History" && (
            <ul className="space-y-1">
              {history.map((item) => (
                <li key={item.id}>
                  <button type="button" className="text-left hover:text-accent" onClick={() => onOpenExecution(item.id)}>
                    {item.queuedAt} · {item.state} · {item.id}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {execution && (
            <button type="button" className="mt-2 text-accent" onClick={() => onOpenFile("hello-automation.json")}>
              Open demo output
            </button>
          )}
        </div>
      )}
    </section>
  );
}
