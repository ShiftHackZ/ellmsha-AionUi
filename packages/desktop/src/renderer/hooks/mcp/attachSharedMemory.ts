import { ipcBridge } from '@/common';
import { BUILTIN_TDAI_MEMORY_NAME } from '@/common/config/constants';
import type { ISessionMcpServer, TChatConversation } from '@/common/config/storage';
import { ensureBackendMcpCatalog, toSessionMcpServer } from './catalog';

/** Give an AionUi team member the same memory tools as a new standalone chat. */
export async function attachSharedMemory(conversationId: string): Promise<void> {
  if (!conversationId) return;
  const { allServers } = await ensureBackendMcpCatalog();
  const memory = allServers.find(
    (server) => server.name === BUILTIN_TDAI_MEMORY_NAME && server.builtin === true && server.enabled
  );
  if (!memory) return;

  const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId });
  if (!conversation) throw new Error(`Team member conversation ${conversationId} was not found`);
  const extra = conversation.extra as Record<string, unknown>;
  const existing = (extra.session_mcp_servers ?? []) as ISessionMcpServer[];
  const selected = [
    ...existing.filter((server) => server.name !== BUILTIN_TDAI_MEMORY_NAME),
    toSessionMcpServer(memory),
  ];
  const updated = await ipcBridge.conversation.update.invoke({
    id: conversationId,
    updates: { extra: { ...extra, session_mcp_servers: selected } } as Partial<TChatConversation>,
    merge_extra: true,
  });
  if (!updated) throw new Error(`Could not attach shared memory to team member ${conversationId}`);
}
