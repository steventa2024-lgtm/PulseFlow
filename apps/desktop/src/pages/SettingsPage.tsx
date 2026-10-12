import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@pulseflow/ui";
import { addRoot, createCredential, getSettings, listCredentials, patchSettings } from "../api";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const credentials = useQuery({ queryKey: ["credentials"], queryFn: listCredentials });
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("github");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState("");

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="font-medium">Privacy</h2>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.data?.telemetry ?? false}
            onChange={(event) => {
              void patchSettings({ telemetry: event.target.checked }).then(() => queryClient.invalidateQueries({ queryKey: ["settings"] }));
            }}
          />
          Send product telemetry (off by default; this build has no telemetry endpoint)
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.data?.backgroundExecution ?? false}
            onChange={(event) => {
              void patchSettings({ backgroundExecution: event.target.checked }).then(() => queryClient.invalidateQueries({ queryKey: ["settings"] }));
            }}
          />
          Keep local schedules running when the window closes. The computer still has to stay on.
        </label>
      </section>
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="font-medium">Approved folders</h2>
        <p className="mt-1 text-sm text-muted">Templates use the app demo, inbox, out, and backup folders. Add a personal folder only when you want a workflow to read it.</p>
        <ul className="mt-3 space-y-1 text-sm">
          {(settings.data?.roots ?? []).map((root) => (
            <li key={root}>{root}</li>
          ))}
        </ul>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void addRoot(folder)
              .then(() => {
                setFolder("");
                setMessage("Folder approved");
                void queryClient.invalidateQueries({ queryKey: ["settings"] });
              })
              .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not add folder"));
          }}
        >
          <input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="/absolute/folder" className="h-8 flex-1 rounded-xl border border-line bg-canvas px-3 text-sm" />
          <Button type="submit">Approve</Button>
        </form>
      </section>
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="font-medium">Credentials</h2>
        <p className="mt-1 text-sm text-muted">Secrets are encrypted with the local key. The list below never includes the secret value.</p>
        <ul className="mt-3 space-y-1 text-sm">
          {(credentials.data?.credentials ?? []).map((credential) => (
            <li key={credential.id}>
              {credential.name} · {credential.kind}
            </li>
          ))}
        </ul>
        <form
          className="mt-3 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createCredential({ name, kind, secret: { token: secret } })
              .then(() => {
                setSecret("");
                setMessage("Credential stored. The secret is not shown again.");
                void queryClient.invalidateQueries({ queryKey: ["credentials"] });
              })
              .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not store credential"));
          }}
        >
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" className="h-8 rounded-xl border border-line bg-canvas px-3 text-sm" />
          <select value={kind} onChange={(event) => setKind(event.target.value)} className="h-8 rounded-xl border border-line bg-canvas px-3 text-sm">
            {["github", "discord", "smtp", "telegram", "sheets"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <input value={secret} onChange={(event) => setSecret(event.target.value)} type="password" placeholder="Secret" className="h-8 rounded-xl border border-line bg-canvas px-3 text-sm" />
          <Button type="submit">Save credential</Button>
        </form>
      </section>
      {message && <p className="text-sm text-muted">{message}</p>}
    </main>
  );
}
