import { describe, expect, it } from "vitest";
import { normalizeGitStatus, parseChangedFiles } from "../src/shared/git";

describe("git helpers", () => {
  it("normalizes porcelain v2 status output", () => {
    const status = normalizeGitStatus(`# branch.oid abc123
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 .M N... 100644 100644 100644 abc def src/main.ts
? README.md
`);

    expect(status).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      changedCount: 2,
      untrackedCount: 1,
      isClean: false
    });
  });

  it("parses changed files from porcelain v2 output", () => {
    const files = parseChangedFiles(`1 MM N... 100644 100644 100644 abc def src/main.ts
? README.md
`);

    expect(files).toEqual([
      {
        path: "src/main.ts",
        stagedStatus: "M",
        worktreeStatus: "M",
        isUntracked: false
      },
      {
        path: "README.md",
        stagedStatus: "?",
        worktreeStatus: "?",
        isUntracked: true
      }
    ]);
  });
});
