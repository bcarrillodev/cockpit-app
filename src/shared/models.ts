import type { ModelDiscoveryResult, ModelRecord } from "./contracts";

const MODEL_LINE_PATTERNS = [
  /`([^`]+)`\s*[-:]\s*(.+)$/i,
  /^\s*[-*]\s*`([^`]+)`\s*[-:]\s*(.+)$/i,
  /^\s*[-*]\s*([a-z0-9][a-z0-9._-]+)\s*[-:]\s*(.+)$/i,
  /^\s*\d+\.\s*`([^`]+)`\s*[-:]\s*(.+)$/i
];

export function parseDiscoveredModels(raw: string): ModelRecord[] {
  const models = new Map<string, ModelRecord>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    for (const pattern of MODEL_LINE_PATTERNS) {
      const match = trimmed.match(pattern);
      if (!match) {
        continue;
      }

      const modelId = match[1]?.trim();
      const name = match[2]?.trim() || modelId;

      if (modelId) {
        models.set(modelId, { modelId, name });
      }
      break;
    }

    if (/^[a-z0-9][a-z0-9._-]+$/i.test(trimmed)) {
      models.set(trimmed, { modelId: trimmed, name: trimmed });
    }
  }

  return [...models.values()];
}

export function buildFallbackDiscovery(
  modelId: string | null,
  error?: string
): ModelDiscoveryResult {
  const models = modelId ? [{ modelId, name: modelId }] : [];
  return {
    models,
    currentModelId: modelId,
    discoveredAt: new Date().toISOString(),
    source: "fallback",
    error
  };
}
