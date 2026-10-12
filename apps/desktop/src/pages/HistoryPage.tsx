import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { diffVersion, listExecutions, listVersions, restoreVersion } from "../api";
import { useState } from "react";
import { Button } from "@pulseflow/ui";

export function HistoryPage() {
  const executions = useQuery({ queryKey: ["executions"], queryFn: () => listExecutions() });
  const versions = useQuery({ queryKey: ["versions", "wf_a01"], queryFn: () => listVersions("wf_a01") });
  const [note, setNote] = useState("");
  const [diffText, setDiffText] = useState("");
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">History</h1>
      <p className="mt-1 text-sm text-muted">Executions stay in the local database after you close the window.</p>
      <ul className="mt-4 space-y-2">
        {(executions.data?.executions ?? []).map((execution) => (
          <li key={execution.id} className="rounded-xl border border-line bg-panel px-3 py-2 text-sm">
            <Link to={`/workflow/${execution.workflowId}`}>{execution.workflowId}</Link>
            <span className="mx-2 text-muted">{execution.state}</span>
            <span className="text-muted">{execution.queuedAt}</span>
            {execution.errorSummary && <span className="ml-2 text-[#FFB4B4]">{execution.errorSummary}</span>}
          </li>
        ))}
      </ul>
      <h2 className="mt-8 text-lg font-medium">Hello Automation versions</h2>
      <ul className="mt-3 space-y-2">
        {(versions.data?.versions ?? []).map((version) => (
          <li key={version.id} className="flex items-center gap-3 text-sm">
            <span>{version.createdAt}</span>
            <span className="text-muted">{version.note}</span>
            <Button
              type="button"
              onClick={() => {
                void diffVersion("wf_a01", version.id)
                  .then((result) => {
                    const diff = result.diff;
                    const lines = [
                      `Added nodes: ${diff.nodesAdded.join(", ") || "none"}`,
                      `Removed nodes: ${diff.nodesRemoved.join(", ") || "none"}`,
                      `Changed nodes: ${diff.nodesChanged.join(", ") || "none"}`,
                      `Added edges: ${diff.edgesAdded.join(", ") || "none"}`,
                      `Removed edges: ${diff.edgesRemoved.join(", ") || "none"}`,
                    ];
                    setDiffText(lines.join("\n"));
                    setNote(`Compared ${version.id} with the current draft`);
                  })
                  .catch((error: unknown) => setNote(error instanceof Error ? error.message : "Could not compare this version"));
              }}
            >
              Compare
            </Button>
            <Button
              type="button"
              onClick={() => {
                void restoreVersion("wf_a01", version.id).then(() => setNote(`Restored ${version.id} as a new draft version`));
              }}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
      {diffText && <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-line bg-panel p-3 text-sm">{diffText}</pre>}
      {note && <p className="mt-3 text-sm text-muted">{note}</p>}
    </main>
  );
}
