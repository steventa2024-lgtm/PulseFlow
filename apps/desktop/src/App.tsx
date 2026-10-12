import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { bootstrapSession, getSettings } from "./api";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { StudioPage } from "./studio/StudioPage";

export function App() {
  const location = useLocation();
  const session = useQuery({ queryKey: ["session"], queryFn: bootstrapSession });
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, enabled: session.isSuccess });

  if (session.isLoading) {
    return <p className="p-8 text-muted">Connecting to the local engine…</p>;
  }
  if (session.isError) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">PulseFlow is not running</h1>
        <p className="mt-3 text-muted">Start the local API with <code>pnpm dev</code> and open this page again. No account is required.</p>
      </main>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Routes>
        <Route path="/" element={<Navigate to="/workflow/wf_a01" replace />} />
        <Route path="/workflow/:workflowId" element={<StudioPage tutorialDismissed={settings.data?.tutorialDismissed ?? false} />} />
        <Route
          path="/templates"
          element={
            <Shell location={location.pathname}>
              <TemplatesPage />
            </Shell>
          }
        />
        <Route
          path="/history"
          element={
            <Shell location={location.pathname}>
              <HistoryPage />
            </Shell>
          }
        />
        <Route
          path="/settings"
          element={
            <Shell location={location.pathname}>
              <SettingsPage />
            </Shell>
          }
        />
        <Route path="*" element={<Navigate to="/workflow/wf_a01" replace />} />
      </Routes>
    </div>
  );
}

function Shell({ children, location }: { children: ReactNode; location: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 items-center gap-4 border-b border-line bg-panel px-4">
        <Link to="/workflow/wf_a01" className="font-semibold tracking-tight">
          PulseFlow
        </Link>
        <nav className="flex gap-3 text-sm text-muted">
          <Link className={location.startsWith("/workflow") ? "text-ink" : ""} to="/workflow/wf_a01">
            Studio
          </Link>
          <Link className={location === "/templates" ? "text-ink" : ""} to="/templates">
            Templates
          </Link>
          <Link className={location === "/history" ? "text-ink" : ""} to="/history">
            History
          </Link>
          <Link className={location === "/settings" ? "text-ink" : ""} to="/settings">
            Settings
          </Link>
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
