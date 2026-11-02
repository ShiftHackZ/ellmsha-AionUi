/** Host-bound HTTP client; never accepts identity or URLs from tool input. */
export function createBackgroundProcessClient(env: NodeJS.ProcessEnv = process.env) {
  const base = env.AIONUI_BASE_URL;
  const conversation = env.AIONUI_CONVERSATION_ID;
  const user = env.AIONUI_USER_ID;
  const token = env.AIONUI_RUNTIME_TOKEN;
  if (!base || !conversation || !user || !token) throw new Error('Background terminal runtime context unavailable');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid runtime origin');
  const endpoint = new URL(`/api/conversations/${encodeURIComponent(conversation)}/background-processes`, url.origin);
  return async (suffix: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${endpoint}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'content-type': 'application/json',
        'x-aionui-runtime-token': token,
        'x-aionui-user-id': user,
        'x-aionui-conversation-id': conversation,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Background terminal request failed (${response.status})`);
    const result = (await response.json()) as { data?: unknown };
    return result.data;
  };
}
