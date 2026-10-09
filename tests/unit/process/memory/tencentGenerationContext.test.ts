import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTencentGenerationContext } from '../../../../packages/desktop/src/process/memory/tencentGenerationContext';
import { TencentKnowledgeClient } from '../../../../packages/desktop/src/process/memory/tencentKnowledgeClient';
import { TencentMemoryClient } from '../../../../packages/desktop/src/process/memory/tencentMemoryClient';

const config = {
  gatewayUrl: 'http://memory.local',
  knowledgeUrl: 'http://knowledge.local',
  knowledgeServiceKey: 'service-test-key',
  teamId: 'team',
  agentId: 'agent',
  userId: 'user',
  serviceId: 'default',
};
const context = (model: string) => ({
  base_url: 'http://host.docker.internal:1234/api/runtime/tencent/v1',
  model,
  callback_token: `private-job-${model}`,
});
function configureChat() {
  vi.stubEnv('AIONUI_GENERATION_CONTEXT_URL', 'http://core.local/context');
  vi.stubEnv('AIONUI_GENERATION_TOKEN', 'private-bootstrap-token');
  vi.stubEnv('AIONUI_CONVERSATION_ID', 'chat-one');
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Tencent generation model binding', () => {
  it('captures the current model separately for each new job', async () => {
    configureChat();
    let currentModel = 'model-a';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true, data: { llm_context: context(currentModel) } })))
    );
    const first = await resolveTencentGenerationContext();
    currentModel = 'model-b';
    const second = await resolveTencentGenerationContext();
    expect([first.model, second.model]).toEqual(['model-a', 'model-b']);
    expect(first.callback_token).not.toBe(second.callback_token);
  });

  it('rejects missing chat context before uploading or creating a Wiki', async () => {
    vi.stubEnv('AIONUI_GENERATION_CONTEXT_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new TencentKnowledgeClient(config).ingest({ name: 'Wiki', files: [{ filename: 'a.md', content: 'a' }] })
    ).rejects.toThrow('originating chat');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not leak private response bodies or silently fall back when the bridge rejects', async () => {
    configureChat();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private-server-details', { status: 403 }))
    );
    await expect(resolveTencentGenerationContext()).rejects.toThrow('HTTP 403');
    await expect(resolveTencentGenerationContext()).rejects.not.toThrow('private-server-details');
  });

  it('passes the selected context to conversation extraction without exposing the capability in tool results', async () => {
    configureChat();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify(
            url.endsWith('/context')
              ? { success: true, data: { llm_context: context('chosen-model') } }
              : { code: 0, data: { accepted: true } }
          )
        );
      })
    );
    const saved = await new TencentMemoryClient(config).addConversation('session', [
      { role: 'user', content: 'Remember a fact' },
    ]);
    expect(requests[1].body.llm_context).toEqual(context('chosen-model'));
    expect(saved.generation_model).toBe('chosen-model');
    expect(JSON.stringify(saved)).not.toContain('private-job');
  });

  it.each(['private-broken-json', 'null', '{}'])(
    'rejects malformed context responses without reflecting their contents: %s',
    async (body) => {
      configureChat();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body))
      );
      await expect(resolveTencentGenerationContext()).rejects.toThrow('invalid generation context');
      await expect(resolveTencentGenerationContext()).rejects.not.toThrow('private-broken-json');
    }
  );
});
