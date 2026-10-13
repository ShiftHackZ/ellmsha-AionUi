import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';
import { normalizeAcpToolCall } from '@/common/chat/normalizeToolCall';

describe('normalizeToolCall', () => {
  it('normalizes compact snake_case acp tool calls from history responses', () => {
    const result = normalizeAcpToolCall({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        _compact: {
          truncated: true,
          original_size: 90000,
          preview_chars: 4096,
        },
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result).toMatchObject({
      key: 'tool-1',
      name: 'rg',
      status: 'completed',
      description: '"needle" in .',
      output: 'preview',
      truncated: true,
      messageId: 'message-1',
      conversationId: 'conversation-1',
    });
  });

  it('ignores malformed ACP content items in compact history output', () => {
    const result = normalizeAcpToolCall({
      id: 'message-2',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-2',
          status: 'completed',
          title: 'Edit file',
          kind: 'edit',
          content: [null, 'invalid', { type: 'diff', path: '/workspace/file.ts', old_text: 'old', new_text: 'new' }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result?.output).toBe('[diff] /workspace/file.ts');
  });
});

describe('Codex collapsed tool labels', () => {
  it('shows exact MCP server/tool but no argument previews', async () => {
    const { normalizeToolCall } = await import('@/common/chat/normalizeToolCall');
    const message = {
      content: {
        call_id: 'x',
        name: 'mcpToolCall',
        input: { server: 'browser', tool: 'take_snapshot', arguments: { token: 'PRIVATE' } },
        description: 'PRIVATE',
        status: 'running',
      },
    };
    const result = normalizeToolCall(message as never);
    expect(result).toMatchObject({ name: 'browser · take_snapshot', status: 'running' });
    expect(result?.description).toBeUndefined();
    expect(result?.input).toContain('PRIVATE'); // Full details remain available only when expanded.
  });
  it('only includes known executable/subcommand words, never shell arguments or assignments', async () => {
    const { normalizeToolCall } = await import('@/common/chat/normalizeToolCall');
    for (const [command, expected] of [
      ['git diff --password=PRIVATE', 'git diff'],
      ['curl https://user:PRIVATE@host/', 'curl'],
      ['TOKEN=PRIVATE curl host', 'shell'],
      ['echo PRIVATE', 'shell'],
    ]) {
      const result = normalizeToolCall({
        content: { call_id: 'x', name: 'commandExecution', input: { command }, description: command },
      } as never);
      expect(result?.name).toBe(expected);
      expect(result?.description).toBeUndefined();
    }
  });
});
