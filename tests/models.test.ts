import { describe, expect, it } from "vitest";
import { parseDiscoveredModels } from "../src/shared/models";

describe("parseDiscoveredModels", () => {
  it("parses markdown-style model listings", () => {
    const models = parseDiscoveredModels(`
- \`gpt-5\` - GPT-5
- \`claude-sonnet-4\` - Claude Sonnet 4
`);

    expect(models).toEqual([
      { modelId: "gpt-5", name: "GPT-5" },
      { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
    ]);
  });

  it("falls back to simple identifiers when the list is plain text", () => {
    const models = parseDiscoveredModels("gpt-5\nclaude-sonnet-4");
    expect(models.map((model) => model.modelId)).toEqual(["gpt-5", "claude-sonnet-4"]);
  });

  it("parses markdown tables returned by /models", () => {
    const models = parseDiscoveredModels(`
| Model | ID | Tier |
|---|---|---|
| GPT-5.4 | \`gpt-5.4\` | standard |
| Claude Sonnet 4.6 | \`claude-sonnet-4.6\` | standard |
`);

    expect(models).toEqual([
      { modelId: "gpt-5.4", name: "GPT-5.4" },
      { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }
    ]);
  });
});
