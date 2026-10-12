import type { TMessage } from '@/common/chat/chatLib';
import { readMessageContent } from '@/renderer/utils/chat/conversationExport';
import { hasThinkTags, stripThinkTags } from '@/renderer/utils/chat/thinkTagFilter';

export const buildAutoTitleFromContent = (content: string): string | null => {
  // A prompt is private chat content, not safe sidebar metadata. Keep the
  // placeholder when it contains credentials; check before truncation.
  if (
    /(?:password|passwd|pwd|secret|token|api[_ -]?key|парол[ьья]|токен)(?:\s*["']?\s*[:=]|\s+\S+)|\bbearer\s+\S+|-----BEGIN [\w ]*PRIVATE KEY-----|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/[^\s]*[?@#]|\b(?:sk-|ghp_|github_pat_)[a-z0-9_-]{12,}/iu.test(
      content
    )
  ) {
    return null;
  }
  const withoutThinkTags = hasThinkTags(content) ? stripThinkTags(content) : content;
  const lines = withoutThinkTags
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '```');

  const firstLine = lines[0] ?? '';
  const normalized = firstLine
    .replace(/^[#>*\-\d.\s]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);

  return normalized || null;
};

/**
 * Pick the very first user prompt from conversation history.
 * Falls back to the current send-box content when history has no user prompt yet.
 */
export const deriveAutoTitleFromMessages = (messages: TMessage[], fallbackContent?: string): string | null => {
  for (const message of messages) {
    if (message.type !== 'text' || message.position !== 'right') {
      continue;
    }

    const title = buildAutoTitleFromContent(readMessageContent(message));
    if (title) {
      return title;
    }
  }

  if (fallbackContent) {
    return buildAutoTitleFromContent(fallbackContent);
  }

  return null;
};
