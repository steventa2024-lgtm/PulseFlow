import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowEngine, type EnginePaths } from "@pulseflow/engine";
import { openStore, type PulseStore } from "@pulseflow/storage";
import { seedWorkspace } from "@pulseflow/templates";

export interface Harness {
  home: string;
  paths: EnginePaths;
  store: PulseStore;
  engine: WorkflowEngine;
  close: () => void;
}

export function createHarness(): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "pulseflow-"));
  const paths: EnginePaths = {
    home,
    demo: path.join(home, "demo"),
    inbox: path.join(home, "inbox"),
    out: path.join(home, "out"),
    backup: path.join(home, "backup"),
  };
  const store = openStore(path.join(home, "pulseflow.db"));
  seedWorkspace(store, home);
  const engine = new WorkflowEngine(store, paths, { allowNetwork: true });
  return { home, paths, store, engine, close: () => store.close() };
}
