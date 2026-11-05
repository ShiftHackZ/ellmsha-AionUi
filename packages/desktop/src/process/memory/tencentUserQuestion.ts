import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callMemoryChatHost, hasMemoryChatBinding } from './project';

export function registerUserQuestionTool(server: McpServer): void {
  if (!hasMemoryChatBinding()) return;
  server.tool(
    'ellmsha_ask_user',
    'Ask the user in this chat when a decision is needed. Shows a question form and returns the selected or typed answers. Prefer the harness’s native question tool when available.',
    {
      questions: z
        .array(
          z.object({
            id: z.string().trim().min(1).max(256),
            header: z.string().max(512).default(''),
            question: z.string().trim().min(1).max(8192),
            options: z
              .array(
                z.object({ label: z.string().trim().min(1).max(2048), description: z.string().max(4096).default('') })
              )
              .max(32)
              .default([]),
            multiSelect: z.boolean().default(false),
            isOther: z.boolean().default(true),
            isSecret: z.boolean().default(false),
          })
        )
        .min(1)
        .max(12),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ questions }, extra) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await callMemoryChatHost('question', undefined, questions, extra.signal)),
        },
      ],
    })
  );
}
