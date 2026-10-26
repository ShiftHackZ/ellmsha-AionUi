import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
const { convert, start } = load('../../../packages/desktop/src/process/resources/copilot-ide/transport.cjs');
class Text {
  constructor(public value: string) {}
}
class Call {
  constructor(
    public callId: string,
    public name: string,
    public input: unknown
  ) {}
}
class Data {
  constructor(
    public data: Uint8Array,
    public mimeType: string
  ) {}
}
class Result {
  constructor(
    public callId: string,
    public content: unknown[]
  ) {}
}
const fake = {
  LanguageModelTextPart: Text,
  LanguageModelDataPart: Data,
  LanguageModelToolCallPart: Call,
  LanguageModelToolResultPart: Result,
  LanguageModelChatMessage: {
    User: (content: unknown) => ({ role: 'user', content }),
    Assistant: (content: unknown) => ({ role: 'assistant', content }),
  },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  CancellationTokenSource: class {
    token = {};
    cancel() {}
    dispose() {}
  },
  lm: {
    selectChatModels: async () => [
      {
        id: 'exact',
        capabilities: { supportsToolCalling: true },
        sendRequest: async () => ({
          stream: (async function* () {
            yield new Text('hello');
            yield new Data(
              new TextEncoder().encode(JSON.stringify({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })),
              'usage'
            );
            yield new Call('c1', 'echo', { marker: 'OK' });
          })(),
        }),
      },
    ],
  },
};

describe('Copilot public LM transport', () => {
  it('preserves harness instruction order and tools/results without executing tools', () => {
    const converted = convert(fake, {
      model: 'exact',
      messages: [
        { role: 'system', content: 'project rules first' },
        { role: 'user', content: 'task' },
        {
          role: 'assistant',
          tool_calls: [{ type: 'function', id: 'one', function: { name: 'echo', arguments: '{"a":1}' } }],
        },
        { role: 'tool', tool_call_id: 'one', content: 'done' },
      ],
    });
    expect(converted.messages[0].content).toContain('project rules first');
    expect(converted.messages[2].content[0]).toBeInstanceOf(Call);
    expect(converted.messages[3].content[0]).toBeInstanceOf(Result);
  });
  it('rejects malformed tools and unsupported images rather than dropping them', () => {
    expect(() =>
      convert(fake, { model: 'exact', messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }] })
    ).toThrow('orphan_tool_result');
    expect(() =>
      convert(fake, {
        model: 'exact',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
      })
    ).toThrow('unsupported_message_content');
  });
  it('streams OpenAI tool call frames, rejects wrong models and blocks browser-origin access', async () => {
    const key = 'a'.repeat(64);
    const server = await start(fake, key);
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const request = (model: string, origin?: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
    try {
      const stream = await (await request('exact')).text();
      expect(stream).toContain('"prompt_tokens":10');
      expect(stream).toContain('"tool_calls":[{"index":0,"id":"c1"');
      expect((await request('not-found')).status).toBe(404);
      expect((await request('exact', 'https://untrusted.example')).status).toBe(401);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(resolve));
    }
  });
});

describe('local bridge OpenAPI contract', () => {
  it('documents every known property and resolves all schema references', () => {
    const doc = load('../../../packages/desktop/src/process/resources/copilot-ide/openapi.json');
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (typeof object.$ref === 'string') expect(doc.components.schemas[object.$ref.split('/').at(-1)!]).toBeDefined();
      if (object.properties && typeof object.properties === 'object') {
        for (const property of Object.values(object.properties)) {
          const field = property as Record<string, unknown>;
          expect(Boolean(field.description || field.$ref)).toBe(true);
        }
      }
      for (const child of Object.values(object)) walk(child);
    };
    walk(doc);
  });
});

describe('Copilot cancellation', () => {
  it('cancels the real provider token when its HTTP client disconnects', async () => {
    let cancelled!: () => void;
    const observed = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const cancellationApi = {
      ...fake,
      CancellationTokenSource: class {
        token = { isCancellationRequested: false, cancelled: observed };
        cancel() {
          this.token.isCancellationRequested = true;
          cancelled();
        }
        dispose() {}
      },
      lm: {
        selectChatModels: async () => [
          {
            id: 'exact',
            capabilities: { supportsToolCalling: true },
            sendRequest: async (_messages: unknown, _options: unknown, token: { cancelled: Promise<void> }) => ({
              stream: (async function* () {
                yield new Text('started');
                await token.cancelled;
              })(),
            }),
          },
        ],
      },
    };
    const key = 'b'.repeat(64);
    const server = await start(cancellationApi, key);
    const abort = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'exact', messages: [{ role: 'user', content: 'fixture' }], stream: true }),
        signal: abort.signal,
      });
      await response.body!.getReader().read();
      abort.abort();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          observed,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('provider was not cancelled')), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      expect(abort.signal.aborted).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(resolve));
    }
  });
});
