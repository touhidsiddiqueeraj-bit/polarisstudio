#!/usr/bin/env node
// PolarisStudio vision MCP server — lets coding agents (opencode) send an image
// to the local multimodal LLM and get back a description. Routes through the
// PolarisStudio UI server (http://127.0.0.1:9090/api/vision), which handles
// engine lifecycle (auto-start, VRAM arbitration).
// ponytail: raw JSON-RPC over stdio — an SDK buys nothing here.
const http = require('http');
const fs = require('fs');
const readline = require('readline');

const UI_BASE = 'http://127.0.0.1:' + (process.env.POLARIS_PORT || '9090');

// Default vision model (official Gemma-4-E4B-it; mmproj auto-discovered by the engine).
// Override via POLARIS_VISION_MODEL env var.
const VISION_MODEL = process.env.POLARIS_VISION_MODEL ||
  '/mnt/backup/llm-models/gemma-4-E4B-it-Q4_0.gguf';

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(UI_BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('bad response: ' + out.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function resolveImage(uri) {
  if (/^data:image\/[a-z+]+;base64,/.test(uri)) return uri;
  if (uri.startsWith('data:image/')) throw new Error('unsupported data URI (base64 expected): ' + uri.slice(0, 32));
  const p = uri.replace(/^file:\/\//, '');
  if (!fs.existsSync(p)) throw new Error('file not found: ' + p);
  const b64 = fs.readFileSync(p).toString('base64');
  const mime = /\.png$/i.test(p) ? 'image/png' : /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png';
  return 'data:' + mime + ';base64,' + b64;
}

const TOOLS = [{
  name: 'describe_image',
  description: 'Send an image to the local multimodal LLM (official gemma-4-E4B-it by default) and return the alignment description. Image accepts a file path, file:// URL, or a data:image/...;base64 data URI. Optional prompt controls what the model says; optional modelPath selects a different GGUF vision model.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'file path, file:// URL, or data:image/...;base64 data URI' },
      prompt: { type: 'string', description: 'instruction for the model, e.g. "Describe this screenshot" or "Transcribe the text in this image"' },
      modelPath: { type: 'string' }
    },
    required: ['image']
  }
}];

async function call(params) {
  const a = (params && params.arguments) || {};
  const image = resolveImage(a.image);
  const body = { images: [image], prompt: a.prompt || 'Describe this image in detail.', modelPath: a.modelPath || VISION_MODEL };
  // ponytail: cold-start retry — the first request can hit a llama-server that
  // is still loading the model (503 "Loading model"), or the UI server mid-restart
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await postJson('/api/vision', body);
      if (!r.error) return { content: [{ type: 'text', text: r.text || '(empty response)' }], isError: false };
      lastErr = new Error(r.error);
    } catch (e) {
      lastErr = e;
    }
    if (!/loading model|ECONNREFUSED/i.test(String(lastErr.message))) break;
    await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
  }
  throw lastErr;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  const { id, method, params } = msg;
  const reply = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
  const fail = (m) => reply({ error: { code: -32603, message: 'polaris-vision: ' + m } });
  try {
    if (method === 'initialize') {
      return reply({ result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'polaris-vision', version: '1.1.0' } } });
    }
    if (method !== 'tools/list' && method !== 'tools/call') return; // notifications + anything else: no-op
    if (method === 'tools/list') return reply({ result: { tools: TOOLS } });
    if (params && params.name !== 'describe_image') throw new Error('unknown tool ' + params.name);
    return reply({ result: await call(params) });
  } catch (e) {
    return fail(e && e.message || String(e));
  }
});