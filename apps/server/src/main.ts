import path from "node:path";
import { buildApp } from "./app";
import { createHost, defaultHome } from "./host";

const home = defaultHome();
const port = Number(process.env.PULSEFLOW_PORT ?? 8787);
const staticDir = process.env.PULSEFLOW_STATIC;
const host = await createHost(home);
const app = await buildApp(host, { staticDir: staticDir ? path.resolve(staticDir) : undefined });
const listenHost = process.env.PULSEFLOW_HOST ?? "127.0.0.1";
await app.listen({ host: listenHost, port });
console.log(`PulseFlow listening on http://${listenHost}:${port}`);
console.log(`Data directory: ${home}`);

const shutdown = async () => {
  await app.close();
  await host.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
