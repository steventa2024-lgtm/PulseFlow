import { FlowError, isTruthy, type FieldSchema, type Item, type NodeManifest, type PortSchema } from "@pulseflow/contracts";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import Ajv from "ajv";
import { resolveInside } from "@pulseflow/security";
import {
  extractHtml,
  parseFeed,
  retryAfterMs,
  sendSmtp,
} from "@pulseflow/connectors";
import {
  firstItem,
  fromItems,
  multi,
  readBoolean,
  readNumber,
  readParam,
  readString,
  single,
  type NodeContext,
  type NodeDefinition,
} from "./types";

const ajv = new Ajv({ allErrors: true, strict: false });

function node(
  manifest: Omit<NodeManifest, "version"> & { version?: string },
  execute: NodeDefinition["execute"],
): NodeDefinition {
  return { manifest: { version: "1.0.0", ...manifest }, execute };
}

const input: PortSchema[] = [{ id: "in", label: "In" }];
const output: PortSchema[] = [{ id: "out", label: "Out" }];

function field(partial: FieldSchema): FieldSchema {
  return partial;
}

export function builtinNodes(): NodeDefinition[] {
  return [
    ...triggers(),
    ...logic(),
    ...dataNodes(),
    ...fileNodes(),
    ...networkNodes(),
    ...developerNodes(),
  ];
}

function triggers(): NodeDefinition[] {
  return [
    node(
      {
        id: "trigger.manual",
        title: "Manual",
        description: "Starts a run with a JSON payload.",
        category: "trigger",
        icon: "play",
        inputs: [],
        outputs: output,
        permissions: [],
        fields: [field({ key: "payload", label: "Payload", type: "json", default: { name: "PulseFlow" } })],
      },
      async (ctx) => {
        const payload = ctx.execution.payload === undefined ? readParam(ctx, "payload", {}) : ctx.execution.payload;
        const items = Array.isArray(payload)
          ? payload.map((entry) => ({ json: asObject(entry) }))
          : [{ json: asObject(payload) }];
        return fromItems("out", items);
      },
    ),
    node(
      {
        id: "trigger.schedule",
        title: "Schedule",
        description: "Runs on a cron expression in a timezone. Missed runs follow the selected policy.",
        category: "trigger",
        icon: "clock",
        inputs: [],
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "cron", label: "Cron", type: "string", required: true, default: "0 9 * * *" }),
          field({ key: "timezone", label: "Timezone", type: "string", default: "UTC" }),
          field({
            key: "missedPolicy",
            label: "Missed run",
            type: "select",
            default: "skip",
            options: [
              { value: "skip", label: "Skip" },
              { value: "run_once", label: "Run once" },
            ],
          }),
        ],
      },
      async (ctx) => single("out", { ...(asObject(ctx.execution.payload)), trigger: "schedule", at: new Date(ctx.clock.now()).toISOString() }),
    ),
    node(
      {
        id: "trigger.interval",
        title: "Interval",
        description: "Runs on a fixed interval while the host process is active.",
        category: "trigger",
        icon: "timer",
        inputs: [],
        outputs: output,
        permissions: [],
        fields: [field({ key: "intervalMs", label: "Interval (ms)", type: "number", required: true, default: 60000 })],
      },
      async (ctx) => single("out", { ...(asObject(ctx.execution.payload)), trigger: "interval", at: new Date(ctx.clock.now()).toISOString() }),
    ),
    node(
      {
        id: "trigger.webhook",
        title: "Local webhook",
        description: "Receives an HTTP request on the loopback PulseFlow server.",
        category: "trigger",
        icon: "webhook",
        inputs: [],
        outputs: output,
        permissions: ["webhook"],
        fields: [
          field({ key: "secret", label: "Shared secret", type: "string", secret: true, help: "Required when the hook is activated." }),
        ],
      },
      async (ctx) => fromItems("out", [{ json: asObject(ctx.execution.payload) }]),
    ),
    node(
      {
        id: "trigger.folderChanged",
        title: "Folder changed",
        description: "Runs when a file is added under an approved folder.",
        category: "trigger",
        icon: "folder",
        inputs: [],
        outputs: output,
        permissions: ["files.read"],
        fields: [field({ key: "folder", label: "Folder", type: "path", required: true })],
      },
      async (ctx) => fromItems("out", [{ json: asObject(ctx.execution.payload) }]),
    ),
    node(
      {
        id: "trigger.fileChanged",
        title: "File changed",
        description: "Runs when one approved file changes.",
        category: "trigger",
        icon: "file",
        inputs: [],
        outputs: output,
        permissions: ["files.read"],
        fields: [field({ key: "file", label: "File", type: "path", required: true })],
      },
      async (ctx) => fromItems("out", [{ json: asObject(ctx.execution.payload) }]),
    ),
    node(
      {
        id: "trigger.appStartup",
        title: "App startup",
        description: "Runs once when the host starts. Opt in explicitly.",
        category: "trigger",
        icon: "power",
        inputs: [],
        outputs: output,
        permissions: [],
        fields: [field({ key: "enabled", label: "Enabled", type: "boolean", default: false })],
      },
      async (ctx) => {
        if (!readBoolean(ctx, "enabled", false) && ctx.execution.mode !== "debug") {
          return fromItems("out", []);
        }
        return single("out", { trigger: "startup", at: new Date(ctx.clock.now()).toISOString() });
      },
    ),
    node(
      {
        id: "trigger.failure",
        title: "Failure",
        description: "Runs after another workflow fails. Failure workflows do not chain recursively.",
        category: "trigger",
        icon: "alert-triangle",
        inputs: [],
        outputs: output,
        permissions: [],
        fields: [],
      },
      async (ctx) => fromItems("out", [{ json: asObject(ctx.execution.payload) }]),
    ),
    node(
      {
        id: "trigger.workflowCalled",
        title: "Workflow called",
        description: "Entry point for a subworkflow.",
        category: "trigger",
        icon: "workflow",
        inputs: [],
        outputs: output,
        permissions: [],
        fields: [],
      },
      async (ctx) => fromItems("out", ctx.items.length ? ctx.items : [{ json: asObject(ctx.execution.payload) }]),
    ),
    node(
      {
        id: "trigger.rssPoll",
        title: "RSS poll",
        description: "Polling trigger placeholder that emits the scheduled payload. Pair it with RSS Read.",
        category: "trigger",
        icon: "rss",
        inputs: [],
        outputs: output,
        permissions: ["network"],
        fields: [field({ key: "url", label: "Feed URL", type: "string", required: true })],
      },
      async (ctx) => single("out", { ...(asObject(ctx.execution.payload)), url: readString(ctx, "url") }),
    ),
    node(
      {
        id: "trigger.httpPoll",
        title: "HTTP poll",
        description: "Polling trigger that emits the configured URL for a following HTTP node.",
        category: "trigger",
        icon: "radio",
        inputs: [],
        outputs: output,
        permissions: ["network"],
        fields: [field({ key: "url", label: "URL", type: "string", required: true })],
      },
      async (ctx) => single("out", { ...(asObject(ctx.execution.payload)), url: readString(ctx, "url") }),
    ),
  ];
}

function logic(): NodeDefinition[] {
  return [
    node(
      {
        id: "logic.set",
        title: "Set fields",
        description: "Adds or replaces fields on each item.",
        category: "logic",
        icon: "pencil",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "mode", label: "Mode", type: "select", default: "merge", options: [
            { value: "merge", label: "Merge" },
            { value: "replace", label: "Replace" },
          ] }),
          field({ key: "fields", label: "Fields", type: "json", default: [{ name: "greeting", value: "Hello" }] }),
        ],
      },
      async (ctx) => {
        const mode = readString(ctx, "mode", "merge");
        const fields = asFieldList(ctx.rawParameters.fields);
        const items = (ctx.items.length ? ctx.items : [{ json: {} }]).map((item, index) => {
          const json: Record<string, unknown> = mode === "replace" ? {} : { ...item.json };
          for (const entry of fields) {
            json[entry.name] = ctx.interpolate(entry.value, item, index);
          }
          return { json };
        });
        return fromItems("out", items);
      },
    ),
    node(
      {
        id: "logic.filter",
        title: "Filter",
        description: "Keeps items whose expression is truthy.",
        category: "logic",
        icon: "filter",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "expression", label: "Keep when", type: "expression", required: true })],
      },
      async (ctx) => fromItems("out", ctx.items.filter((item, index) => isTruthy(ctx.eval(exprOf(ctx, "expression"), item, index)))),
    ),
    node(
      {
        id: "logic.if",
        title: "If / else",
        description: "Routes each item to the true or false port.",
        category: "logic",
        icon: "split",
        inputs: input,
        outputs: [
          { id: "true", label: "True" },
          { id: "false", label: "False" },
        ],
        permissions: [],
        fields: [field({ key: "expression", label: "Condition", type: "expression", required: true })],
      },
      async (ctx) => {
        const yes: Item[] = [];
        const no: Item[] = [];
        for (let index = 0; index < ctx.items.length; index += 1) {
          const item = ctx.items[index]!;
          (isTruthy(ctx.eval(exprOf(ctx, "expression"), item, index)) ? yes : no).push(item);
        }
        return multi({ true: yes, false: no }, yes.length > 0 ? "true" : "false");
      },
    ),
    node(
      {
        id: "logic.switch",
        title: "Switch",
        description: "Routes items to ports a–d or else by an exact value.",
        category: "logic",
        icon: "git-branch",
        inputs: input,
        outputs: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
          { id: "d", label: "D" },
          { id: "else", label: "Else" },
        ],
        permissions: [],
        fields: [
          field({ key: "value", label: "Value", type: "expression", required: true }),
          field({ key: "cases", label: "Cases", type: "json", default: [{ equals: "pdf", port: "a" }] }),
        ],
      },
      async (ctx) => {
        const cases = Array.isArray(ctx.rawParameters.cases) ? ctx.rawParameters.cases : [];
        const ports: Record<string, Item[]> = { a: [], b: [], c: [], d: [], else: [] };
        ctx.items.forEach((item, index) => {
          const value = String(ctx.eval(exprOf(ctx, "value"), item, index) ?? "");
          const match = cases.find((entry) => asObject(entry).equals === value);
          const port = typeof asObject(match).port === "string" ? String(asObject(match).port) : "else";
          (ports[port] ?? ports.else)!.push(item);
        });
        const primary = Object.entries(ports).find(([, items]) => items.length > 0)?.[0] ?? "else";
        return multi(ports, primary);
      },
    ),
    node(
      {
        id: "logic.merge",
        title: "Merge",
        description: "Passes through items after every incoming branch has settled.",
        category: "logic",
        icon: "merge",
        inputs: input,
        outputs: output,
        permissions: [],
        fanIn: "all",
        fields: [],
      },
      async (ctx) => fromItems("out", ctx.items),
    ),
    node(
      {
        id: "logic.split",
        title: "Split",
        description: "Copies items to ports a and b.",
        category: "logic",
        icon: "copy",
        inputs: input,
        outputs: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        permissions: [],
        fields: [],
      },
      async (ctx) => multi({ a: ctx.items, b: ctx.items }, "a"),
    ),
    node(
      {
        id: "logic.forEach",
        title: "Loop over items",
        description: "Runs the each-port branch once per item, up to the iteration cap, then emits the collected items on done.",
        category: "logic",
        icon: "repeat",
        inputs: [
          { id: "in", label: "In" },
          { id: "loop", label: "Loop return" },
        ],
        outputs: [
          { id: "each", label: "Each" },
          { id: "done", label: "Done" },
        ],
        permissions: [],
        fields: [
          field({ key: "expression", label: "Items expression", type: "expression", help: "Optional. Defaults to the incoming items." }),
          field({ key: "maxItems", label: "Max items", type: "number", default: 1000 }),
        ],
      },
      async (ctx) => fromItems("done", ctx.items),
    ),
    node(
      {
        id: "logic.batch",
        title: "Batch",
        description: "Groups items into batches.",
        category: "logic",
        icon: "layers",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "size", label: "Batch size", type: "number", default: 10 })],
      },
      async (ctx) => {
        const size = Math.max(1, Math.min(1000, readNumber(ctx, "size", 10)));
        const items: Item[] = [];
        for (let index = 0; index < ctx.items.length; index += size) {
          items.push({ json: { batch: ctx.items.slice(index, index + size).map((item) => item.json) } });
        }
        return fromItems("out", items);
      },
    ),
    node(
      {
        id: "logic.sort",
        title: "Sort",
        description: "Sorts items by an expression.",
        category: "logic",
        icon: "arrow-up-down",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "expression", label: "Key", type: "expression", required: true }),
          field({ key: "order", label: "Order", type: "select", default: "asc", options: [
            { value: "asc", label: "Ascending" },
            { value: "desc", label: "Descending" },
          ] }),
        ],
      },
      async (ctx) => {
        const order = readString(ctx, "order", "asc");
        const items = [...ctx.items].sort((left, right) => {
          const a = String(ctx.eval(exprOf(ctx, "expression"), left, 0) ?? "");
          const b = String(ctx.eval(exprOf(ctx, "expression"), right, 0) ?? "");
          return order === "desc" ? b.localeCompare(a) : a.localeCompare(b);
        });
        return fromItems("out", items);
      },
    ),
    node(
      {
        id: "logic.dedupe",
        title: "Deduplicate",
        description: "Drops duplicate keys within the run or across runs.",
        category: "logic",
        icon: "fingerprint",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "expression", label: "Key", type: "expression", required: true }),
          field({ key: "mode", label: "Mode", type: "select", default: "items", options: [
            { value: "items", label: "This run" },
            { value: "persistent", label: "Remembered" },
          ] }),
        ],
      },
      async (ctx) => {
        const persistent = readString(ctx, "mode", "items") === "persistent";
        const seen = new Set<string>();
        const kept: Item[] = [];
        for (let index = 0; index < ctx.items.length; index += 1) {
          const item = ctx.items[index]!;
          const key = String(ctx.eval(exprOf(ctx, "expression"), item, index) ?? "");
          if (seen.has(key)) continue;
          seen.add(key);
          if (persistent) {
            const ns = `dedupe:${ctx.execution.workflowId}:${ctx.node.id}`;
            if (ctx.kv.get(ns, key)) continue;
            ctx.kv.set(ns, key, { at: new Date(ctx.clock.now()).toISOString() });
          }
          kept.push(item);
        }
        return fromItems("out", kept);
      },
    ),
    node(
      {
        id: "logic.aggregate",
        title: "Aggregate",
        description: "Collects, counts, sums, or groups items.",
        category: "logic",
        icon: "sigma",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "mode", label: "Mode", type: "select", default: "collect", options: [
            { value: "collect", label: "Collect" },
            { value: "count", label: "Count" },
            { value: "group", label: "Group by key" },
          ] }),
          field({ key: "expression", label: "Group key", type: "expression" }),
        ],
      },
      async (ctx) => {
        const mode = readString(ctx, "mode", "collect");
        if (mode === "count") return single("out", { count: ctx.items.length });
        if (mode === "group") {
          const groups = new Map<string, Item[]>();
          ctx.items.forEach((item, index) => {
            const key = String(ctx.eval(exprOf(ctx, "expression"), item, index) ?? "");
            const list = groups.get(key) ?? [];
            list.push(item);
            groups.set(key, list);
          });
          return fromItems(
            "out",
            [...groups.entries()].map(([key, items]) => ({
              json: { key, count: items.length, files: items.map((item) => item.json.path ?? item.json), items: items.map((item) => item.json) },
            })),
          );
        }
        return single("out", { items: ctx.items.map((item) => item.json), count: ctx.items.length });
      },
    ),
    node(
      {
        id: "logic.wait",
        title: "Wait",
        description: "Waits for a duration. Durable waits survive a process restart.",
        category: "logic",
        icon: "hourglass",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "ms", label: "Milliseconds", type: "number", default: 1000 }),
          field({ key: "durable", label: "Durable", type: "boolean", default: false }),
        ],
      },
      async (ctx) => {
        const ms = Math.max(0, Math.min(86_400_000, readNumber(ctx, "ms", 0)));
        if (readBoolean(ctx, "durable", false)) {
          return { ...fromItems("out", ctx.items), waitMs: ms };
        }
        await ctx.clock.sleep(ms, ctx.signal);
        return fromItems("out", ctx.items);
      },
    ),
    node(
      {
        id: "logic.transient",
        title: "Transient fault",
        description: "Fails a configured number of attempts so retry policies can be demonstrated.",
        category: "logic",
        icon: "bug",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "failTimes", label: "Failures before success", type: "number", default: 2 })],
      },
      async (ctx) => {
        const failTimes = readNumber(ctx, "failTimes", 2);
        if (ctx.attempt <= failTimes) {
          throw new FlowError(`Transient failure on attempt ${ctx.attempt}`, "TRANSIENT", true);
        }
        return single("out", { recovered: true, attempt: ctx.attempt, ...(firstItem(ctx).json) });
      },
    ),
    node(
      {
        id: "logic.stop",
        title: "Stop",
        description: "Ends the workflow with an error.",
        category: "logic",
        icon: "octagon",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "message", label: "Message", type: "string", default: "Stopped" })],
      },
      async (ctx) => {
        throw new FlowError(readString(ctx, "message", "Stopped"), "STOPPED");
      },
    ),
    node(
      {
        id: "logic.log",
        title: "Log",
        description: "Writes a sanitized log line and passes items through.",
        category: "logic",
        icon: "scroll-text",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "level", label: "Level", type: "select", default: "info", options: [
            { value: "info", label: "Info" },
            { value: "warn", label: "Warning" },
            { value: "error", label: "Error" },
          ] }),
          field({ key: "message", label: "Message", type: "string", required: true }),
        ],
      },
      async (ctx) => {
        const message = String(ctx.interpolate(ctx.rawParameters.message ?? "", firstItem(ctx), 0) ?? "");
        ctx.log(readString(ctx, "level", "info") as "info", message);
        return single("out", { message, ...(firstItem(ctx).json) });
      },
    ),
    node(
      {
        id: "logic.subworkflow",
        title: "Subworkflow",
        description: "Runs another workflow with the current items. Recursion is capped.",
        category: "logic",
        icon: "workflow",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "workflowId", label: "Workflow", type: "string", required: true })],
      },
      async (ctx) => {
        const items = await ctx.runSubworkflow(readString(ctx, "workflowId"), ctx.items, ctx.execution.depth + 1);
        return fromItems("out", items);
      },
    ),
    node(
      {
        id: "notify.local",
        title: "Local notification",
        description: "Stores a notification and asks the desktop shell to show it when available.",
        category: "action",
        icon: "bell",
        inputs: input,
        outputs: output,
        permissions: ["notify"],
        fields: [
          field({ key: "title", label: "Title", type: "string", default: "PulseFlow" }),
          field({ key: "body", label: "Body", type: "string", required: true }),
        ],
      },
      async (ctx) => {
        const title = readString(ctx, "title", "PulseFlow");
        const body = String(ctx.interpolate(ctx.rawParameters.body ?? "", firstItem(ctx), 0) ?? "");
        ctx.notify({ title, body });
        return single("out", { title, body, notified: true });
      },
    ),
  ];
}

function dataNodes(): NodeDefinition[] {
  return [
    node(
      {
        id: "data.json",
        title: "JSON",
        description: "Parses or stringifies JSON.",
        category: "data",
        icon: "braces",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "mode", label: "Mode", type: "select", default: "parse", options: [
          { value: "parse", label: "Parse" },
          { value: "stringify", label: "Stringify" },
        ] })],
      },
      async (ctx) => {
        const mode = readString(ctx, "mode", "parse");
        return fromItems(
          "out",
          ctx.items.map((item) => {
            if (mode === "stringify") return { json: { ...item.json, json: JSON.stringify(item.json) } };
            const raw = item.json.text ?? item.json.body ?? item.json.json;
            const parsed = typeof raw === "string" ? JSON.parse(raw) : item.json;
            return { json: asObject(parsed) };
          }),
        );
      },
    ),
    node(
      {
        id: "data.csvParse",
        title: "CSV parse",
        description: "Parses CSV text, including quotes and Unicode.",
        category: "data",
        icon: "table",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "text", label: "CSV text", type: "text", help: "Optional. Defaults to the text field." })],
      },
      async (ctx) => {
        const provided = ctx.rawParameters.text;
        const text = provided === undefined ? String(firstItem(ctx).json.text ?? "") : String(ctx.interpolate(provided, firstItem(ctx), 0) ?? "");
        return fromItems("out", parseCsv(text).map((json) => ({ json })));
      },
    ),
    node(
      {
        id: "data.csvWrite",
        title: "CSV build",
        description: "Flattens items into an escaped CSV document.",
        category: "data",
        icon: "table",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [],
      },
      async (ctx) => single("out", { csv: toCsv(ctx.items.map((item) => item.json)), rows: ctx.items.length }),
    ),
    node(
      {
        id: "data.datetime",
        title: "Date and time",
        description: "Formats the current or supplied time.",
        category: "data",
        icon: "calendar",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "value", label: "Value", type: "expression" })],
      },
      async (ctx) => {
        const raw = ctx.rawParameters.value ? ctx.eval(exprOf(ctx, "value"), firstItem(ctx), 0) : new Date(ctx.clock.now()).toISOString();
        const date = new Date(String(raw));
        if (Number.isNaN(date.getTime())) throw new FlowError("Invalid date", "DATE");
        return single("out", { ...firstItem(ctx).json, iso: date.toISOString(), date: date.toISOString().slice(0, 10) });
      },
    ),
    node(
      {
        id: "data.regex",
        title: "Regex",
        description: "Extracts regular-expression matches from text.",
        category: "data",
        icon: "regex",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "pattern", label: "Pattern", type: "string", required: true }),
          field({ key: "text", label: "Text", type: "expression" }),
        ],
      },
      async (ctx) => {
        const pattern = readString(ctx, "pattern");
        if (pattern.length > 80) throw new FlowError("Pattern is too long", "REGEX");
        const flags = "g";
        const regex = new RegExp(pattern, flags);
        const items: Item[] = [];
        for (const item of ctx.items) {
          const text = String(ctx.rawParameters.text ? ctx.interpolate(ctx.rawParameters.text, item, 0) : item.json.text ?? "");
          const matches = text.match(regex) ?? [];
          items.push({ json: { ...item.json, matches, matched: matches.length > 0 } });
        }
        return fromItems("out", items);
      },
    ),
    node(
      {
        id: "data.text",
        title: "Text",
        description: "Trims, changes case, or slugifies text.",
        category: "data",
        icon: "type",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "operation", label: "Operation", type: "select", default: "trim", options: [
            { value: "trim", label: "Trim" },
            { value: "upper", label: "Uppercase" },
            { value: "lower", label: "Lowercase" },
            { value: "slug", label: "Slug" },
            { value: "sanitize", label: "Sanitize filename" },
          ] }),
          field({ key: "field", label: "Field", type: "string", default: "name" }),
        ],
      },
      async (ctx) => {
        const operation = readString(ctx, "operation", "trim");
        const key = readString(ctx, "field", "name");
        return fromItems(
          "out",
          ctx.items.map((item) => {
            const original = String(item.json[key] ?? "");
            let value: string;
            if (operation === "upper") value = original.toUpperCase();
            else if (operation === "lower") value = original.toLowerCase();
            else if (operation === "slug") value = original.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "-");
            else if (operation === "sanitize") {
              const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join("");
              value = original.replace(new RegExp(`[<>:"/\\\\|?*${controls}]`, "g"), "").trim();
            }
            else value = original.trim();
            return { json: { ...item.json, [key]: value, original } };
          }),
        );
      },
    ),
    node(
      {
        id: "data.math",
        title: "Math",
        description: "Applies arithmetic to two values.",
        category: "data",
        icon: "calculator",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "operation", label: "Operation", type: "select", default: "add", options: [
            { value: "add", label: "Add" },
            { value: "subtract", label: "Subtract" },
            { value: "multiply", label: "Multiply" },
            { value: "divide", label: "Divide" },
          ] }),
          field({ key: "left", label: "Left", type: "expression", required: true }),
          field({ key: "right", label: "Right", type: "expression", required: true }),
        ],
      },
      async (ctx) => fromItems("out", ctx.items.map((item, index) => {
        const left = Number(ctx.eval(exprOf(ctx, "left"), item, index));
        const right = Number(ctx.eval(exprOf(ctx, "right"), item, index));
        let result = left + right;
        const operation = readString(ctx, "operation", "add");
        if (operation === "subtract") result = left - right;
        if (operation === "multiply") result = left * right;
        if (operation === "divide") {
          if (right === 0) throw new FlowError("Division by zero", "MATH");
          result = left / right;
        }
        return { json: { ...item.json, result } };
      })),
    ),
    node(
      {
        id: "data.compare",
        title: "Compare",
        description: "Compares two expressions and routes true or false.",
        category: "data",
        icon: "equal",
        inputs: input,
        outputs: [
          { id: "true", label: "True" },
          { id: "false", label: "False" },
        ],
        permissions: [],
        fields: [
          field({ key: "left", label: "Left", type: "expression", required: true }),
          field({ key: "op", label: "Operator", type: "select", default: "eq", options: [
            { value: "eq", label: "Equals" },
            { value: "neq", label: "Not equals" },
            { value: "gt", label: "Greater" },
            { value: "lt", label: "Less" },
          ] }),
          field({ key: "right", label: "Right", type: "expression", required: true }),
        ],
      },
      async (ctx) => {
        const yes: Item[] = [];
        const no: Item[] = [];
        const op = readString(ctx, "op", "eq");
        ctx.items.forEach((item, index) => {
          const left = ctx.eval(exprOf(ctx, "left"), item, index);
          const right = ctx.eval(exprOf(ctx, "right"), item, index);
          let ok = left === right;
          if (op === "neq") ok = left !== right;
          if (op === "gt") ok = Number(left) > Number(right);
          if (op === "lt") ok = Number(left) < Number(right);
          (ok ? yes : no).push({ json: { ...item.json, comparison: ok } });
        });
        return multi({ true: yes, false: no }, yes.length ? "true" : "false");
      },
    ),
    node(
      {
        id: "data.kv",
        title: "Key storage",
        description: "Reads or writes a local key in the workflow database.",
        category: "data",
        icon: "database",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [
          field({ key: "action", label: "Action", type: "select", default: "get", options: [
            { value: "get", label: "Get" },
            { value: "set", label: "Set" },
          ] }),
          field({ key: "namespace", label: "Namespace", type: "string", default: "default" }),
          field({ key: "key", label: "Key", type: "string", required: true }),
          field({ key: "value", label: "Value", type: "json" }),
        ],
      },
      async (ctx) => {
        const namespace = readString(ctx, "namespace", "default");
        const key = readString(ctx, "key");
        if (readString(ctx, "action", "get") === "set") {
          ctx.kv.set(namespace, key, readParam(ctx, "value", firstItem(ctx).json));
        }
        return single("out", { ...firstItem(ctx).json, value: ctx.kv.get(namespace, key) ?? null });
      },
    ),
    node(
      {
        id: "data.env",
        title: "Environment",
        description: "Reads explicitly named environment variables. Secrets are not exposed in bulk.",
        category: "data",
        icon: "key-round",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "names", label: "Names", type: "json", required: true, default: [] })],
      },
      async (ctx) => {
        const names = Array.isArray(ctx.rawParameters.names) ? ctx.rawParameters.names.map(String) : [];
        const values: Record<string, string | null> = {};
        for (const name of names) {
          if (!/^[A-Z0-9_]{1,80}$/.test(name) || /SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL/i.test(name)) {
            throw new FlowError(`Environment name is not allowed: ${name}`, "ENV_DENIED");
          }
          values[name] = process.env[name] ?? null;
        }
        return single("out", { ...firstItem(ctx).json, env: values });
      },
    ),
    node(
      {
        id: "data.markdown",
        title: "Markdown",
        description: "Builds a Markdown document from a template and the current items.",
        category: "data",
        icon: "file-text",
        inputs: input,
        outputs: output,
        permissions: [],
        fields: [field({ key: "template", label: "Template", type: "text", required: true })],
      },
      async (ctx) => {
        const template = String(ctx.rawParameters.template ?? "");
        const rendered = String(ctx.interpolate(template, { json: { ...firstItem(ctx).json, items: ctx.items.map((item) => item.json) } }, 0) ?? "");
        return single("out", { ...firstItem(ctx).json, markdown: rendered });
      },
    ),
    node(
      {
        id: "data.schema",
        title: "JSON Schema",
        description: "Validates JSON against a schema.",
        category: "data",
        icon: "shield-check",
        inputs: input,
        outputs: [
          { id: "ok", label: "Valid" },
          { id: "error", label: "Invalid" },
        ],
        permissions: [],
        fields: [field({ key: "schema", label: "Schema", type: "json", required: true })],
      },
      async (ctx) => {
        const schema = readParam(ctx, "schema", {});
        const validate = ajv.compile(schema as object);
        const ok: Item[] = [];
        const bad: Item[] = [];
        for (const item of ctx.items) {
          const valid = Boolean(validate(item.json));
          if (valid) ok.push(item);
          else bad.push({ json: { ...item.json, errors: [...(validate.errors ?? [])] as unknown[] } });
        }
        return multi({ ok, error: bad }, ok.length ? "ok" : "error");
      },
    ),
  ];
}

function fileNodes(): NodeDefinition[] {
  return [
    node(
      {
        id: "fs.read",
        title: "Read file",
        description: "Reads a text, JSON, or CSV file from an approved folder.",
        category: "files",
        icon: "file-input",
        inputs: input,
        outputs: output,
        permissions: ["files.read"],
        fields: [
          field({ key: "path", label: "Path", type: "path", required: true }),
          field({ key: "format", label: "Format", type: "select", default: "text", options: [
            { value: "text", label: "Text" },
            { value: "json", label: "JSON" },
            { value: "csv", label: "CSV" },
          ] }),
        ],
      },
      async (ctx) => {
        const file = resolveInside(ctx.permissions.roots, readString(ctx, "path"));
        const text = readFileSync(file, "utf8");
        if (text.length > 2_000_000) throw new FlowError("File exceeds the 2 MB read limit", "FILE_LIMIT");
        const format = readString(ctx, "format", "text");
        if (format === "json") {
          const parsed = JSON.parse(text) as unknown;
          if (Array.isArray(parsed)) return fromItems("out", parsed.map((entry) => ({ json: asObject(entry) })));
          return fromItems("out", [{ json: asObject(parsed) }]);
        }
        if (format === "csv") return fromItems("out", parseCsv(text).map((json) => ({ json })));
        return single("out", { path: file, text });
      },
    ),
    node(
      {
        id: "fs.write",
        title: "Write file",
        description: "Writes text, JSON, or NDJSON inside an approved folder.",
        category: "files",
        icon: "file-output",
        inputs: input,
        outputs: output,
        permissions: ["files.write"],
        fields: [
          field({ key: "path", label: "Path", type: "path", required: true }),
          field({ key: "content", label: "Content", type: "json", help: "Optional. Defaults to the current items." }),
          field({ key: "format", label: "Format", type: "select", default: "json", options: [
            { value: "json", label: "JSON" },
            { value: "text", label: "Text" },
            { value: "ndjson", label: "NDJSON append" },
          ] }),
        ],
      },
      async (ctx) => {
        const file = resolveInside(ctx.permissions.roots, readString(ctx, "path"));
        mkdirSync(path.dirname(file), { recursive: true });
        const format = readString(ctx, "format", "json");
        const contentValue = ctx.rawParameters.content === undefined
          ? ctx.items.map((item) => item.json)
          : ctx.interpolate(ctx.rawParameters.content, firstItem(ctx), 0);
        const text = format === "text" ? String(contentValue ?? "") : format === "ndjson"
          ? `${JSON.stringify(contentValue)}\n`
          : JSON.stringify(contentValue, null, 2);
        if (format === "ndjson") appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
        else atomicWrite(file, text);
        const hash = createHash("sha256").update(text).digest("hex");
        return single("out", { ...firstItem(ctx).json, path: file, bytes: Buffer.byteLength(text), sha256: hash });
      },
    ),
    node(
      {
        id: "fs.scan",
        title: "Directory scan",
        description: "Lists files under an approved folder without following links.",
        category: "files",
        icon: "folder-search",
        inputs: input,
        outputs: output,
        permissions: ["files.read"],
        fields: [field({ key: "path", label: "Folder", type: "path", required: true })],
      },
      async (ctx) => fromItems("out", scanFiles(resolveInside(ctx.permissions.roots, readString(ctx, "path")), ctx.permissions.roots).map((file) => ({ json: file }))),
    ),
    node(
      {
        id: "fs.hash",
        title: "Hash files",
        description: "Adds a SHA-256 digest to each file item.",
        category: "files",
        icon: "hash",
        inputs: input,
        outputs: output,
        permissions: ["files.read"],
        fields: [],
      },
      async (ctx) => fromItems("out", ctx.items.map((item) => {
        const file = resolveInside(ctx.permissions.roots, String(item.json.path ?? ""));
        const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
        return { json: { ...item.json, path: file, sha256: hash } };
      })),
    ),
    node(
      {
        id: "fs.move",
        title: "Move file",
        description: "Moves a file into an approved folder and records an undo entry.",
        category: "files",
        icon: "folder-input",
        inputs: input,
        outputs: output,
        permissions: ["files.move"],
        fields: [
          field({ key: "toDir", label: "Destination folder", type: "path", required: true }),
          field({ key: "collision", label: "Collision", type: "select", default: "suffix", options: [
            { value: "suffix", label: "Add suffix" },
            { value: "skip", label: "Skip" },
            { value: "overwrite", label: "Overwrite" },
          ] }),
          field({ key: "confirm", label: "Confirmation", type: "string", help: "Type OVERWRITE to replace files." }),
          field({ key: "undoManifest", label: "Undo manifest", type: "path" }),
        ],
      },
      async (ctx) => fromItems("out", ctx.items.map((item) => ({ json: moveOne(ctx, item) }))),
    ),
    node(
      {
        id: "fs.copy",
        title: "Copy file",
        description: "Copies a file into an approved folder.",
        category: "files",
        icon: "copy",
        inputs: input,
        outputs: output,
        permissions: ["files.write"],
        fields: [field({ key: "toDir", label: "Destination folder", type: "path", required: true })],
      },
      async (ctx) => fromItems("out", ctx.items.map((item) => {
        const from = resolveInside(ctx.permissions.roots, String(item.json.path));
        const dir = resolveInside(ctx.permissions.roots, readString(ctx, "toDir"));
        mkdirSync(dir, { recursive: true });
        const target = uniquePath(path.join(dir, path.basename(from)), "suffix", "");
        copyFileSync(from, target);
        return { json: { ...item.json, from, path: target, sha256: hashFile(target) } };
      })),
    ),
    node(
      {
        id: "fs.rename",
        title: "Rename file",
        description: "Renames files after an optional dry run. Confirmation is required for real renames.",
        category: "files",
        icon: "file-pen",
        inputs: input,
        outputs: output,
        permissions: ["files.move"],
        fields: [
          field({ key: "dryRun", label: "Dry run", type: "boolean", default: true }),
          field({ key: "confirm", label: "Confirmation", type: "string", help: "Type RENAME to apply." }),
          field({ key: "undoManifest", label: "Undo manifest", type: "path" }),
        ],
      },
      async (ctx) => {
        const dryRun = readBoolean(ctx, "dryRun", true);
        const confirm = readString(ctx, "confirm", "");
        if (!dryRun && confirm !== "RENAME") throw new FlowError("Rename requires confirm = RENAME", "CONFIRM");
        const results = ctx.items.map((item) => {
          const from = resolveInside(ctx.permissions.roots, String(item.json.path ?? item.json.from));
          const to = resolveInside(ctx.permissions.roots, String(item.json.to ?? path.join(path.dirname(from), String(item.json.name ?? path.basename(from)))));
          if (!dryRun) {
            mkdirSync(path.dirname(to), { recursive: true });
            renameSync(from, to);
            appendUndo(ctx, { from, to, action: "rename" });
          }
          return { json: { from, to, dryRun, renamed: !dryRun } };
        });
        return fromItems("out", results);
      },
    ),
    node(
      {
        id: "fs.rollback",
        title: "Rollback moves",
        description: "Replays an undo manifest in reverse.",
        category: "files",
        icon: "undo",
        inputs: input,
        outputs: output,
        permissions: ["files.move"],
        fields: [field({ key: "manifest", label: "Undo manifest", type: "path", required: true })],
      },
      async (ctx) => {
        const manifest = resolveInside(ctx.permissions.roots, readString(ctx, "manifest"));
        const lines = readFileSync(manifest, "utf8").split(/\n/).filter(Boolean);
        const ops = lines.map((line) => JSON.parse(line) as { from: string; to: string }).reverse();
        for (const op of ops) {
          const from = resolveInside(ctx.permissions.roots, op.to);
          const to = resolveInside(ctx.permissions.roots, op.from);
          if (existsSync(from)) renameSync(from, to);
        }
        return single("out", { restored: ops.length, manifest });
      },
    ),
    node(
      {
        id: "fs.backup",
        title: "Folder backup",
        description: "Copies a folder and verifies SHA-256 digests. It does not delete the source.",
        category: "files",
        icon: "archive",
        inputs: input,
        outputs: output,
        permissions: ["files.read", "files.write"],
        fields: [
          field({ key: "source", label: "Source", type: "path", required: true }),
          field({ key: "destination", label: "Destination", type: "path", required: true }),
        ],
      },
      async (ctx) => {
        const source = resolveInside(ctx.permissions.roots, readString(ctx, "source"));
        const destination = resolveInside(ctx.permissions.roots, readString(ctx, "destination"));
        mkdirSync(destination, { recursive: true });
        const files = scanFiles(source, ctx.permissions.roots);
        const mismatches: string[] = [];
        for (const file of files) {
          const relative = path.relative(source, file.path);
          const target = resolveInside(ctx.permissions.roots, path.join(destination, relative));
          mkdirSync(path.dirname(target), { recursive: true });
          copyFileSync(file.path, target);
          if (hashFile(file.path) !== hashFile(target)) mismatches.push(relative);
        }
        if (mismatches.length > 0) throw new FlowError(`Backup checksum mismatch: ${mismatches.join(", ")}`, "CHECKSUM");
        return single("out", { source, destination, files: files.length, verified: true });
      },
    ),
  ];
}

function networkNodes(): NodeDefinition[] {
  return [
    node(
      {
        id: "http.request",
        title: "HTTP request",
        description: "Sends an HTTP request with timeouts, redirect checks, and response limits.",
        category: "network",
        icon: "globe",
        inputs: input,
        outputs: output,
        permissions: ["network"],
        fields: [
          field({ key: "url", label: "URL", type: "string", required: true }),
          field({ key: "method", label: "Method", type: "select", default: "GET", options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((value) => ({ value, label: value })) }),
          field({ key: "headers", label: "Headers", type: "json", default: {} }),
          field({ key: "body", label: "Body", type: "json" }),
          field({ key: "timeoutMs", label: "Timeout", type: "number", default: 15000 }),
        ],
      },
      async (ctx) => {
        if (!ctx.permissions.allowNetwork) throw new FlowError("Network permission is not granted", "PERMISSION");
        const source = ctx.items.length > 0 ? ctx.items : [{ json: {} }];
        const results: Item[] = [];
        for (let index = 0; index < source.length; index += 1) {
          const item = source[index]!;
          const url = String(ctx.interpolate(ctx.rawParameters.url, item, index) ?? "");
          const method = String(ctx.interpolate(ctx.rawParameters.method ?? "GET", item, index) ?? "GET");
          const headers = asObject(ctx.interpolate(ctx.rawParameters.headers ?? {}, item, index));
          const response = await ctx.http({
            url,
            method,
            headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])),
            body: ctx.rawParameters.body === undefined ? undefined : JSON.stringify(ctx.interpolate(ctx.rawParameters.body, item, index)),
            timeoutMs: readNumber(ctx, "timeoutMs", 15000),
          });
          if ((response.status === 429 || response.status >= 500) && readBoolean(ctx, "retryOnError", false)) {
            throw new FlowError(`HTTP ${response.status}`, "HTTP_RETRY", true, retryAfterMs(response.headers));
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(response.body);
          } catch {
            parsed = response.body;
          }
          results.push({ json: { ...item.json, url, status: response.status, headers: response.headers, body: parsed, truncated: response.truncated } });
        }
        return fromItems("out", results);
      },
    ),
    node(
      {
        id: "http.respond",
        title: "Webhook response",
        description: "Sets the HTTP response for a webhook execution.",
        category: "network",
        icon: "reply",
        inputs: input,
        outputs: output,
        permissions: ["webhook"],
        fields: [
          field({ key: "status", label: "Status", type: "number", default: 200 }),
          field({ key: "body", label: "Body", type: "json" }),
        ],
      },
      async (ctx) => {
        const status = readNumber(ctx, "status", 200);
        const body = ctx.rawParameters.body === undefined ? firstItem(ctx).json : readParam(ctx, "body", {});
        ctx.respond?.({ status, body });
        return single("out", { status, responded: true });
      },
    ),
    node(
      {
        id: "http.graphql",
        title: "GraphQL",
        description: "Sends a GraphQL query over HTTP.",
        category: "network",
        icon: "share-2",
        inputs: input,
        outputs: output,
        permissions: ["network"],
        fields: [
          field({ key: "url", label: "URL", type: "string", required: true }),
          field({ key: "query", label: "Query", type: "text", required: true }),
          field({ key: "variables", label: "Variables", type: "json", default: {} }),
        ],
      },
      async (ctx) => {
        const response = await ctx.http({
          url: readString(ctx, "url"),
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query: readString(ctx, "query"), variables: readParam(ctx, "variables", {}) }),
        });
        return single("out", { status: response.status, body: JSON.parse(response.body) });
      },
    ),
    node(
      {
        id: "http.download",
        title: "HTTP download",
        description: "Downloads a response to an approved file, with a size cap.",
        category: "network",
        icon: "download",
        inputs: input,
        outputs: output,
        permissions: ["network", "files.write"],
        fields: [
          field({ key: "url", label: "URL", type: "string", required: true }),
          field({ key: "path", label: "Destination", type: "path", required: true }),
        ],
      },
      async (ctx) => {
        const response = await ctx.http({ url: readString(ctx, "url"), method: "GET" });
        if (response.truncated) throw new FlowError("Download exceeded the size cap", "FILE_LIMIT");
        const file = resolveInside(ctx.permissions.roots, readString(ctx, "path"));
        mkdirSync(path.dirname(file), { recursive: true });
        atomicWrite(file, response.body);
        return single("out", { path: file, status: response.status, bytes: Buffer.byteLength(response.body) });
      },
    ),
    node(
      {
        id: "rss.read",
        title: "RSS read",
        description: "Fetches and parses an RSS or Atom feed.",
        category: "network",
        icon: "rss",
        inputs: input,
        outputs: output,
        permissions: ["network"],
        fields: [field({ key: "url", label: "Feed URL", type: "string", required: true })],
      },
      async (ctx) => {
        const response = await ctx.http({ url: readString(ctx, "url"), method: "GET" });
        return fromItems("out", parseFeed(response.body).map((item) => ({ json: { ...item } })));
      },
    ),
    node(
      {
        id: "email.smtp",
        title: "Send email",
        description: "Sends email through an SMTP server the user configures.",
        category: "connector",
        icon: "mail",
        inputs: input,
        outputs: output,
        permissions: ["email", "network"],
        fields: [
          field({ key: "host", label: "Host", type: "string", required: true }),
          field({ key: "port", label: "Port", type: "number", default: 25 }),
          field({ key: "from", label: "From", type: "string", required: true }),
          field({ key: "to", label: "To", type: "string", required: true }),
          field({ key: "subject", label: "Subject", type: "string", required: true }),
          field({ key: "text", label: "Text", type: "text", required: true }),
          field({ key: "credentialRef", label: "Credential", type: "credential" }),
        ],
      },
      async (ctx) => {
        const secret = ctx.node.credentialRef ? asObject(ctx.secrets.get(ctx.node.credentialRef)) : {};
        const sent = await sendSmtp({
          host: readString(ctx, "host"),
          port: readNumber(ctx, "port", 25),
          username: typeof secret.username === "string" ? secret.username : undefined,
          password: typeof secret.password === "string" ? secret.password : undefined,
          from: readString(ctx, "from"),
          to: readString(ctx, "to"),
          subject: readString(ctx, "subject"),
          text: readString(ctx, "text"),
        });
        ctx.recordDelivery("sent", sent.messageId);
        return single("out", { messageId: sent.messageId, to: readString(ctx, "to") });
      },
    ),
    node(
      {
        id: "github.api",
        title: "GitHub",
        description: "Calls the public GitHub REST API or a demo fixture.",
        category: "connector",
        icon: "github",
        inputs: input,
        outputs: output,
        permissions: ["network"],
        fields: [
          field({ key: "resource", label: "Resource", type: "select", default: "issues", options: [
            { value: "issues", label: "Issues" },
            { value: "releases", label: "Releases" },
          ] }),
          field({ key: "owner", label: "Owner", type: "string", default: "acme" }),
          field({ key: "repo", label: "Repository", type: "string", default: "demo" }),
        ],
      },
      async (ctx) => {
        const mode = String(ctx.services.mode ?? ctx.execution.mode);
        const base = mode === "live" ? "https://api.github.com" : String(ctx.services.githubApi ?? "");
        if (!base) throw new FlowError("GitHub credential or demo fixture is required", "CREDENTIAL_REQUIRED");
        const owner = readString(ctx, "owner", "acme");
        const repo = readString(ctx, "repo", "demo");
        const resource = readString(ctx, "resource", "issues");
        const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "PulseFlow" };
        if (mode === "live") {
          const secret = ctx.node.credentialRef ? asObject(ctx.secrets.get(ctx.node.credentialRef)) : {};
          if (typeof secret.token !== "string" || secret.token.length === 0) {
            throw new FlowError("A GitHub credential is required for live mode", "CREDENTIAL_REQUIRED");
          }
          headers.authorization = `Bearer ${secret.token}`;
        }
        const response = await ctx.http({ url: `${base}/repos/${owner}/${repo}/${resource}`, headers });
        const body = JSON.parse(response.body) as unknown;
        const list = Array.isArray(body) ? body : [];
        return fromItems("out", list.map((entry) => ({ json: asObject(entry) })));
      },
    ),
    node(
      {
        id: "discord.webhook",
        title: "Discord webhook",
        description: "Posts a message to a Discord webhook, or to the local demo fixture.",
        category: "connector",
        icon: "message-circle",
        inputs: input,
        outputs: output,
        permissions: ["network"],
        fields: [field({ key: "content", label: "Content", type: "text", required: true })],
      },
      async (ctx) => {
        const url = String(ctx.services.discordUrl ?? "");
        if (!url) throw new FlowError("Discord webhook is not configured", "CREDENTIAL_REQUIRED");
        const content = readString(ctx, "content");
        const response = await ctx.http({
          url,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
        ctx.recordDelivery(String(response.status), "discord");
        return single("out", { status: response.status, content });
      },
    ),
    node(
      {
        id: "telegram.send",
        title: "Telegram",
        description: "Sends a bot message, or records it in the local demo fixture.",
        category: "connector",
        icon: "send",
        inputs: input,
        outputs: output,
        permissions: ["network"],
        fields: [
          field({ key: "chatId", label: "Chat ID", type: "string", required: true }),
          field({ key: "text", label: "Text", type: "text", required: true }),
        ],
      },
      async (ctx) => {
        const url = String(ctx.services.telegramUrl ?? "");
        if (!url) throw new FlowError("Telegram bot is not configured", "CREDENTIAL_REQUIRED");
        const response = await ctx.http({
          url,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: readString(ctx, "chatId"), text: readString(ctx, "text") }),
        });
        ctx.recordDelivery(String(response.status), "telegram");
        return single("out", { status: response.status, body: JSON.parse(response.body) });
      },
    ),
    node(
      {
        id: "sheets.sync",
        title: "Spreadsheet",
        description: "Reads or writes sheet values through the demo fixture or a user-supplied Sheets API token.",
        category: "connector",
        icon: "table",
        inputs: input,
        outputs: output,
        permissions: ["network"],
        fields: [
          field({ key: "action", label: "Action", type: "select", default: "read", options: [
            { value: "read", label: "Read" },
            { value: "write", label: "Write" },
          ] }),
          field({ key: "values", label: "Values", type: "json" }),
        ],
      },
      async (ctx) => {
        const base = String(ctx.services.sheetsUrl ?? "");
        if (!base) throw new FlowError("Spreadsheet connection is not configured", "CREDENTIAL_REQUIRED");
        if (readString(ctx, "action", "read") === "write") {
          const response = await ctx.http({
            url: base,
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ values: readParam(ctx, "values", []) }),
          });
          return single("out", { status: response.status, body: JSON.parse(response.body) });
        }
        const response = await ctx.http({ url: base, method: "GET" });
        return single("out", JSON.parse(response.body) as Record<string, unknown>);
      },
    ),
    node(
      {
        id: "ai.ollama",
        title: "Ollama",
        description: "Summarizes text with a local Ollama model, or the offline demo fixture. PulseFlow does not require a model.",
        category: "ai",
        icon: "sparkles",
        inputs: input,
        outputs: output,
        permissions: ["ai", "network"],
        fields: [
          field({ key: "prompt", label: "Prompt", type: "text", required: true }),
          field({ key: "model", label: "Model", type: "string", default: "llama3.2" }),
        ],
      },
      async (ctx) => {
        const url = String(ctx.services.ollamaUrl ?? "");
        if (!url) throw new FlowError("Ollama is not configured. Demo mode uses the local fixture.", "OLLAMA_UNAVAILABLE");
        const response = await ctx.http({
          url,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: readString(ctx, "model", "llama3.2"), prompt: readString(ctx, "prompt"), stream: false }),
        });
        const body = JSON.parse(response.body) as { response?: string };
        return single("out", { summary: body.response ?? "", model: readString(ctx, "model", "fixture") });
      },
    ),
    node(
      {
        id: "browser.extract",
        title: "Page extract",
        description: "Demo mode fetches HTML and extracts the title and links. Live mode requires Playwright and does not bypass site protections.",
        category: "developer",
        icon: "globe",
        inputs: input,
        outputs: output,
        permissions: ["network", "browser"],
        dangerous: true,
        fields: [field({ key: "url", label: "URL", type: "string", required: true })],
      },
      async (ctx) => {
        if (ctx.execution.mode === "live") {
          throw new FlowError(
            "Live browser automation requires a local Playwright install and an explicit per-workflow grant. It is not enabled in this run.",
            "BROWSER_UNAVAILABLE",
          );
        }
        const response = await ctx.http({ url: readString(ctx, "url"), method: "GET" });
        const extracted = extractHtml(response.body);
        return single("out", { ...extracted, csv: toCsv([{ title: extracted.title, links: extracted.links.join(" ") }]) });
      },
    ),
  ];
}

function developerNodes(): NodeDefinition[] {
  return [
    node(
      {
        id: "sqlite.query",
        title: "SQLite query",
        description: "Runs one parameterized statement against a database inside an approved folder.",
        category: "developer",
        icon: "database",
        inputs: input,
        outputs: output,
        permissions: ["database", "files.read", "files.write"],
        fields: [
          field({ key: "database", label: "Database file", type: "path", required: true }),
          field({ key: "sql", label: "SQL", type: "text", required: true }),
          field({ key: "params", label: "Parameters", type: "json", default: [] }),
        ],
      },
      async (ctx) => {
        const sql = readString(ctx, "sql").trim();
        if (sql.includes(";") || /\{\{/.test(sql) || /\b(attach|detach|load_extension|pragma)\b/i.test(sql)) {
          throw new FlowError("SQL must be one parameterized statement without PRAGMA or ATTACH", "SQL_DENIED");
        }
        const file = resolveInside(ctx.permissions.roots, readString(ctx, "database"));
        const database = new DatabaseSync(file);
        try {
          const rawParams = readParam(ctx, "params", []);
          const params = (Array.isArray(rawParams) ? rawParams : []) as Array<string | number | bigint | null>;
          const statement = database.prepare(sql);
          if (/^select/i.test(sql)) {
            return fromItems("out", statement.all(...params).map((row) => ({ json: asObject(row) })));
          }
          const result = statement.run(...params);
          return single("out", { changes: Number(result.changes) });
        } finally {
          database.close();
        }
      },
    ),
    node(
      {
        id: "postgres.query",
        title: "PostgreSQL query",
        description: "Optional. Requires a user-provided host and the pg package. PulseFlow does not install a database for you.",
        category: "developer",
        icon: "database",
        inputs: input,
        outputs: output,
        permissions: ["database", "network"],
        fields: [
          field({ key: "connectionString", label: "Connection string", type: "string", secret: true }),
          field({ key: "sql", label: "SQL", type: "text", required: true }),
          field({ key: "params", label: "Parameters", type: "json", default: [] }),
        ],
      },
      async (ctx) => {
        const connectionString = readString(ctx, "connectionString", "");
        if (!connectionString) throw new FlowError("PostgreSQL requires a connection string", "POSTGRES_UNAVAILABLE");
        const sql = readString(ctx, "sql");
        if (sql.includes(";") || /\{\{/.test(sql)) throw new FlowError("SQL must be one parameterized statement", "SQL_DENIED");
        const loadOptional = new Function("specifier", "return import(specifier)") as (
          specifier: string,
        ) => Promise<{
          Client: new (config: { connectionString: string }) => {
            connect: () => Promise<void>;
            query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
            end: () => Promise<void>;
          };
        }>;
        const imported = await loadOptional("pg").catch(() => null);
        if (!imported) throw new FlowError("The optional pg package is not installed", "POSTGRES_UNAVAILABLE");
        const Client = imported.Client;
        const client = new Client({ connectionString });
        await client.connect();
        try {
          const params = Array.isArray(readParam(ctx, "params", [])) ? (readParam(ctx, "params", []) as unknown[]) : [];
          const result = await client.query(sql, params);
          return fromItems("out", result.rows.map((row) => ({ json: asObject(row) })));
        } finally {
          await client.end();
        }
      },
    ),
    node(
      {
        id: "git.local",
        title: "Git",
        description: "Runs a read-only local git command, or a confirmed commit, inside an approved repository.",
        category: "developer",
        icon: "git-branch",
        inputs: input,
        outputs: output,
        permissions: ["files.read"],
        fields: [
          field({ key: "repo", label: "Repository", type: "path", required: true }),
          field({ key: "action", label: "Action", type: "select", default: "status", options: [
            { value: "status", label: "Status" },
            { value: "log", label: "Log" },
            { value: "diff", label: "Diff" },
          ] }),
        ],
      },
      async (ctx) => {
        const repo = resolveInside(ctx.permissions.roots, readString(ctx, "repo"));
        const action = readString(ctx, "action", "status");
        const args = action === "log" ? ["log", "-n", "5", "--oneline"] : action === "diff" ? ["diff", "--stat"] : ["status", "--short"];
        const result = await runCommand("git", ["-C", repo, ...args], ctx.permissions.roots[0] ?? repo, ctx.signal, 10_000);
        if (result.code !== 0) throw new FlowError(result.stderr || "git failed", "GIT");
        return single("out", { action, output: result.stdout });
      },
    ),
    node(
      {
        id: "code.shell",
        title: "Shell",
        description: "Disabled unless the workflow explicitly grants shell and the node confirmation matches. This is not a security sandbox.",
        category: "developer",
        icon: "terminal",
        inputs: input,
        outputs: output,
        permissions: ["shell"],
        dangerous: true,
        fields: [
          field({ key: "command", label: "Command", type: "string", required: true }),
          field({ key: "args", label: "Arguments", type: "json", default: [] }),
          field({ key: "confirm", label: "Confirmation", type: "string" }),
        ],
      },
      async (ctx) => {
        if (!ctx.permissions.allowShell || ctx.node.parameters.confirm !== "I_UNDERSTAND_SHELL") {
          throw new FlowError("Shell is disabled until the workflow grants it and confirm is I_UNDERSTAND_SHELL", "SHELL_DENIED");
        }
        const command = readString(ctx, "command");
        if (command.includes("/") || command.includes("\\") || command.includes("..")) {
          throw new FlowError("Shell command must be a bare executable name", "SHELL_DENIED");
        }
        const args = Array.isArray(readParam(ctx, "args", [])) ? (readParam(ctx, "args", []) as unknown[]).map(String) : [];
        const cwd = ctx.permissions.roots[0];
        if (!cwd) throw new FlowError("No approved folder for the shell", "SHELL_DENIED");
        const result = await runCommand(command, args, cwd, ctx.signal, ctx.node.timeoutMs ?? 10_000);
        return single("out", { code: result.code, stdout: result.stdout, stderr: result.stderr });
      },
    ),
  ];
}

function exprOf(ctx: NodeContext, key: string): string {
  const value = ctx.rawParameters[key];
  return typeof value === "string" ? value : "null";
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  if (value === undefined || value === null) return {};
  return { value: value as string | number | boolean };
}

function asFieldList(value: unknown): Array<{ name: string; value: unknown }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asObject(entry))
    .filter((entry) => typeof entry.name === "string")
    .map((entry) => ({ name: String(entry.name), value: entry.value }));
}

function atomicWrite(file: string, text: string): void {
  const temp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function scanFiles(folder: string, roots: string[]): Array<{ path: string; name: string; size: number }> {
  const found: Array<{ path: string; name: string; size: number }> = [];
  const visit = (current: string) => {
    if (found.length > 5000) throw new FlowError("Directory scan exceeded 5000 files", "FILE_LIMIT");
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(resolveInside(roots, full));
      } else if (entry.isFile()) {
        const file = resolveInside(roots, full);
        const stat = lstatSync(file);
        found.push({ path: file, name: entry.name, size: stat.size });
      }
    }
  };
  visit(folder);
  return found;
}

function uniquePath(target: string, collision: string, confirm: string): string {
  if (!existsSync(target)) return target;
  if (collision === "skip") return target;
  if (collision === "overwrite") {
    if (confirm !== "OVERWRITE") throw new FlowError("Overwrite requires confirmation OVERWRITE", "CONFIRM");
    return target;
  }
  const extension = path.extname(target);
  const base = path.basename(target, extension);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(path.dirname(target), `${base}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new FlowError("No free filename was available", "COLLISION");
}

function moveOne(ctx: NodeContext, item: Item): Record<string, unknown> {
  const from = resolveInside(ctx.permissions.roots, String(item.json.path ?? ""));
  const dir = resolveInside(ctx.permissions.roots, readString(ctx, "toDir"));
  mkdirSync(dir, { recursive: true });
  const collision = readString(ctx, "collision", "suffix");
  const desired = path.join(dir, path.basename(from));
  if (collision === "skip" && existsSync(desired)) return { from, path: from, skipped: true };
  const target = uniquePath(desired, collision, readString(ctx, "confirm", ""));
  renameSync(from, target);
  appendUndo(ctx, { from, to: target, action: "move" });
  return { from, path: target, skipped: false };
}

function appendUndo(ctx: NodeContext, entry: { from: string; to: string; action: string }): void {
  const manifest = ctx.rawParameters.undoManifest;
  if (typeof manifest !== "string" || manifest.length === 0) return;
  const file = resolveInside(ctx.permissions.roots, String(ctx.interpolate(manifest, firstItem(ctx), 0) ?? ""));
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char !== "\r") field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows
    .filter((cells) => cells.some((cell) => cell.length > 0))
    .map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] ?? "";
      });
      return record;
    });
}

function toCsv(rows: Record<string, unknown>[]): string {
  const flat = rows.map((row) => flatten(row));
  const headers = [...new Set(flat.flatMap((row) => Object.keys(row)))];
  const lines = [headers.map(escapeCsv).join(",")];
  for (const row of flat) lines.push(headers.map((header) => escapeCsv(row[header] ?? "")).join(","));
  return `${lines.join("\n")}\n`;
}

function flatten(value: Record<string, unknown>, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [key, entry] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) flatten(entry as Record<string, unknown>, next, out);
    else if (Array.isArray(entry)) out[next] = JSON.stringify(entry);
    else out[next] = entry === undefined || entry === null ? "" : String(entry);
  }
  return out;
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        PATHEXT: process.env.PATHEXT ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 200_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 200_000) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FlowError("Process timed out", "TIMEOUT"));
    }, timeoutMs);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
