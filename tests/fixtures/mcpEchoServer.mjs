#!/usr/bin/env node
// WP-4B 批次一测试夹具：真实子进程 MCP server 冒烟（ndjson JSON-RPC over stdio）。
// 用法：node mcpEchoServer.mjs —— 从 stdin 逐行读 JSON-RPC，向 stdout 逐行写响应。

import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'fixture-subprocess', version: '1.2.3' };

function handle(msg) {
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0', id: msg.id,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    };
  }
  if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) return null;
  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: '回显参数（子进程）',
            inputSchema: {
              type: 'object',
              properties: { hello: { type: 'string' } },
              required: [],
              additionalProperties: false,
            },
          },
        ],
      },
    };
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name ?? '';
    if (name !== 'echo') {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `未知工具 ${name}` } };
    }
    return {
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: `echo:${JSON.stringify(msg.params?.arguments ?? {})}` }] },
    };
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // 非 JSON 行忽略
  }
  Promise.resolve()
    .then(() => handle(msg))
    .then((resp) => {
      if (resp !== null) process.stdout.write(`${JSON.stringify(resp)}\n`);
    })
    .catch((err) => {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(err?.message ?? err) } })}\n`);
    });
});
