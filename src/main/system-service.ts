import type { CliHealth, SettingsRecord } from "../shared/contracts";
import { CommandError, runCommand } from "./command";
import { AppStore } from "./store";

function getExecutablePath(settings: SettingsRecord): string {
  return settings.cliExecutablePath?.trim() || "copilot";
}

function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function isAuthError(output: string): boolean {
  return /not logged in|login required|authenticate|auth required/i.test(output);
}

export async function getCliHealth(store: AppStore): Promise<CliHealth> {
  const settings = await store.getSettings();
  const executablePath = getExecutablePath(settings);

  try {
    const versionResult = await runCommand(executablePath, ["version"]);
    const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);

    try {
      const authResult = await runCommand(executablePath, ["auth", "status"]);
      const combined = `${authResult.stdout}\n${authResult.stderr}`;
      const cliHealth: CliHealth = {
        installed: true,
        version,
        executablePath,
        state: isAuthError(combined) ? "auth_required" : "ready",
        error: isAuthError(combined) ? combined.trim() || "Authentication is required." : null
      };
      return await store.setCliHealth(cliHealth);
    } catch (error) {
      if (error instanceof CommandError && isAuthError(`${error.stdout}\n${error.stderr}\n${error.message}`)) {
        return await store.setCliHealth({
          installed: true,
          version,
          executablePath,
          state: "auth_required",
          error: `${error.stdout}\n${error.stderr}`.trim() || error.message
        });
      }

      return await store.setCliHealth({
        installed: true,
        version,
        executablePath,
        state: "ready",
        error: null
      });
    }
  } catch (error) {
    if (error instanceof CommandError && /spawn .* ENOENT|not found|ENOENT/i.test(error.message)) {
      return await store.setCliHealth({
        installed: false,
        version: null,
        executablePath,
        state: "missing",
        error: "GitHub Copilot CLI is not installed."
      });
    }

    return await store.setCliHealth({
      installed: false,
      version: null,
      executablePath,
      state: "error",
      error: error instanceof Error ? error.message : "Unable to inspect Copilot CLI."
    });
  }
}

export function resolveCliExecutable(settings: SettingsRecord): string {
  return getExecutablePath(settings);
}
