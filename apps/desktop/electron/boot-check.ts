import { buildApp, createHost } from "@pulseflow/server";

async function main(): Promise<void> {
  const home = process.env.PULSEFLOW_HOME;
  if (!home) throw new Error("PULSEFLOW_HOME is required for the desktop boot check");
  const host = await createHost(home);
  const app = await buildApp(host);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  const body = (await health.json()) as { ok?: boolean };
  const workflows = host.store.listWorkflows();
  if (!health.ok || body.ok !== true || workflows.length < 24) {
    throw new Error(`Desktop boot check failed (${health.status}, workflows=${workflows.length})`);
  }
  console.log(`boot-ok port=${port} workflows=${workflows.length} home=${home}`);
  await app.close();
  await host.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
