import type { MessageRecord } from "./contracts";

const MAX_CONTEXT_MESSAGES = 8;
const MAX_MESSAGE_PREVIEW = 1200;

function trimMessage(content: string): string {
  const normalized = content.trim();
  return normalized.length > MAX_MESSAGE_PREVIEW
    ? `${normalized.slice(0, MAX_MESSAGE_PREVIEW - 1).trimEnd()}…`
    : normalized;
}

export function buildBootstrapPrompt(
  summary: string,
  messages: MessageRecord[],
  userPrompt: string
): string {
  const recentMessages = messages
    .filter((message) => message.kind === "message" || message.kind === "error")
    .slice(-MAX_CONTEXT_MESSAGES);

  if (!summary && recentMessages.length === 0) {
    return userPrompt;
  }

  const transcript = recentMessages
    .map((message) => `${message.role.toUpperCase()}: ${trimMessage(message.content)}`)
    .join("\n\n");

  return [
    "Continue this Cockpit conversation using the preserved context below.",
    "",
    summary ? `Summary:\n${summary}` : "",
    transcript ? `Recent transcript:\n${transcript}` : "",
    `New user message:\n${userPrompt}`
  ]
    .filter(Boolean)
    .join("\n\n");
}
