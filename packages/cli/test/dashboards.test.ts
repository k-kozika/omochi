import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
