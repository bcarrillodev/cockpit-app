import type { ChangedFileRecord, GitStatus } from "./contracts";

export function normalizeGitStatus(output: string): GitStatus {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changedCount = 0;
  let untrackedCount = 0;

  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? "detached" : value;
      continue;
    }

    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      ahead = match ? Number(match[1]) : 0;
      behind = match ? Number(match[2]) : 0;
      continue;
    }

    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("? ")) {
      untrackedCount += 1;
    }

    changedCount += 1;
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    changedCount,
    untrackedCount,
    isClean: changedCount === 0
  };
}

export function parseChangedFiles(output: string): ChangedFileRecord[] {
  const files: ChangedFileRecord[] = [];

  for (const line of output.split("\n")) {
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("? ")) {
      files.push({
        path: line.slice(2).trim(),
        stagedStatus: "?",
        worktreeStatus: "?",
        isUntracked: true
      });
      continue;
    }

    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    const stagedStatus = xy[0] && xy[0] !== "." ? xy[0] : null;
    const worktreeStatus = xy[1] && xy[1] !== "." ? xy[1] : null;
    const pathIndex = parts[0] === "2" ? 9 : 8;
    const path = parts.slice(pathIndex).join(" ").split("\t")[0]?.trim() ?? "";

    if (!path) {
      continue;
    }

    files.push({
      path,
      stagedStatus,
      worktreeStatus,
      isUntracked: false
    });
  }

  return files;
}
