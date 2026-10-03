import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalize, hashValue, sha256Hex } from "../src/canonical";

describe("canonical serialization", () => {
  it("sorts keys recursively and drops undefined", () => {
    const a = { b: 1, a: { z: undefined, y: [{ q: 1, p: 2 }] } };
    expect(canonicalJson(a)).toBe('{"a":{"y":[{"p":2,"q":1}]},"b":1}');
  });

  it("is independent of key insertion order", () => {
    const a = { x: 1, y: { k: [1, 2], j: "s" } };
    const b = { y: { j: "s", k: [1, 2] }, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("rounds floating point noise and folds negative zero", () => {
    expect(canonicalize(0.1 + 0.2)).toBe(0.3);
    expect(canonicalJson({ v: -0 })).toBe('{"v":0}');
    expect(canonicalJson({ v: 1e-7 })).toBe('{"v":1e-7}');
    expect(canonicalize(0.05 / 1000)).toBe(0.00005);
  });

  it("rejects values that have no canonical form", () => {
    expect(() => canonicalJson({ v: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ v: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/non-plain/);
  });

  it("hashes with sha256", async () => {
    expect(await sha256Hex("{}")).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(await hashValue({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(await hashValue({ b: 1, a: 2 })).toBe(await hashValue({ a: 2, b: 1 }));
  });
});
