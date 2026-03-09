import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CommandError extends Error {
  stdout: string;
  stderr: string;
  code: number | null;

  constructor(message: string, stdout = "", stderr = "", code: number | null = null) {
    super(message);
    this.name = "CommandError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };

    throw new CommandError(
      execError.message,
      execError.stdout ?? "",
      execError.stderr ?? "",
      typeof execError.code === "number" ? execError.code : null
    );
  }
}
