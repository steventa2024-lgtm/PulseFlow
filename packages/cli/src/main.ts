import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createId, parseBundle, parseGraph } from "@pulseflow/contracts";
import { validateGraph } from "@pulseflow/engine";
import { randomToken, sha256Hex } from "@pulseflow/security";
import { templates, workflowIdFor } from "@pulseflow/templates";
import { buildApp, createHost, defaultHome } from "@pulseflow/server";

const [command, ...args] = process.argv.slice(2);
const home = process.env.PULSEFLOW_HOME ?? defaultHome();

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function run(): Promise<void> {
  if (!command || command === "help" || command === "--help") {
    console.log(`PulseFlow CLI

  doctor
  serve [--port 8787]
  run <workflowId> [--mode production|demo|live] [--payload file.json]
  validate <workflowId>
  export <workflowId> [--out file.json]
  import <file.json>
  templates
  backup [--passphrase text]
  migrate
  token <name>
`);
    return;
  }
  if (command === "templates") {
    for (const template of templates) {
      console.log(`${template.id}\t${template.tier}\t${template.name}\t${workflowIdFor(template.id)}`);
    }
    return;
  }
  const host = await createHost(home);
  try {
    if (command === "doctor") {
      console.log(JSON.stringify({
        ok: true,
        node: process.version,
        home,
        workflows: host.store.countWorkflows(),
        templates: templates.length,
        telemetry: host.store.getSetting("telemetry", false),
        sqlite: "node:sqlite",
      }, null, 2));
      return;
    }
    if (command === "migrate") {
      console.log(JSON.stringify({ ok: true, home, workflows: host.store.countWorkflows() }));
      return;
    }
    if (command === "serve") {
      const portFlag = args.indexOf("--port");
      const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.PULSEFLOW_PORT ?? 8787);
      const app = await buildApp(host);
      await app.listen({ host: "127.0.0.1", port });
      console.log(`PulseFlow listening on http://127.0.0.1:${port}`);
      await new Promise(() => undefined);
    }
    if (command === "run") {
      const workflowId = required(args[0], "workflow id");
      const mode = option(args, "--mode") ?? "production";
      const payloadFile = option(args, "--payload");
      const payload = payloadFile ? JSON.parse(readFileSync(payloadFile, "utf8")) as unknown : undefined;
      if (mode !== "production" && mode !== "demo" && mode !== "debug" && mode !== "live") throw new Error("Unknown mode");
      const result = await host.engine.runWorkflow(workflowId, { mode, payload });
      console.log(JSON.stringify({ ...result, steps: host.store.listSteps(result.executionId).map((step) => ({ nodeId: step.nodeId, state: step.state })) }, null, 2));
      if (result.state !== "succeeded" && result.state !== "waiting") process.exitCode = 1;
      return;
    }
    if (command === "validate") {
      const workflow = host.store.getWorkflow(required(args[0], "workflow id"));
      if (!workflow) throw new Error("Workflow not found");
      const result = validateGraph(workflow.draftGraph, host.engine.registry);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "export") {
      const workflow = host.store.getWorkflow(required(args[0], "workflow id"));
      if (!workflow) throw new Error("Workflow not found");
      const bundle = {
        schemaVersion: 1,
        kind: "pulseflow.bundle",
        exportedAt: new Date().toISOString(),
        workflows: [{ name: workflow.name, description: workflow.description, tags: workflow.tags, timezone: workflow.timezone, graph: workflow.draftGraph }],
      };
      const out = option(args, "--out") ?? path.join(home, "backup", `${workflow.id}.pulseflow.json`);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(bundle, null, 2));
      console.log(out);
      return;
    }
    if (command === "import") {
      const bundle = parseBundle(JSON.parse(readFileSync(required(args[0], "bundle file"), "utf8")) as unknown);
      const identity = host.store.ensureLocalIdentity();
      for (const workflow of bundle.workflows) {
        const id = createId("wf");
        host.store.insertWorkflow({
          id,
          workspaceId: identity.workspaceId,
          projectId: identity.projectId,
          name: workflow.name,
          description: workflow.description ?? "",
          tags: workflow.tags ?? [],
          graph: parseGraph(workflow.graph),
          timezone: workflow.timezone,
          ownerId: identity.userId,
        });
        console.log(id);
      }
      return;
    }
    if (command === "backup") {
      host.store.checkpoint();
      const target = path.join(home, "backup", `pulseflow-${Date.now()}.db`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(host.store.file));
      console.log(JSON.stringify({ path: target, encrypted: false, keyIncluded: false, passphrase: option(args, "--passphrase") ? "ignored-use-api" : null }));
      return;
    }
    if (command === "token") {
      const token = randomToken(32);
      host.store.insertToken({ id: createId("tok"), name: args[0] ?? "CLI token", tokenHash: sha256Hex(token), scopes: ["local"] });
      console.log(token);
      return;
    }
    throw new Error(`Unknown command ${command}`);
  } finally {
    if (command !== "serve") await host.close();
  }
}

function option(list: string[], name: string): string | undefined {
  const index = list.indexOf(name);
  return index >= 0 ? list[index + 1] : undefined;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
