import { describe, expect, it } from "vitest";
import { evaluate, interpolate, parseExpression } from "./expr";

const ctx = {
  now: () => Date.parse("2026-10-12T12:00:00.000Z"),
  scope: {
    $json: { name: "PulseFlow", count: 2 },
    $paths: { demo: "/demo" },
    $index: 0,
  },
};

describe("expressions", () => {
  it("evaluates arithmetic, strings, and comparisons without eval", () => {
    expect(evaluate(parseExpression('1 + 2 * 3'), ctx)).toBe(7);
    expect(evaluate(parseExpression('$json.name == "PulseFlow"'), ctx)).toBe(true);
    expect(evaluate(parseExpression('upper("ab")'), ctx)).toBe("AB");
    expect(evaluate(parseExpression("false && (1 / 0)"), ctx)).toBe(false);
    expect(evaluate(parseExpression('concat("Hello, ", $json.name)'), ctx)).toBe("Hello, PulseFlow");
  });

  it("interpolates whole expressions as raw values and rejects forbidden access", () => {
    expect(interpolate("{{ $json.count }}", ctx)).toBe(2);
    expect(interpolate("{{ $paths.demo }}/hello.json", ctx)).toBe("/demo/hello.json");
    expect(() => parseExpression("$json.constructor")).toThrow(/Forbidden/);
    expect(() => parseExpression('evil()')).toThrow(/Unknown function/);
  });
});
