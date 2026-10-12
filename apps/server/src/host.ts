import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WorkflowEngine, Runtime, type EnginePaths } from "@pulseflow/engine";
import { createId } from "@pulseflow/contracts";
import { loadOrCreateKey, randomToken, sha256Hex } from "@pulseflow/security";
import { openStore, type PulseStore } from "@pulseflow/storage";
import { seedWorkspace } from "@pulseflow/templates";

export interface Host {
  home: string;
  paths: EnginePaths;
  store: PulseStore;
  engine: WorkflowEngine;
  runtime: Runtime;
  key: Buffer;
  token: string;
  sessionSecret: string;
  close: () => Promise<void>;
}

export function defaultHome(): string {
  return process.env.PULSEFLOW_HOME ?? path.join(process.cwd(), ".pulseflow");
}

export async function createHost(home = defaultHome()): Promise<Host> {
  mkdirSync(home, { recursive: true });
  const paths: EnginePaths = {
    home,
    demo: path.join(home, "demo"),
    inbox: path.join(home, "inbox"),
    out: path.join(home, "out"),
    backup: path.join(home, "backup"),
  };
  const store = openStore(path.join(home, "pulseflow.db"));
  const key = loadOrCreateKey(path.join(home, "secret.key"));
  seedWorkspace(store, home);
  const engine = new WorkflowEngine(store, paths, { key, allowNetwork: true });
  const runtime = new Runtime(store, engine, paths);
  runtime.start(1_000);
  const token = ensureLocalToken(store, home);
  return {
    home,
    paths,
    store,
    engine,
    runtime,
    key,
    token,
    sessionSecret: randomToken(32),
    close: async () => {
      runtime.stop();
      store.close();
    },
  };
}

function ensureLocalToken(store: PulseStore, home: string): string {
  const file = path.join(home, "local.token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token) {
      if (!store.findToken(sha256Hex(token))) {
        store.insertToken({
          id: createId("tok"),
          name: "Local desktop",
          tokenHash: sha256Hex(token),
          scopes: ["local"],
        });
      }
      return token;
    }
  }
  const token = randomToken(32);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  store.insertToken({
    id: createId("tok"),
    name: "Local desktop",
    tokenHash: sha256Hex(token),
    scopes: ["local"],
  });
  return token;
}
