/** A per-job capability binds Tencent generation to the originating chat's current model. */
export type TencentGenerationContext = {
  base_url: string;
  model: string;
  callback_token: string;
};

/** Resolve immediately before enqueueing. Never cache across a model change or expose tokens to tools. */
export async function resolveTencentGenerationContext(): Promise<TencentGenerationContext> {
  const url = process.env.AIONUI_GENERATION_CONTEXT_URL;
  const token = process.env.AIONUI_GENERATION_TOKEN;
  const conversationId = process.env.AIONUI_CONVERSATION_ID;
  if (!url || !token || !conversationId)
    throw new Error('Generation needs an originating chat and its selected model. Restart the chat and try again.');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversation_id: conversationId }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('The originating chat model is unavailable. Reconnect the application and retry.');
  }
  if (!response.ok) throw new Error(`Could not resolve the originating chat model (HTTP ${response.status}).`);
  let envelope: {
    success?: boolean;
    data?: { llm_context?: TencentGenerationContext };
  };
  try {
    envelope = (await response.json()) ?? {};
  } catch {
    throw new Error('The application returned an invalid generation context. Restart the chat and try again.');
  }
  const context = envelope.data?.llm_context;
  if (
    !envelope.success ||
    !context ||
    typeof context.base_url !== 'string' ||
    typeof context.model !== 'string' ||
    typeof context.callback_token !== 'string' ||
    !context.base_url ||
    !context.model ||
    !context.callback_token
  )
    throw new Error('The application returned an invalid generation context. Restart the chat and try again.');
  return { base_url: context.base_url, model: context.model, callback_token: context.callback_token };
}
