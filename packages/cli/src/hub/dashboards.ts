import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidNodeId, isValidServiceId } from '@omochi-ui/core';
import { ensureConfigRoot, omochiConfigRoot, withStateLock } from '@omochi-ui/discovery';
import { overlaps, referenceId, type Dashboard, type DashboardFile, type DashboardInput, type DashboardPreset, type Panel } from '@omochi-ui/hub-ui/contracts';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

export function validateDashboard(value: unknown): DashboardInput {
  if (!record(value) || !text(value.name) || !Array.isArray(value.panels) || value.panels.length > 200) {
    throw new HttpError(400, 'A dashboard needs a name and at most 200 panels');
  }
  const panels: Panel[] = [];
  const ids = new Set<string>();
  const references = new Set<string>();
  for (const p of value.panels) {
    if (!record(p) || !text(p.id, 100) || !text(p.title) || !record(p.reference)
      || typeof p.reference.nodeId !== 'string' || !isValidNodeId(p.reference.nodeId)
      || typeof p.reference.serviceId !== 'string' || !isValidServiceId(p.reference.serviceId)
      || !text(p.reference.surfaceId, 4096)
      || !integer(p.x, 0, 11) || !integer(p.y, 0, 100000) || !integer(p.w, 1, 12) || !integer(p.h, 1, 1000)
      || p.x + p.w > 12) throw new HttpError(400, 'Invalid panel reference or grid position');
    const panel: Panel = {
      id: p.id, title: p.title, reference: { nodeId: p.reference.nodeId, serviceId: p.reference.serviceId, surfaceId: p.reference.surfaceId },
      x: p.x, y: p.y, w: p.w, h: p.h,
    };
    const ref = referenceId(panel.reference);
    if (ids.has(panel.id) || references.has(ref)) throw new HttpError(400, 'Duplicate panel or surface');
    if (panels.some(other => overlaps(panel, other))) throw new HttpError(400, 'Panels must not overlap');
    ids.add(panel.id); references.add(ref); panels.push(panel);
  }
  return { name: value.name.trim(), panels };
}

/** Re-read under the mutation queue and cross-process lock; failed writes never replace the last good file. */
export class DashboardStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(private readonly root = omochiConfigRoot()) { this.file = path.join(root, 'dashboards.json'); }
  private async read(): Promise<DashboardFile> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, dashboards: [] };
      throw new HttpError(503, 'Could not read dashboard storage');
    }
    try {
      const data: unknown = JSON.parse(raw);
      if (!record(data) || data.version !== 1 || !Array.isArray(data.dashboards)) throw new Error();
      const ids = new Set<string>();
      const dashboards = data.dashboards.map((item: unknown): Dashboard => {
        if (!record(item) || !text(item.id, 100) || !integer(item.revision, 1, Number.MAX_SAFE_INTEGER) || ids.has(item.id)) throw new Error();
        ids.add(item.id);
        return { ...validateDashboard(item), id: item.id, revision: item.revision };
      });
      return { version: 1, dashboards };
    } catch { throw new HttpError(503, 'Dashboard storage is invalid; repair dashboards.json before saving'); }
  }
  async list(): Promise<Dashboard[]> { await this.queue; return (await this.read()).dashboards; }
  mutate(id: string | null, input: unknown, remove = false): Promise<Dashboard | null> {
    const next = this.queue.then(async () => {
      try {
        await ensureConfigRoot(this.root);
        return await withStateLock(this.file, async () => {
          const file = await this.read();
          const current = id === null ? undefined : file.dashboards.find(d => d.id === id);
          if (id !== null && !current) throw new HttpError(404, 'Dashboard not found');
          if (current && (!record(input) || input.revision !== current.revision)) throw new HttpError(409, 'This dashboard changed elsewhere. Reload before saving.');
          const dashboard: Dashboard | null = remove ? null : {
            ...validateDashboard(input), id: current?.id ?? randomUUID(), revision: (current?.revision ?? 0) + 1,
          };
          file.dashboards = file.dashboards.filter(d => d.id !== id);
          if (dashboard) file.dashboards.push(dashboard);
          const temporary = path.join(this.root, `.dashboards-${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            await rename(temporary, this.file);
          } finally { await unlink(temporary).catch(() => {}); }
          return dashboard;
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'Could not save dashboard storage');
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'Use application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 1024 * 1024) throw new HttpError(413, 'Dashboard request is too large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function dashboardEndpoints(store: DashboardStore, allowed: (origin: string | undefined) => boolean) {
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/api/dashboards' && !pathname.startsWith('/api/dashboards/')) return false;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (!allowed(request.headers.origin)) { send(403, { error: 'Forbidden origin' }); return true; }
    response.setHeader('Vary', 'Origin');
    if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      response.end(); return true;
    }
    void (async () => {
      const id = pathname === '/api/dashboards' ? null : decodeURIComponent(pathname.slice('/api/dashboards/'.length));
      if (id !== null && (!id || id.includes('/'))) throw new HttpError(404, 'Dashboard not found');
      if (request.method === 'GET') {
        const dashboards = await store.list();
        if (id === null) send(200, dashboards);
        else {
          const dashboard = dashboards.find(d => d.id === id);
          if (!dashboard) throw new HttpError(404, 'Dashboard not found');
          send(200, dashboard);
        }
      } else if (request.method === 'POST' && id === null) send(201, await store.mutate(null, await body(request)));
      else if (request.method === 'PUT' && id !== null) send(200, await store.mutate(id, await body(request)));
      else if (request.method === 'DELETE' && id !== null) { await store.mutate(id, await body(request), true); send(200, { deleted: true }); }
      else throw new HttpError(405, 'Method not allowed');
    })().catch(error => send(error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 503,
      { error: error instanceof HttpError ? error.message : 'Could not save dashboard' }));
    return true;
  };
}

export function validatePresets(values: readonly DashboardPreset[]): DashboardPreset[] {
  const ids = new Set<string>();
  return values.map((value) => {
    if (!text(value.id, 100) || ids.has(value.id)) throw new Error(`Invalid or duplicate dashboard preset id: ${JSON.stringify(value.id)}`);
    ids.add(value.id);
    return { id: value.id, ...validateDashboard(value) };
  });
}

/** Read-only presets live only for the lifetime of this hub process. */
export function presetEndpoints(presets: readonly DashboardPreset[], allowed: (origin: string | undefined) => boolean) {
  const validated = validatePresets(presets);
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/api/presets') return false;
    const send = (status: number, value?: unknown) => {
      const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
      if (value !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
      response.writeHead(status, headers);
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (!allowed(request.headers.origin)) { send(403, { error: 'Forbidden origin' }); return true; }
    response.setHeader('Vary', 'Origin');
    if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      send(204);
    } else if (request.method === 'GET') send(200, validated);
    else send(405, { error: 'Method not allowed' });
    return true;
  };
}
