import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness } from "@pulseflow/testing";
import { templates, workflowIdFor } from "./index";
import { validateGraph } from "@pulseflow/engine";
import { createRegistry } from "@pulseflow/nodes-core";

const registry = createRegistry();

describe("template catalog", () => {
  it("validates every bundled template", () => {
    expect(templates).toHaveLength(24);
    for (const template of templates) {
      const result = validateGraph(template.graph, registry);
      expect(result.errors, template.id).toEqual([]);
    }
  });

  it("A01 writes the greeting and skips the false branch", async () => {
    const harness = createHarness();
    const result = await harness.engine.runWorkflow(workflowIdFor("A01"));
    expect(result.state).toBe("succeeded");
    const output = JSON.parse(readFileSync(path.join(harness.paths.demo, "hello-automation.json"), "utf8")) as { greeting: string };
    expect(output.greeting).toBe("Hello, PulseFlow");
    const steps = harness.store.listSteps(result.executionId);
    expect(steps.find((step) => step.nodeId === "log_false")?.state).toBe("skipped");
    expect(harness.store.listNotifications()[0]?.body).toContain("PulseFlow");
    const again = await harness.engine.runWorkflow(workflowIdFor("A01"), { payload: { name: "Other" } });
    expect(again.state).toBe("succeeded");
    expect(harness.store.listSteps(again.executionId).find((step) => step.nodeId === "write")?.state).toBe("skipped");
    harness.close();
  });

  it("A02 moves files by extension and records an undo manifest", async () => {
    const harness = createHarness();
    writeFileSync(path.join(harness.paths.inbox, "notes.pdf"), "pdf");
    writeFileSync(path.join(harness.paths.inbox, "photo.jpg"), "jpg");
    mkdirSync(path.join(harness.paths.out, "pdf"), { recursive: true });
    writeFileSync(path.join(harness.paths.out, "pdf", "notes.pdf"), "existing");
    const pdf = await harness.engine.runWorkflow(workflowIdFor("A02"), { payload: { path: path.join(harness.paths.inbox, "notes.pdf") } });
    const image = await harness.engine.runWorkflow(workflowIdFor("A02"), { payload: { path: path.join(harness.paths.inbox, "photo.jpg") } });
    expect(pdf.state).toBe("succeeded");
    expect(image.state).toBe("succeeded");
    expect(existsSync(path.join(harness.paths.out, "pdf", "notes-1.pdf"))).toBe(true);
    expect(existsSync(path.join(harness.paths.out, "images", "photo.jpg"))).toBe(true);
    expect(readFileSync(path.join(harness.paths.out, "undo-manifest.ndjson"), "utf8")).toContain("notes-1.pdf");
    harness.close();
  });

  it("A03 previews, renames, and rolls back", async () => {
    const harness = createHarness();
    const source = path.join(harness.paths.inbox, "bad name?.txt");
    writeFileSync(source, "data");
    const preview = await harness.engine.runWorkflow(workflowIdFor("A03"), {
      payload: [{ path: source, name: "bad name?.txt", dryRun: true, confirm: "" }],
    });
    expect(preview.state).toBe("succeeded");
    expect(existsSync(source)).toBe(true);
    const applied = await harness.engine.runWorkflow(workflowIdFor("A03"), {
      payload: [{ path: source, name: "bad name?.txt", dryRun: false, confirm: "RENAME" }],
    });
    expect(applied.state).toBe("succeeded");
    const renamed = path.join(harness.paths.inbox, "bad name.txt");
    expect(existsSync(renamed)).toBe(true);
    const undo = path.join(harness.paths.out, "rename-undo.ndjson");
    expect(existsSync(undo)).toBe(true);
    const parent = harness.store.getWorkflow(workflowIdFor("A03"));
    if (!parent) throw new Error("A03 workflow missing");
    harness.store.insertWorkflow({
      id: "wf_a03_rollback",
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      name: "Rollback check",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 40, y: 40 },
            parameters: {},
          },
          {
            id: "back",
            manifestId: "fs.rollback",
            manifestVersion: "1.0.0",
            position: { x: 280, y: 40 },
            parameters: { manifest: undo },
          },
        ],
        edges: [{ id: "e_manual_out_back", source: "manual", sourcePort: "out", target: "back", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    const rolled = await harness.engine.runWorkflow("wf_a03_rollback");
    expect(rolled.state).toBe("succeeded");
    expect(existsSync(source)).toBe(true);
    expect(existsSync(renamed)).toBe(false);
    harness.close();
  });

  it("A04 and A05 convert CSV and JSON with quoting", async () => {
    const harness = createHarness();
    writeFileSync(path.join(harness.paths.inbox, "sample.csv"), 'name,note\nAda,"She said ""hello"""\nGrace,café\n', "utf8");
    const csv = await harness.engine.runWorkflow(workflowIdFor("A04"));
    expect(csv.state).toBe("succeeded");
    const json = JSON.parse(readFileSync(path.join(harness.paths.demo, "sample.json"), "utf8")) as Array<{ name: string; note: string }>;
    expect(json[0]?.note).toBe('She said "hello"');
    expect(json[1]?.note).toBe("café");
    writeFileSync(path.join(harness.paths.inbox, "report.json"), JSON.stringify([{ name: "Ada", note: 'say "hi"' }]));
    const report = await harness.engine.runWorkflow(workflowIdFor("A05"));
    expect(report.state).toBe("succeeded");
    expect(readFileSync(path.join(harness.paths.demo, "report.csv"), "utf8")).toContain('"say ""hi"""');
    harness.close();
  });

  it("A06 reports duplicates and does not delete files", async () => {
    const harness = createHarness();
    const folder = path.join(harness.paths.inbox, "dupes");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "a.txt"), "same");
    writeFileSync(path.join(folder, "b.txt"), "same");
    writeFileSync(path.join(folder, "c.txt"), "different");
    const before = readdirSync(folder).sort();
    const result = await harness.engine.runWorkflow(workflowIdFor("A06"));
    expect(result.state).toBe("succeeded");
    const report = JSON.parse(readFileSync(path.join(harness.paths.demo, "duplicates.json"), "utf8")) as Array<{ count: number }>;
    expect(report.some((group) => group.count > 1)).toBe(true);
    expect(readdirSync(folder).sort()).toEqual(before);
    harness.close();
  });

  it("A07 through A09 produce a reminder, a verified backup, and markdown", async () => {
    const harness = createHarness();
    const reminder = await harness.engine.runWorkflow(workflowIdFor("A07"), { triggerType: "schedule" });
    expect(reminder.state).toBe("succeeded");
    expect(harness.store.listNotifications().some((notice) => notice.title === "Reminder")).toBe(true);
    const source = path.join(harness.paths.inbox, "backup-src");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "keep.txt"), "keep");
    const backup = await harness.engine.runWorkflow(workflowIdFor("A08"));
    expect(backup.state).toBe("succeeded");
    expect(readFileSync(path.join(harness.paths.backup, "snapshot", "keep.txt"), "utf8")).toBe("keep");
    writeFileSync(path.join(harness.paths.inbox, "daily.json"), JSON.stringify({ title: "Monday" }));
    const report = await harness.engine.runWorkflow(workflowIdFor("A09"));
    expect(report.state).toBe("succeeded");
    expect(readFileSync(path.join(harness.paths.demo, "daily.md"), "utf8")).toContain("Monday");
    harness.close();
  });

  it("A13 alerts only on a keyword and A14 sorts due tasks", async () => {
    const harness = createHarness();
    writeFileSync(path.join(harness.paths.inbox, "app.log"), "info started\n");
    const quiet = await harness.engine.runWorkflow(workflowIdFor("A13"));
    expect(quiet.state).toBe("succeeded");
    expect(existsSync(path.join(harness.paths.demo, "log-alert.txt"))).toBe(false);
    writeFileSync(path.join(harness.paths.inbox, "app.log"), "info started\nERROR disk full\n");
    const noisy = await harness.engine.runWorkflow(workflowIdFor("A13"));
    expect(noisy.state).toBe("succeeded");
    expect(readFileSync(path.join(harness.paths.demo, "log-alert.txt"), "utf8")).toContain("matched");
    writeFileSync(
      path.join(harness.paths.inbox, "tasks.json"),
      JSON.stringify([
        { title: "Write report", due: "2026-10-11", done: false },
        { title: "Future", due: "2027-01-01", done: false },
        { title: "Pay invoice", due: "2026-10-01", done: false },
        { title: "Done task", due: "2026-09-01", done: true },
      ]),
    );
    const digest = await harness.engine.runWorkflow(workflowIdFor("A14"));
    expect(digest.state).toBe("succeeded");
    const markdown = readFileSync(path.join(harness.paths.demo, "digest.md"), "utf8");
    expect(markdown.indexOf("Pay invoice")).toBeLessThan(markdown.indexOf("Write report"));
    expect(markdown).not.toContain("Future");
    expect(markdown).not.toContain("Done task");
    harness.close();
  });

  it("A16 records retry attempts and then succeeds", async () => {
    const harness = createHarness();
    const result = await harness.engine.runWorkflow(workflowIdFor("A16"));
    expect(result.state).toBe("succeeded");
    const attempts = harness.store.listSteps(result.executionId).filter((step) => step.nodeId === "fault");
    expect(attempts.map((step) => step.state)).toEqual(["retrying", "retrying", "succeeded"]);
    harness.close();
  });

  it("runs every template against its offline fixture", async () => {
    const harness = createHarness();
    writeFileSync(path.join(harness.paths.inbox, "sample.csv"), "name,note\nAda,hello\n");
    writeFileSync(path.join(harness.paths.inbox, "report.json"), JSON.stringify([{ name: "Ada" }]));
    mkdirSync(path.join(harness.paths.inbox, "dupes"), { recursive: true });
    writeFileSync(path.join(harness.paths.inbox, "dupes", "a.txt"), "x");
    mkdirSync(path.join(harness.paths.inbox, "backup-src"), { recursive: true });
    writeFileSync(path.join(harness.paths.inbox, "backup-src", "a.txt"), "x");
    writeFileSync(path.join(harness.paths.inbox, "daily.json"), JSON.stringify({ title: "Note" }));
    writeFileSync(path.join(harness.paths.inbox, "app.log"), "ERROR sample\n");
    writeFileSync(path.join(harness.paths.inbox, "tasks.json"), JSON.stringify([{ title: "Now", due: "2026-10-01", done: false }]));
    writeFileSync(path.join(harness.paths.inbox, "notes.txt"), "A local note worth summarizing.");
    writeFileSync(path.join(harness.paths.inbox, "loose.png"), "png");
    writeFileSync(path.join(harness.paths.inbox, "rename-me.txt"), "name");
    const payloads: Record<string, unknown> = {
      A02: { path: path.join(harness.paths.inbox, "loose.png") },
      A03: [{ path: path.join(harness.paths.inbox, "rename-me.txt"), name: "rename-me.txt", dryRun: true, confirm: "" }],
      A10: { message: "hello" },
      B04: { email: "person@example.com", message: "hello" },
    };
    for (const template of templates) {
      const result = await harness.engine.runWorkflow(workflowIdFor(template.id), {
        mode: template.tier === "B" ? "demo" : "production",
        payload: payloads[template.id],
        triggerType: template.id === "A10" || template.id === "B04" ? "webhook" : undefined,
      });
      expect(result.state, `${template.id} ${result.error ?? ""}`).toBe("succeeded");
    }
    expect(readFileSync(path.join(harness.paths.demo, "reading-list.json"), "utf8")).toContain("Local notes");
    expect(readFileSync(path.join(harness.paths.demo, "summary.md"), "utf8")).toContain("summary");
    expect(readFileSync(path.join(harness.paths.demo, "page.csv"), "utf8")).toContain("Demo Page");
    harness.close();
  });
});
