import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { listExecutions, listVersions, restoreVersion } from "../api";
import { useState } from "react";
import { Button } from "@pulseflow/ui";

export function HistoryPage() {
  const executions = useQuery({ queryKey: ["executions"], queryFn: () => listExecutions() });
  const versions = useQuery({ queryKey: ["versions", "wf_a01"], queryFn: () => listVersions("wf_a01") });
  const [note, setNote] = useState("");
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
                void restoreVersion("wf_a01", version.id).then(() => setNote(`Restored ${version.id} as a new draft version`));
              }}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
      {note && <p className="mt-3 text-sm text-muted">{note}</p>}
    </main>
  );
}
