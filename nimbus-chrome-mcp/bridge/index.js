#!/usr/bin/env node
/**
 * Nimbus Chrome MCP bridge.
 *
 * Runs as an MCP server (stdio JSON-RPC 2.0) that LibreChat / bolt.diy spawn.
 * Listens on ws://127.0.0.1:35123 for the Nimbus Chrome extension to connect.
 * Forwards MCP tool calls to the extension and streams results back.
 *
 * Trust model:
 *   - WebSocket server binds ONLY to 127.0.0.1 (loopback). Rejects any other
 *     interface + any Origin header pointing at a non-loopback origin.
 *   - Extension authenticates by sending {method:"handshake"} on connect.
 *   - Only ONE extension may be connected at a time; a second connection
 *     displaces the first (fresh install, browser restart, etc.).
 */
import { WebSocketServer } from 'ws';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const WS_PORT = Number(process.env.NIMBUS_CHROME_MCP_PORT || 35123);
const WS_HOST = '127.0.0.1';

let extension = null;
let extensionInfo = null;
const pending = new Map(); // id -> {resolve, reject, timeout}

const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT, path: '/extension' });
wss.on('connection', (ws, req) => {
  // Defense in depth: require loopback + no external Origin.
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    ws.close(4001, 'loopback only');
    return;
  }
  const origin = req.headers['origin'] || '';
  if (origin && !/^chrome-extension:\/\//i.test(origin)) {
    ws.close(4002, 'origin');
    return;
  }
  if (extension) {
    try { extension.close(4003, 'replaced'); } catch { /* ignore */ }
  }
  extension = ws;
  extensionInfo = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.method === 'handshake') {
      extensionInfo = msg.params;
      process.stderr.write(`[nimbus-chrome-mcp] extension connected (v${msg.params?.version || '?'})\n`);
      return;
    }
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timeout);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  ws.on('close', () => {
    if (extension === ws) { extension = null; extensionInfo = null; }
    for (const [, p] of pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('extension disconnected'));
    }
    pending.clear();
  });
});

function callExtension(method, params, timeoutMs = 30_000) {
  if (!extension || extension.readyState !== 1 /* OPEN */) {
    return Promise.reject(new Error('Nimbus Chrome extension not connected. Install it from https://nimbusapi.net/extensions and open Chrome.'));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`extension call timed out after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    try {
      extension.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      clearTimeout(timeout);
      pending.delete(id);
      reject(err);
    }
  });
}

// ── MCP protocol (JSON-RPC 2.0 over stdio) ──
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

const TOOLS = [
  {
    name: 'nimbus_chrome_tabs_list',
    description: 'List every open tab across all Chrome windows.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'nimbus_chrome_navigate',
    description: 'Navigate a tab to a URL. Omit tabId to use the active tab.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' }, url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'nimbus_chrome_read_page',
    description: 'Return {title, url, text, html} for a tab. Text capped at 100k, html at 500k.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } }
    }
  },
  {
    name: 'nimbus_chrome_screenshot',
    description: 'Capture the visible area of a tab as a PNG data URL.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } }
    }
  },
  {
    name: 'nimbus_chrome_click',
    description: 'Click the first element matching a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' }, selector: { type: 'string' } },
      required: ['selector']
    }
  },
  {
    name: 'nimbus_chrome_type',
    description: 'Set the value of an input/textarea/contenteditable matching a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text']
    }
  },
  {
    name: 'nimbus_chrome_eval',
    description: 'Run arbitrary JavaScript in the page context of a tab. Returns the awaited value.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' }, code: { type: 'string' } },
      required: ['code']
    }
  },
  {
    name: 'nimbus_chrome_tabs_create',
    description: 'Open a new tab at the given URL. Returns the new tabId.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'nimbus_chrome_tabs_close',
    description: 'Close a tab by id.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId']
    }
  }
];

async function resolveTabId(input) {
  if (input && typeof input.tabId === 'number') return input.tabId;
  const tabs = await callExtension('tabs.list');
  const active = tabs.find(t => t.active);
  if (!active) throw new Error('no active tab; pass tabId explicitly');
  return active.tabId;
}

async function runTool(name, args) {
  switch (name) {
    case 'nimbus_chrome_tabs_list':
      return await callExtension('tabs.list');
    case 'nimbus_chrome_tabs_create':
      return await callExtension('tabs.create', { url: args.url });
    case 'nimbus_chrome_tabs_close':
      return await callExtension('tabs.close', { tabId: args.tabId });
    case 'nimbus_chrome_navigate': {
      const tabId = await resolveTabId(args);
      return await callExtension('navigate', { tabId, url: args.url });
    }
    case 'nimbus_chrome_read_page': {
      const tabId = await resolveTabId(args);
      return await callExtension('read_page', { tabId });
    }
    case 'nimbus_chrome_screenshot': {
      const tabId = await resolveTabId(args);
      return await callExtension('screenshot', { tabId });
    }
    case 'nimbus_chrome_click': {
      const tabId = await resolveTabId(args);
      return await callExtension('click', { tabId, selector: args.selector });
    }
    case 'nimbus_chrome_type': {
      const tabId = await resolveTabId(args);
      return await callExtension('type', { tabId, selector: args.selector, text: args.text });
    }
    case 'nimbus_chrome_eval': {
      const tabId = await resolveTabId(args);
      return await callExtension('eval', { tabId, code: args.code });
    }
    default:
      throw new Error('unknown tool: ' + name);
  }
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.jsonrpc !== '2.0') return;
  try {
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nimbus-chrome-mcp', version: '0.1.0' }
        }
      });
      return;
    }
    if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      return;
    }
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params || {};
      try {
        const value = await runTool(name, args || {});
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
            ]
          }
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: String(err && err.message || err) }]
          }
        });
      }
      return;
    }
    if (msg.method === 'ping') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    }
  } catch (err) {
    if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err && err.message || err) } });
    }
  }
});

process.stderr.write(`[nimbus-chrome-mcp] bridge listening on ws://${WS_HOST}:${WS_PORT}/extension\n`);
