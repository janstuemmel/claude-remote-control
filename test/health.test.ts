import { describe, expect, it } from "vitest";
import { compareVersions } from "../src/health.js";

describe("compareVersions", () => {
  it("compares semantic version components numerically", () => {
    expect(compareVersions("2.1.51", "2.1.51")).toBe(0);
    expect(compareVersions("2.2.0", "2.1.51")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.51")).toBe(-1);
  });
});
