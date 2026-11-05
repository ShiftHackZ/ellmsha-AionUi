import type { ChatRuleMutation } from '@/common/types/agent/chatRules';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callMemoryChatHost, hasMemoryChatBinding } from './project';

const identity = { path: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{64}$/) };
const write = z
  .object({
    title: z.string().trim().min(1),
    content: z.string().trim().min(1),
    path: identity.path.optional(),
    revision: identity.revision.optional(),
  })
  .strict();
const remove = z.object(identity).strict();
const mutationHints = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

async function save(mutation: ChatRuleMutation) {
  const operation = mutation.action === 'delete' ? 'delete' : 'write';
  await callMemoryChatHost(`rules/${mutation.scope}/${operation}`, mutation);
  return { content: [{ type: 'text' as const, text: '{"saved":true}' }] };
}

/** Register only for workers with a host-issued chat capability. Each mutation tool fixes its own scope. */
export function registerChatRuleTools(server: McpServer): void {
  if (!hasMemoryChatBinding()) return;
  server.registerTool(
    'tdai_rules_read',
    {
      description:
        'Read the standing rules for this chat before acting. Temporary chats use global rules; project chats also use their project rules. Reuse the initial read supplied by the host.',
      inputSchema: z.object({}).strict().default({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(await callMemoryChatHost('rules/read')) }] })
  );
  for (const scope of ['global', 'project'] as const) {
    server.registerTool(
      `tdai_${scope}_rule_write`,
      {
        description: `Create or update a standing ${scope} rule in Tencent memory. To update, provide its path and revision from tdai_rules_read. Use file_change for repository instruction files.`,
        inputSchema: write,
        annotations: mutationHints,
      },
      async ({ title, content, path, revision }) => {
        if (path === undefined && revision === undefined) return save({ action: 'add', scope, title, content });
        if (path === undefined || revision === undefined)
          throw new Error('Updating a rule requires both its path and revision from tdai_rules_read.');
        return save({ action: 'edit', scope, title, content, path, revision });
      }
    );
    server.registerTool(
      `tdai_${scope}_rule_delete`,
      {
        description: `Delete one standing ${scope} rule from Tencent memory using its path and revision from tdai_rules_read.`,
        inputSchema: remove,
        annotations: mutationHints,
      },
      async ({ path, revision }) => save({ action: 'delete', scope, path, revision })
    );
  }
}
