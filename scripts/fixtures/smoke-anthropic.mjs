#!/usr/bin/env node
// WP-6B 批次四（6-4/4）冒烟夹具：mock Anthropic /v1/messages 服务器（独立子进程——
// 批次三实测：沙箱下 child→parent 进程环回 fetch 挂起、child→child 正常，故必须独立进程）。
// 用法：node scripts/fixtures/smoke-anthropic.mjs <port>
// 应答策略（无状态、按会话内容判定，任务间天然隔离）：
//   会话已含 tool_result（echo 工具已执行过）→ 纯文本响应 = 满足输出契约的最终输出；
//   否则 → tool_use echo-echo {hello}（L3 → 审批挂起链路入口）。

import http from 'node:http';

const port = Number(process.argv[2] ?? '0');

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/v1/messages')) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const sawToolResult = (body.messages ?? []).some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );
    const content = sawToolResult
      ? [{ type: 'text', text: JSON.stringify({ summary: '冒烟链路完成：L3 审批放行后正常收尾', filesCovered: 1, verdict: 'ok' }) }]
      : [{ type: 'tool_use', id: 'smoke-1', name: 'echo-echo', input: { hello: 'smoke' } }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      content,
      stop_reason: sawToolResult ? 'end_turn' : 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
  });
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  process.stdout.write(`MOCK_ANTHROPIC_READY port=${actual}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
