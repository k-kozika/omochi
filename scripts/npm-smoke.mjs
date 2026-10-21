// Copied outside the checkout by smoke-npm.ts; all imports resolve to tarballs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { App } from '@omochi-ui/sdk';
import * as nodeSdk from '@omochi-ui/sdk/node';
import * as websocket from '@omochi-ui/core/websocket';
import * as discovery from '@omochi-ui/discovery';
import { startHub } from '@omochi-ui/cli/dist/hub/hub.js';

assert.equal(typeof App, 'function');
assert.ok(Object.keys(nodeSdk).length && Object.keys(websocket).length && Object.keys(discovery).length);
assert.ok((await readFile(fileURLToPath(import.meta.resolve('@omochi-ui/renderer/styles.css')), 'utf8')).length);
assert.ok((await readFile(fileURLToPath(import.meta.resolve('@omochi-ui/utils/bin/omochi-utils.js')), 'utf8')).startsWith('#!/usr/bin/env bun'));

const hub = await startHub({ host: '127.0.0.1', port: 0, gateways: [], autoGateway: false, configRoot: './config' });
try {
  const response = await fetch(hub.httpUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.length >= 2, 'hub HTML must reference built JavaScript and CSS');
  for (const asset of assets) assert.equal((await fetch(new URL(asset, hub.httpUrl))).status, 200, asset);
} finally {
  await hub.close();
}
