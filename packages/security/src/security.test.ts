import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBundle } from "@pulseflow/contracts";
import { decryptJson, encryptJson, ipAllowed, redactValue, resolveInside } from "./index";

describe("security", () => {
  it("redacts secrets and blocks prototype keys on import", () => {
    expect(redactValue({ authorization: "Bearer abc.def", note: "ok" })).toEqual({
      authorization: "[redacted]",
      note: "ok",
    });
    const bundle = parseBundle({
      schemaVersion: 1,
      kind: "pulseflow.bundle",
      exportedAt: "2026-10-12T00:00:00.000Z",
      workflows: [
        {
          name: "Demo",
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                id: "manual",
                manifestId: "trigger.manual",
                manifestVersion: "1.0.0",
                position: { x: 0, y: 0 },
                parameters: { payload: { __proto__: { admin: true }, name: "PulseFlow" } },
              },
            ],
            edges: [],
          },
        },
      ],
    });
    const parameters = bundle.workflows[0]?.graph.nodes[0]?.parameters.payload as Record<string, unknown>;
    expect(Object.hasOwn(parameters, "__proto__")).toBe(false);
    expect(parameters?.name).toBe("PulseFlow");
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });

  it("keeps file paths inside approved roots and blocks metadata addresses", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pf-root-"));
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(path.join(root, "nested", "note.txt"), "ok");
    expect(resolveInside([root], path.join(root, "nested", "note.txt"))).toContain("note.txt");
    expect(() => resolveInside([root], path.join(root, "..", "passwd"))).toThrow(/outside approved/);
    const outside = mkdtempSync(path.join(tmpdir(), "pf-out-"));
    const link = path.join(root, "escape");
    symlinkSync(outside, link);
    expect(() => resolveInside([root], path.join(link, "secret.txt"))).toThrow(/escapes|outside/);
    expect(ipAllowed("169.254.169.254", { allowLoopback: true, allowPrivate: true })).toBe(false);
    expect(ipAllowed("127.0.0.1", { allowLoopback: true, allowPrivate: false })).toBe(true);
    expect(ipAllowed("127.0.0.1", { allowLoopback: false, allowPrivate: false })).toBe(false);
  });

  it("round-trips encrypted credential JSON", () => {
    const key = Buffer.alloc(32, 7);
    const blob = encryptJson({ token: "secret-token" }, key);
    expect(JSON.stringify(blob)).not.toContain("secret-token");
    expect(decryptJson(blob, key)).toEqual({ token: "secret-token" });
  });
});
