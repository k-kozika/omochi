// Run after bun run build: bun packages/hub-ui/test/browser.mjs
// Requires Chromium (CHROMIUM_BIN overrides its executable).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { App } from '../../sdk/typescript/dist/index.js';
import { UnixSocketServerTransport } from '../../sdk/typescript/dist/node/index.js';
import { startGateway, createStaticLocator } from '../../discovery/dist/index.js';
import { startHub } from '../../cli/dist/hub/hub.js';

const temporary = await mkdtemp(path.join(tmpdir(), 'omochi-browser-'));
const output = process.env.SCREENSHOT_DIR ?? '/tmp/omochi-hub-screenshots';
await mkdir(output, { recursive: true });
const closers = [];
let chrome;
let socket;
let preview;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
try {
  const states = [];
  const transports = [];
  const gateways = [];
  const roots = [];
  for (const [i, name] of ['Studio', 'Workshop'].entries()) {
    const root = path.join(temporary, `node-${i}`);
    roots.push(root);
    const state = { count: 0 };
    states.push(state);
    const app = new App(state);
    const increment = app.action('increment', async (_input, context) => context.update(s => { s.count += 1; }));
    app.surface('counter', (ui, s) => {
      ui.text(`${name} counter`, { variant: 'h2' });
      ui.text(`Completed tasks: ${s.count}`);
      ui.button(`Add task in ${name}`, increment.call({}), { variant: 'primary' });
    });
    app.surface('status', ui => {
      ui.text('System status', { variant: 'h2' });
      ui.text('All services are running.');
      ui.text('Ready for your next idea.');
    });
    const transport = new UnixSocketServerTransport({ serviceId: 'tasks', name: 'Task tracker', runtimeDir: root });
    transports.push(transport);
    const runtime = app.build();
    void runtime.start(transport);
    await runtime.ready();
    closers.push(() => transport.close());
    const gateway = await startGateway({ root, nodeId: i ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa', name });
    gateways.push(gateway); closers.push(() => gateway.close());
  }
  const options = { port: 0, autoGateway: false, configRoot: path.join(temporary, 'config'),
    gateways: [createStaticLocator(gateways.map(g => ({ kind: 'unix', socketPath: g.socketPath })))],
    presets: [{ id: 'starter', name: 'Starter preset', panels: [{ id: 'starter-status', title: 'Starter status',
      reference: { nodeId: 'aaaaaaaaaaaaaaaa', serviceId: 'tasks', surfaceId: 'status' }, x: 0, y: 0, w: 12, h: 6 }] }],
  };
  let hub = await startHub(options);
  closers.push(() => hub.close());
  chrome = spawn(process.env.CHROMIUM_BIN ?? 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${temporary}/chrome`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserUrl = '';
  chrome.stderr.on('data', chunk => { const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/); if (match) browserUrl = match[1]; });
  await until(() => browserUrl, 'Chromium startup');
  const endpoint = new URL(browserUrl);
  const targets = await (await fetch(`http://${endpoint.host}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const text = () => evaluate('document.body.innerText');
  const click = async label => {
    await until(() => evaluate(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.replace('▧', '').trim() === ${JSON.stringify(label)} && !b.disabled)`), `button ${label}`);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.replace('▧', '').trim() === ${JSON.stringify(label)} && !b.disabled).click()`);
  };
  const input = async (selector, value) => {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  const screenshot = async name => {
    const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(output, name), Buffer.from(image.data, 'base64'));
  };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${hub.httpUrl}/?preset=starter` });
  await until(async () => (await text()).includes('Starter preset') && (await text()).includes('System status'), 'preset dashboard');
  await screenshot('preset.png');
  await click('Save as dashboard');
  await click('Save dashboard');
  await click('＋ New dashboard');
  await click('＋ Add your first view');
  await until(() => evaluate("document.querySelectorAll('.app-options button').length === 4"), 'four discovered surfaces');
  await screenshot('add-view.png');
  await click('counter＋ Add');
  await input('[aria-label="Dashboard name"]', 'Daily overview');
  await click('＋ Add view'); await click('status＋ Add');
  await click('＋ Add view'); await click('counter＋ Add');
  await until(() => evaluate("document.querySelectorAll('.panel').length === 3"), 'three panels');
  // Move the second panel using numeric controls.
  const title = 'Task tracker · status';
  await input(`[aria-label="${title} x"]`, '6');
  await input(`[aria-label="${title} y"]`, '0');
  await input('[aria-label="Panel title Task tracker · counter"]', 'Studio activity');
  await input('[aria-label="Panel title Task tracker · counter"]', 'Workshop activity');
  // Pointer drag places the third panel below the first row.
  const bounds = await evaluate(`(() => { const e = document.querySelector('[aria-label="Move Workshop activity"]'); const r = e.getBoundingClientRect(); return { x:r.x+r.width/2,y:r.y+r.height/2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...bounds, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bounds.x, y: bounds.y - 56 * 6, button: 'left', buttons: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bounds.x, y: bounds.y - 56 * 6, button: 'left', clickCount: 1 });
  await until(() => evaluate("document.querySelector('[aria-label=\"Workshop activity y\"]').value === '6'"), 'pointer drag');
  await screenshot('editing.png');
  await click('Save dashboard');
  await click('Add task in Studio');
  await until(() => states[0].count === 1, 'action routed to Studio');
  assert.equal(states[1].count, 0);
  await click('Add task in Workshop');
  await until(() => states[1].count === 1, 'action routed to Workshop');
  await screenshot('dashboard.png');
  const saved = await (await fetch(`${hub.httpUrl}/api/dashboards`)).json();
  const daily = saved.find(dashboard => dashboard.name === 'Daily overview');
  assert.equal(daily.panels.length, 3);
  await cdp('Page.reload');
  await until(async () => (await text()).includes('Studio activity'), 'saved layout on refresh');
  // A surface disappears and returns on the same stream without losing placement.
  const surface = 'counter';
  await transports[0].send({ version: 'v0.9', deleteSurface: { surfaceId: surface } });
  await until(async () => (await text()).includes('View unavailable'), 'removed surface placeholder');
  await transports[0].send({ version: 'v0.9', createSurface: { surfaceId: surface, catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json' } });
  await transports[0].send({ version: 'v0.9', updateComponents: { surfaceId: surface, components: [{ id: 'root', component: 'Text', text: 'Studio is back' }] } });
  await until(async () => (await text()).includes('Studio is back'), 'surface restoration');
  // Shared hub persistence and client reconnect after a backend restart.
  const port = Number(new URL(hub.httpUrl).port);
  await hub.close(); hub = await startHub({ ...options, port });
  await until(async () => (await text()).includes('Hub connected') && (await text()).includes('Studio is back'), 'hub reconnection');
  assert.deepEqual(await (await fetch(`${hub.httpUrl}/api/dashboards`)).json(), saved);
  // Conflict must leave local edits intact.
  await click('Edit dashboard');
  await input('[aria-label="Dashboard name"]', 'Unsaved local edits');
  await fetch(`${hub.httpUrl}/api/dashboards/${daily.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...daily, name: 'Changed elsewhere' }) });
  await click('Save dashboard');
  await until(async () => (await text()).includes('changed elsewhere'), 'revision conflict');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Dashboard name\"]').value"), 'Unsaved local edits');
  await click('Cancel');
  // Multiple dashboards and cancellation.
  await click('＋ New dashboard'); await input('[aria-label="Dashboard name"]', 'Second dashboard'); await click('Save dashboard');
  await until(async () => (await text()).includes('This dashboard is ready for views'), 'second empty dashboard');
  await click('Daily overview');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until(() => evaluate("getComputedStyle(document.querySelector('.panel-grid')).display === 'flex'"), 'narrow layout');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await screenshot('mobile.png');
  await click('Edit dashboard');
  assert.equal(await evaluate("document.querySelectorAll('.drag-handle').length"), 0);
  await click('Cancel');
  // The development preview uses the renderer without any hub dashboard shell.
  const vite = fileURLToPath(new URL('../../dev-server/node_modules/vite/bin/vite.js', import.meta.url));
  preview = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', '0'], {
    cwd: fileURLToPath(new URL('../../dev-server', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let previewUrl = '';
  preview.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\//); if (match) previewUrl = match[0]; });
  await until(() => previewUrl, 'development preview startup');
  await cdp('Page.navigate', { url: `${previewUrl}?ws=${encodeURIComponent(hub.url)}` });
  await until(() => evaluate("document.querySelectorAll('.omochi-surface').length === 4"), 'development preview surfaces');
  assert.equal(await evaluate("document.querySelector('.sidebar') === null"), true);
  await screenshot('dev-preview.png');
  assert.deepEqual(errors, []);
  console.log(`Browser checks passed. Screenshots: ${output}`);
} finally {
  socket?.close();
  if (preview) { preview.kill('SIGTERM'); await Promise.race([once(preview, 'exit'), delay(3000)]); }
  if (chrome) { chrome.kill('SIGTERM'); await Promise.race([once(chrome, 'exit'), delay(3000)]); }
  for (const close of closers.reverse()) await close();
  await rm(temporary, { recursive: true, force: true });
}
