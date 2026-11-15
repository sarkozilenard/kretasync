import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { loadEnvFile } from './env-file';

loadEnvFile();
import { createApp } from '../src/app';

const app = createApp();
const PUBLIC = join(__dirname, '..', 'public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT) || 3000;

createServer(async (nreq, nres) => {
  const url = new URL(nreq.url || '/', `http://${nreq.headers.host}`);
  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/calendar/');
  if (isApi) {
    const chunks: Buffer[] = [];
    for await (const c of nreq) chunks.push(c as Buffer);
    let target = url;
    if (url.pathname.startsWith('/calendar/')) target = new URL(`/api/calendar-ics?token=${url.pathname.slice(10)}`, url);
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const body = ['GET', 'HEAD'].includes(nreq.method || 'GET') ? undefined : Buffer.concat(chunks);
    const res = await app(new Request(target, { method: nreq.method, headers, body }));
    const out: Record<string, string | string[]> = {};
    res.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    const sc = res.headers.getSetCookie(); if (sc.length) out['set-cookie'] = sc;
    nres.writeHead(res.status, out).end(Buffer.from(await res.arrayBuffer()));
    return;
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(PUBLIC, rel));
    nres.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream' }).end(data);
  } catch { nres.writeHead(404).end('Not found'); }
}).listen(port, () => console.log(`KrétaSync fut: http://localhost:${port}`));
