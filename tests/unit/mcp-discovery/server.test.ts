import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

it('runs the packaged stdio launcher, preserves callback capabilities and shuts its upstream down', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ellmsha-lazy-stdio-'));
  const entry = path.join(directory, 'discovery.cjs');
  const fixture = path.join(directory, 'fixture.cjs');
  await build({
    entryPoints: ['packages/desktop/src/process/resources/mcp-discovery/server.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  await writeFile(
    fixture,
    `
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
let call, caps;
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const request=JSON.parse(line); let result;
 if (request.id===98765 && !request.method) {
   send({jsonrpc:'2.0',id:call,result:{content:[{type:'text',text:JSON.stringify({roots:request.result.roots,capabilities:caps})}]}});return;
 }
 if (!request.method || request.id===undefined) return;
 if (request.method==='initialize') { caps=request.params.capabilities;result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}; }
 else if(request.method==='tools/list')result={tools:[{name:'qa_probe',description:'Probe',inputSchema:{type:'object',properties:{proof:{type:'string'}},required:['proof']}}]};
 else if(request.method==='tools/call') {call=request.id;send({jsonrpc:'2.0',id:98765,method:'roots/list',params:{}});return;}
 else if(request.method==='ping')result={};
 else return;
 send({jsonrpc:'2.0',id:request.id,result});
});
process.stdin.on('end',()=>process.exit(0));
`
  );
  const client = new Client({ name: 'qa-adapter', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: 'file:///qa-only', name: 'QA' }] }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      AIONUI_MCP_DISCOVERY_CONFIG: JSON.stringify({
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: {},
      }),
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.find((tool) => tool.name === 'qa_probe')?.inputSchema.properties).toEqual({
      proof: { type: 'string' },
    });
    await client.callTool({ name: 'ellmsha_search_tools', arguments: { query: 'qa_probe' } });
    const result = await client.callTool({ name: 'qa_probe', arguments: { proof: 'callback' } });
    expect(JSON.stringify(result)).toContain('file:///qa-only');
    expect(JSON.stringify(result)).toContain('listChanged');
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
