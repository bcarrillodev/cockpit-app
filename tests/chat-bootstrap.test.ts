import { describe, expect, it } from "vitest";
import { buildBootstrapPrompt } from "../src/shared/chat-bootstrap";

describe("buildBootstrapPrompt", () => {
  it("embeds summary and recent transcript for resumed threads", () => {
    const prompt = buildBootstrapPrompt(
      "User is migrating the app to Electron.",
      [
        {
          id: "1",
          threadId: "thread-1",
          role: "user",
          content: "Set up Electron.",
          createdAt: "2026-03-08T10:00:00.000Z",
          kind: "message"
        },
        {
          id: "2",
          threadId: "thread-1",
          role: "assistant",
          content: "I will scaffold the shell.",
          createdAt: "2026-03-08T10:01:00.000Z",
          kind: "message"
        }
      ],
      "Now add Tailwind."
    );

    expect(prompt).toContain("Summary:");
    expect(prompt).toContain("USER: Set up Electron.");
    expect(prompt).toContain("ASSISTANT: I will scaffold the shell.");
    expect(prompt).toContain("New user message:\nNow add Tailwind.");
  });

  it("returns the plain user prompt when there is no stored context", () => {
    expect(buildBootstrapPrompt("", [], "Hello")).toBe("Hello");
  });
});
