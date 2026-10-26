'use strict';
const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');

function invalid(code) {
  return Object.assign(new Error(code), { code, status: 400 });
}
function text(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((p) => p.type === 'text' && typeof p.text === 'string'))
    return value.map((p) => p.text).join('\n');
  throw invalid('unsupported_message_content');
}
function convert(vscode, body) {
  if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || !body.messages.length)
    throw invalid('invalid_request');
  const pending = new Set();
  const messages = body.messages.map((m) => {
    if (!m || typeof m !== 'object') throw invalid('invalid_message');
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) throw invalid('orphan_tool_result');
      return vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(m.tool_call_id, [new vscode.LanguageModelTextPart(text(m.content))]),
      ]);
    }
    const parts = [];
    if (m.content != null) parts.push(new vscode.LanguageModelTextPart(text(m.content)));
    if (m.role === 'assistant') {
      for (const call of m.tool_calls || []) {
        if (call.type !== 'function' || !call.id || pending.has(call.id) || typeof call.function?.name !== 'string')
          throw invalid('invalid_tool_call');
        const input = JSON.parse(call.function.arguments);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('invalid_tool_arguments');
        pending.add(call.id);
        parts.push(new vscode.LanguageModelToolCallPart(call.id, call.function.name, input));
      }
      return vscode.LanguageModelChatMessage.Assistant(parts);
    }
    // Public vscode.lm supports User/Assistant only. Preserve all harness rules
    // in order as the first user message, without a private/proposed system API.
    if (m.role === 'system' || m.role === 'developer')
      return vscode.LanguageModelChatMessage.User(`[eLLMsha harness instructions]\n${text(m.content)}`);
    if (m.role !== 'user') throw invalid('unsupported_message_role');
    return vscode.LanguageModelChatMessage.User(parts);
  });
  if (pending.size) throw invalid('missing_tool_result');
  if (body.tools != null && !Array.isArray(body.tools)) throw invalid('invalid_tools');
  let tools = (body.tools || []).map((t) => {
    if (
      t.type !== 'function' ||
      typeof t.function?.name !== 'string' ||
      !t.function.parameters ||
      typeof t.function.parameters !== 'object'
    )
      throw invalid('invalid_tool_definition');
    return { name: t.function.name, description: t.function.description || '', inputSchema: t.function.parameters };
  });
  let toolMode = vscode.LanguageModelChatToolMode.Auto;
  if (body.tool_choice === 'none') tools = [];
  else if (body.tool_choice === 'required') toolMode = vscode.LanguageModelChatToolMode.Required;
  else if (body.tool_choice && typeof body.tool_choice === 'object') {
    tools = tools.filter((t) => t.name === body.tool_choice.function?.name);
    if (!tools.length) throw invalid('unknown_required_tool');
    toolMode = vscode.LanguageModelChatToolMode.Required;
  } else if (body.tool_choice && body.tool_choice !== 'auto') throw invalid('unsupported_tool_choice');
  const modelOptions = {};
  const maximum = body.max_completion_tokens ?? body.max_tokens;
  if (maximum != null) {
    if (!Number.isInteger(maximum) || maximum < 1) throw invalid('invalid_max_tokens');
    modelOptions.max_tokens = maximum;
  }
  if (body.temperature != null) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature))
      throw invalid('invalid_temperature');
    modelOptions.temperature = body.temperature;
  }
  return { messages, options: { tools, toolMode, modelOptions } };
}
function allowed(req, secret) {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return !req.headers.origin && actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function discover(vscode, token) {
  // Copilot activation resolves before its authenticated model catalog arrives.
  // Wait for a bounded first catalog, without initiating a new sign-in.
  const until = Date.now() + 20000;
  do {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length || token?.isCancellationRequested) return models;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < until);
  return [];
}
async function start(vscode, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Missing private bridge credential');
  const server = http.createServer(async (req, res) => {
    const error = (status, code) => {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { type: 'copilot_ide_error', code, message: code } })}\n\n`);
        res.end();
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'copilot_ide_error', code, message: code } }));
      }
    };
    if (!allowed(req, secret)) return error(401, 'unauthorized');
    const token = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => token.cancel(), 180000);
    res.on('close', () => token.cancel());
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        const models = await discover(vscode, token.token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: models
              .filter((m) => m.capabilities?.supportsToolCalling)
              .map((m) => ({
                id: m.id,
                object: 'model',
                owned_by: 'github-copilot',
                context_window: m.maxInputTokens,
              })),
          })
        );
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return error(404, 'not_found');
      if (!String(req.headers['content-type']).startsWith('application/json')) throw invalid('json_required');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw invalid('request_too_large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const converted = convert(vscode, body);
      const models = await discover(vscode, token.token);
      const model = models.find((m) => m.id === body.model);
      if (!model) return error(404, 'model_unavailable');
      const reply = await model.sendRequest(converted.messages, converted.options, token.token);
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      let content = '';
      let usage;
      const toolCalls = [];
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        );
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        send({ role: 'assistant' });
      }
      for await (const part of reply.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          content += part.value;
          if (body.stream) send({ content: part.value });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          const call = {
            id: part.callId,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          };
          toolCalls.push(call);
          if (body.stream) send({ tool_calls: [{ index: toolCalls.length - 1, ...call }] });
        } else if (
          vscode.LanguageModelDataPart &&
          part instanceof vscode.LanguageModelDataPart &&
          part.mimeType === 'usage'
        ) {
          // Source-built Copilot publishes actual APIUsage as a public data part.
          const counts = JSON.parse(new TextDecoder().decode(part.data));
          if (
            ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(
              (k) => Number.isInteger(counts[k]) && counts[k] >= 0
            )
          ) {
            usage = {
              prompt_tokens: counts.prompt_tokens,
              completion_tokens: counts.completion_tokens,
              total_tokens: counts.total_tokens,
            };
            const cached = counts.prompt_tokens_details?.cached_tokens;
            if (Number.isInteger(cached) && cached >= 0) usage.prompt_tokens_details = { cached_tokens: cached };
          }
        } else if (
          vscode.LanguageModelDataPart &&
          part instanceof vscode.LanguageModelDataPart &&
          ['stateful_marker', 'context_management'].includes(part.mimeType)
        ) {
          // Full conversation history is supplied by eLLMsha; optional provider
          // continuation/cache metadata is not rendered as model text.
        } else throw invalid('unsupported_response_part');
      }
      const finish = toolCalls.length ? 'tool_calls' : 'stop';
      if (body.stream) {
        send({}, finish);
        if (usage)
          res.write(
            `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage })}\n\n`
          );
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            ...(usage ? { usage } : {}),
            created,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
                finish_reason: finish,
              },
            ],
          })
        );
      }
      // Absent counters remain absent; never fabricate usage=0.
    } catch (e) {
      error(
        e.status || (e instanceof SyntaxError ? 400 : 502),
        /^[a-z_]+$/i.test(e.code || '') ? e.code : 'copilot_request_failed'
      );
    } finally {
      clearTimeout(timer);
      token.dispose();
    }
  });
  server.requestTimeout = 190000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}
module.exports = { start, convert, allowed, discover };
