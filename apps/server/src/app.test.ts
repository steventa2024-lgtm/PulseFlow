import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptJson } from "@pulseflow/security";
import { buildApp, signatureFor } from "./app";
import { createHost } from "./host";

describe("local API", () => {
  it("runs A01, keeps history, and hides secrets", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pulseflow-api-"));
    const host = await createHost(home);
    const app = await buildApp(host);
    const headers = { authorization: `Bearer ${host.token}` };

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const denied = await app.inject({ method: "GET", url: "/api/v1/workflows" });
    expect(denied.statusCode).toBe(401);

    const session = await app.inject({ method: "GET", url: "/api/v1/session" });
    const cookie = String(session.headers["set-cookie"]);
    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/wf_a01/run",
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(forged.statusCode).toBe(401);

    const run = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/wf_a01/run",
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    const body = run.json() as { result: { state: string; executionId: string } };
    expect(body.result.state).toBe("succeeded");
    const output = JSON.parse(readFileSync(path.join(home, "demo", "hello-automation.json"), "utf8")) as { greeting: string };
    expect(output.greeting).toBe("Hello, PulseFlow");

    const history = await app.inject({ method: "GET", url: "/api/v1/executions?workflowId=wf_a01", headers });
    expect(history.json().executions.length).toBeGreaterThan(0);

    const secret = "super-secret-token";
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: { ...headers, "content-type": "application/json" },
      payload: { name: "GitHub", kind: "github", secret: { token: secret } },
    });
    expect(created.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: "/api/v1/credentials", headers });
    expect(listed.body).not.toContain(secret);
    expect(listed.json().credentials[0].kind).toBe("github");

    const live = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/wf_b06/run",
      headers: { ...headers, "content-type": "application/json" },
      payload: { mode: "live" },
    });
    expect(live.statusCode).toBe(409);

    const demo = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/wf_b02/run",
      headers: { ...headers, "content-type": "application/json" },
      payload: { mode: "demo" },
    });
    expect(demo.statusCode).toBe(200);
    expect(demo.json().result.state).toBe("succeeded");

    const activated = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/wf_a10/activate",
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
    expect(activated.statusCode).toBe(200);
    const hook = activated.json().webhooks[0] as { id: string; secret: string };
    const payload = JSON.stringify({ message: "hello" });
    const accepted = await app.inject({
      method: "POST",
      url: `/hooks/${hook.id}`,
      headers: {
        "content-type": "application/json",
        "x-pulseflow-signature": signatureFor(hook.secret, payload),
      },
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    const rejected = await app.inject({
      method: "POST",
      url: `/hooks/${hook.id}`,
      headers: { "content-type": "application/json", "x-pulseflow-signature": "nope" },
      payload,
    });
    expect(rejected.statusCode).toBe(401);

    const polluted = await app.inject({
      method: "POST",
      url: "/api/v1/import",
      headers: { ...headers, "content-type": "application/json" },
      payload:
        '{"schemaVersion":1,"kind":"pulseflow.bundle","exportedAt":"2026-10-12T00:00:00.000Z","workflows":[{"name":"Imported","graph":{"schemaVersion":1,"nodes":[{"id":"manual","manifestId":"trigger.manual","manifestVersion":"1.0.0","position":{"x":0,"y":0},"parameters":{"__proto__":{"admin":true}}}],"edges":[]}}]}',
    });
    expect(polluted.statusCode).toBe(200);
    const importedId = polluted.json().workflows[0].id as string;
    const stored = host.store.getWorkflow(importedId);
    expect(stored?.draftGraph.nodes[0] && Object.hasOwn(stored.draftGraph.nodes[0].parameters, "__proto__")).toBe(false);

    const backup = await app.inject({
      method: "POST",
      url: "/api/v1/backup",
      headers: { ...headers, "content-type": "application/json" },
      payload: { passphrase: "correct horse" },
    });
    expect(backup.statusCode).toBe(200);
    const saved = backup.json() as { path: string; encrypted: boolean; keyIncluded: boolean };
    expect(saved.encrypted).toBe(true);
    expect(saved.keyIncluded).toBe(false);
    const blob = JSON.parse(readFileSync(saved.path, "utf8")) as { salt: string; ciphertext: string; iv: string; tag: string };
    const key = scryptSync("correct horse", blob.salt, 32);
    const decoded = decryptJson(blob, key) as { database: string };
    expect(decoded.database.length).toBeGreaterThan(10);

    await app.close();
    await host.close();
  });
});
