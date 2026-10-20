import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "./format";

describe("formatBytes", () => {
  it("uses decimal units like Finder", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(4_096)).toBe("4.1 KB");
    expect(formatBytes(979_000_000)).toBe("979 MB");
    expect(formatBytes(3_670_000_000)).toBe("3.7 GB");
    expect(formatBytes(1_500_000_000_000)).toBe("1.5 TB");
  });
});

describe("formatDuration", () => {
  it("shows seconds, then minutes", () => {
    expect(formatDuration(24_600)).toBe("24.6 s");
    expect(formatDuration(98_000)).toBe("1 min 38 s");
  });
});
