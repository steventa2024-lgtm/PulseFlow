import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Badge, Button } from "@pulseflow/ui";
import { listTemplates, runWorkflow } from "../api";
import { useState } from "react";

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: listTemplates });
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const items = (templates.data?.templates ?? []).filter((template) =>
    `${template.name} ${template.id} ${template.category}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-semibold">Templates</h1>
      <p className="mt-1 text-sm text-muted">Preinstalled graphs. Tier A runs offline. Tier B live mode stays disabled until you add a credential.</p>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search templates"
        className="mt-4 h-10 w-full max-w-md rounded-xl border border-line bg-panel px-3"
      />
      {message && <p className="mt-3 text-sm text-muted">{message}</p>}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {items.map((template) => (
          <article key={template.id} className="rounded-2xl border border-line bg-panel p-4">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">{template.name}</h2>
              <Badge tone={template.tier === "A" ? "ok" : "info"}>{template.tier}</Badge>
              <Badge>{template.difficulty}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted">{template.description}</p>
            <p className="mt-2 text-xs text-muted">
              {template.trigger} · {template.setupMinutes} min · {template.services.join(", ") || "No external service"}
            </p>
            <p className="mt-1 text-xs text-muted">{template.docs}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link className="inline-flex h-8 items-center rounded-xl border border-line px-3 text-sm" to={`/workflow/${template.workflowId}`}>
                Open
              </Link>
              <Button
                type="button"
                onClick={() => {
                  void runWorkflow(template.workflowId, "demo")
                    .then((result) => {
                      setMessage(`${template.id} demo ${result.result.state}`);
                      void queryClient.invalidateQueries({ queryKey: ["executions"] });
                    })
                    .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Demo failed"));
                }}
              >
                Try demo
              </Button>
              <Button
                type="button"
                disabled={template.tier === "B" && !template.liveAvailable}
                title={template.tier === "B" && !template.liveAvailable ? "Add the required credential in Settings before Run live" : "Run live"}
                onClick={() => {
                  void runWorkflow(template.workflowId, "live")
                    .then((result) => setMessage(`${template.id} live ${result.result.state}`))
                    .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Live run blocked"));
                }}
              >
                {template.tier === "B" && !template.liveAvailable ? "Run live (needs setup)" : "Run live"}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
