import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from '@omochi-ui/core/testing';
import { DashboardStore, validateDashboard, validatePresets } from '../src/hub/dashboards.js';
import { startHub } from '../src/hub/hub.js';

const panel = { id: 'p1', title: 'Counter', reference: { nodeId: 'aaaaaaaaaaaaaaaa', serviceId: 'counter', surfaceId: 'nested/main' }, x: 0, y: 0, w: 6, h: 6 };
const input = { name: 'Overview', panels: [panel] };

test('dashboard storage persists references, serializes writes and rejects stale revisions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DashboardStore(root);
  assert.deepEqual(await store.list(), []);
  const saved = (await store.mutate(null, input))!;
  assert.equal(saved.revision, 1);
  assert.deepEqual(await new DashboardStore(root).list(), [saved]);
  const results = await Promise.allSettled([
    store.mutate(saved.id, { ...saved, name: 'Changed' }),
    store.mutate(saved.id, { ...saved, name: 'Stale' }),
  ]);
  assert.equal(results[0]!.status, 'fulfilled');
  assert.equal(results[1]!.status, 'rejected');
  const current = (await store.list())[0]!;
  assert.equal(current.name, 'Changed');
  assert.equal(current.revision, 2);
  const another = (await store.mutate(null, { name: 'Second', panels: [panel] }))!;
  await assert.rejects(store.mutate(saved.id, { revision: 1 }, true), /changed elsewhere/);
  await store.mutate(saved.id, { revision: 2 }, true);
  assert.deepEqual(await store.list(), [another]);
});

test('corrupt and unsupported files are never overwritten', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DashboardStore(root);
  for (const raw of ['{broken', '{"version":2,"dashboards":[]}', '{"version":1,"dashboards":[{}]}']) {
    await writeFile(path.join(root, 'dashboards.json'), raw);
    await assert.rejects(store.list(), /storage is invalid/);
    await assert.rejects(store.mutate(null, input), /storage is invalid/);
    assert.equal(await readFile(path.join(root, 'dashboards.json'), 'utf8'), raw);
  }
});

test('validates bounds, duplicate surfaces, overlap and identities without requiring a live app', () => {
  assert.deepEqual(validateDashboard(input), input);
  for (const invalid of [
    { ...input, name: '' },
    { ...input, panels: [panel, { ...panel, id: 'p2', y: 6 }] },
    { ...input, panels: [{ ...panel, x: 10 }] },
    { ...input, panels: [{ ...panel, y: -1 }] },
    { ...input, panels: [{ ...panel, w: 1.5 }] },
    { ...input, panels: [{ ...panel, reference: { ...panel.reference, serviceId: '..' } }] },
    { ...input, panels: [{ ...panel, reference: { ...panel.reference, nodeId: 'invalid' } }] },
    { ...input, panels: [panel, { ...panel, id: 'p2', reference: { ...panel.reference, surfaceId: 'other' } }] },
  ]) assert.throws(() => validateDashboard(invalid));
});

test('validates read-only presets without adding revisions', () => {
  assert.deepEqual(validatePresets([{ id: 'starter', ...input }]), [{ id: 'starter', ...input }]);
  assert.throws(() => validatePresets([{ id: 'same', ...input }, { id: 'same', ...input }]), /duplicate/);
  assert.throws(() => validatePresets([{ id: '', ...input }]), /preset id/);
});

test('hub serves its UI, read-only presets and dashboard API with origin checks and persistence across restarts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preset = { id: 'starter', ...input };
  let hub = await startHub({ port: 0, gateways: [], autoGateway: false, configRoot: root, presets: [preset] });
  t.after(() => hub.close());
  const request = (url: string, method = 'GET', value?: unknown, origin = 'http://localhost:5173') => fetch(hub.httpUrl + url, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value),
  });
  const ui = await request('/');
  assert.equal(ui.status, 200);
  const html = await ui.text();
  assert.match(html, /omochi.*Dashboards/);
  const asset = html.match(/src="([^\"]+\.js)"/)![1]!;
  assert.equal((await request(asset)).status, 200);
  assert.equal((await request('/api/dashboards', 'GET', undefined, 'https://untrusted.example')).status, 403);
  assert.equal((await request('/api/presets', 'GET', undefined, 'https://untrusted.example')).status, 403);
  assert.equal((await request('/', 'GET', undefined, 'https://untrusted.example')).status, 403);
  assert.equal((await request('/api/dashboards', 'POST', input, 'https://untrusted.example')).status, 403);
  const preflight = await request('/api/dashboards', 'OPTIONS');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.deepEqual(await (await request('/api/presets')).json(), [preset]);
  assert.equal((await request('/api/presets', 'POST', preset)).status, 405);
  const created = await request('/api/dashboards', 'POST', input);
  assert.equal(created.status, 201);
  const saved = await created.json() as { id: string; revision: number };
  assert.equal((await request(`/api/dashboards/${saved.id}`, 'PUT', { ...input, revision: 0 })).status, 409);
  assert.equal((await request('/api/dashboards', 'POST', { name: '' })).status, 400);
  assert.equal((await request('/api/dashboards/missing')).status, 404);
  assert.equal((await request('/api/dashboards/%ZZ')).status, 400);
  const noJson = await fetch(hub.httpUrl + '/api/dashboards', { method: 'POST', body: JSON.stringify(input) });
  assert.equal(noJson.status, 415);
  const badJson = await fetch(hub.httpUrl + '/api/dashboards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(badJson.status, 400);
  await hub.close();
  hub = await startHub({ port: 0, gateways: [], autoGateway: false, configRoot: root, presets: [preset] });
  const restored = await (await request(`/api/dashboards/${saved.id}`)).json();
  assert.deepEqual(restored, { ...input, ...saved });
  assert.equal((await request(`/api/dashboards/${saved.id}`, 'DELETE', { revision: saved.revision })).status, 200);
  assert.deepEqual(await (await request('/api/dashboards')).json(), []);
});


test('independent dashboard stores retain creates and enforce revisions under contention', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = Array.from({ length: 12 }, () => new DashboardStore(path.join(root, 'new')));
  const created = await Promise.all(stores.map((store, i) => store.mutate(null, { ...input, name: `Dashboard ${i}` })));
  assert.equal(new Set(created.map(d => d!.id)).size, stores.length);
  assert.equal((await stores[0]!.list()).length, stores.length);
  const saved = created[0]!;
  const results = await Promise.allSettled([
    stores[0]!.mutate(saved.id, { ...saved, name: 'Updated' }),
    stores[1]!.mutate(saved.id, { ...saved, name: 'Competing update' }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.match(failed.reason.message, /changed elsewhere/);
  assert.equal(failed.reason.status, 409);
  const current = (await stores[0]!.list()).find(d => d.id === saved.id)!;
  await assert.rejects(stores[1]!.mutate(saved.id, { revision: current.revision - 1 }, true), /changed elsewhere/);
  await stores[0]!.mutate(saved.id, { revision: current.revision }, true);
  const raw = await readFile(path.join(root, 'new/dashboards.json'), 'utf8');
  await assert.rejects(stores[2]!.mutate(null, { name: '' }), /needs a name/);
  assert.equal(await readFile(path.join(root, 'new/dashboards.json'), 'utf8'), raw);
  await assert.rejects(access(path.join(root, 'new/dashboards.json.lock')));
  await stores[3]!.mutate(null, input);
});

test('separate processes retain every successful dashboard create', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = new URL('../src/hub/dashboards.ts', import.meta.url).href;
  const children = Array.from({ length: 4 }, (_, i) => {
    const code = `import { DashboardStore } from ${JSON.stringify(module)};
      const store = new DashboardStore(${JSON.stringify(root)});
      process.stdout.write('ready');
      await new Promise(resolve => process.stdin.once('data', resolve));
      process.stdin.pause();
      for (let n = 0; n < 12; n++) await store.mutate(null, { name: 'child ${i} ' + n, panels: [] });`;
    const child = spawn(process.execPath, ['--eval', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    return { child, ready: once(child.stdout, 'data'), exited: once(child, 'exit'), stderr: () => stderr };
  });
  await Promise.all(children.map(c => c.ready));
  for (const { child } of children) child.stdin.end('go');
  for (const c of children) assert.equal((await c.exited)[0], 0, c.stderr());
  const dashboards = await new DashboardStore(root).list();
  assert.equal(dashboards.length, 48);
  assert.equal(new Set(dashboards.map(d => d.name)).size, 48);
});

test('lock acquisition timeouts are storage-unavailable errors', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dashboards.json.lock'));
  await writeFile(path.join(root, 'dashboards.json.lock/pid'), String(process.pid));
  const store = new DashboardStore(root);
  await assert.rejects(store.mutate(null, input), (error: unknown) => {
    assert.equal((error as { status: number }).status, 503);
    return true;
  });
  assert.deepEqual(await store.list(), []);
  assert.equal(await readFile(path.join(root, 'dashboards.json.lock/pid'), 'utf8'), String(process.pid));
});

test('an update holds the lock across reading so a competing delete sees a stale revision', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const updating = new DashboardStore(root);
  const deleting = new DashboardStore(root);
  const saved = (await updating.mutate(null, input))!;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const internal = updating as unknown as { read(): Promise<unknown> };
  const read = internal.read.bind(updating);
  internal.read = async () => {
    const file = await read();
    entered();
    await proceed;
    return file;
  };
  const update = updating.mutate(saved.id, { ...saved, name: 'Updated' });
  await reading;
  const deletion = deleting.mutate(saved.id, { revision: saved.revision }, true);
  release();
  const results = await Promise.allSettled([update, deletion]);
  assert.equal(results[0]!.status, 'fulfilled');
  assert.equal(results[1]!.status, 'rejected');
  assert.equal((results[1] as PromiseRejectedResult).reason.status, 409);
  assert.equal((await deleting.list()).find(d => d.id === saved.id)!.revision, saved.revision + 1);
});
