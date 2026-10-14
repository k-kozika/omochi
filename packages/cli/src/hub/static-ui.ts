import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const root = path.dirname(fileURLToPath(import.meta.resolve('@omochi-ui/hub-ui/assets')));
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

export function serveHubUi(request: IncomingMessage, response: ServerResponse): boolean {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/' && pathname !== '/index.html' && !pathname.startsWith('/assets/')) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return true; }
  let filename: string;
  try {
    filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
    if (!filename.startsWith(root + path.sep)) throw new Error();
  } catch { response.writeHead(400).end(); return true; }
  void readFile(filename).then(data => {
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : data);
  }).catch(() => response.writeHead(404).end('Hub UI not found; run bun run build.'));
  return true;
}
