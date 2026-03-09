import type { MessageRecord } from "./contracts";

const FALLBACK_TITLE = "New thread";
const MAX_TITLE_LENGTH = 56;
const MAX_SUMMARY_LENGTH = 280;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function deriveThreadTitle(text: string): string {
  const normalized = compactWhitespace(text);

  if (!normalized) {
    return FALLBACK_TITLE;
  }

  return normalized.length > MAX_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : normalized;
}

export function summarizeMessages(messages: MessageRecord[]): string {
  const meaningful = messages
    .filter((message) => message.kind === "message" || message.kind === "error")
    .slice(-6)
    .map((message) => `${message.role}: ${compactWhitespace(message.content)}`)
    .filter(Boolean);

  if (!meaningful.length) {
    return "";
  }

  const summary = meaningful.join(" | ");
  return summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
    : summary;
}
