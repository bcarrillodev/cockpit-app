import { describe, expect, it } from "vitest";
import { deriveThreadTitle, summarizeMessages } from "../src/shared/threads";

describe("thread helpers", () => {
  it("derives compact thread titles", () => {
    expect(deriveThreadTitle("   Build a polished desktop shell for this repo   ")).toBe(
      "Build a polished desktop shell for this repo"
    );
  });

  it("summarizes the latest meaningful messages", () => {
    const summary = summarizeMessages([
      {
        id: "1",
        threadId: "t1",
        role: "user",
        content: "Audit the app.",
        createdAt: "2026-03-08T10:00:00.000Z",
        kind: "message"
      },
      {
        id: "2",
        threadId: "t1",
        role: "assistant",
        content: "I found an auth bug.",
        createdAt: "2026-03-08T10:01:00.000Z",
        kind: "message"
      }
    ]);

    expect(summary).toContain("user: Audit the app.");
    expect(summary).toContain("assistant: I found an auth bug.");
  });
});
