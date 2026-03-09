import type { ChangedFileRecord, CommitAndPushInput, CommitAndPushResult, GitStatus } from "../shared/contracts";
import { normalizeGitStatus, parseChangedFiles } from "../shared/git";
import { CommandError, runCommand } from "./command";

function emptyStatus(): GitStatus {
  return {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changedCount: 0,
    untrackedCount: 0,
    isClean: true
  };
}

function isNotGitRepo(error: unknown): boolean {
  return error instanceof CommandError && /not a git repository/i.test(`${error.message}\n${error.stderr}`);
}

export async function getGitStatus(rootPath: string): Promise<GitStatus> {
  try {
    const { stdout } = await runCommand("git", ["-C", rootPath, "status", "--branch", "--porcelain=v2"]);
    return normalizeGitStatus(stdout);
  } catch (error) {
    if (isNotGitRepo(error)) {
      return emptyStatus();
    }
    throw error;
  }
}

export async function listChangedFiles(rootPath: string): Promise<ChangedFileRecord[]> {
  try {
    const { stdout } = await runCommand("git", ["-C", rootPath, "status", "--branch", "--porcelain=v2"]);
    return parseChangedFiles(stdout);
  } catch (error) {
    if (isNotGitRepo(error)) {
      return [];
    }
    throw error;
  }
}

export async function commitAndPush(input: CommitAndPushInput): Promise<CommitAndPushResult> {
  const message = input.message.trim();
  if (!message) {
    throw new Error("Commit message is required.");
  }

  try {
    await runCommand("git", ["-C", input.rootPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch (error) {
    throw new Error("No upstream branch is configured for this repository.");
  }

  const addResult = await runCommand("git", ["-C", input.rootPath, "add", "-A"]);
  const commitResult = await runCommand("git", ["-C", input.rootPath, "commit", "-m", message]);
  const pushResult = await runCommand("git", ["-C", input.rootPath, "push"]);

  return {
    stdout: [addResult.stdout, commitResult.stdout, pushResult.stdout].filter(Boolean).join("\n"),
    stderr: [addResult.stderr, commitResult.stderr, pushResult.stderr].filter(Boolean).join("\n")
  };
}
