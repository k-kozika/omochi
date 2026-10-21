import { expect, test } from 'bun:test';
import { distributionManifest, existingPyPiFiles, publicationOrder, validateContents, validateVersion, type Manifest } from './release.ts';

test('release versions must agree across SDKs and match a stable tag', () => {
  validateVersion('0.1.0', { npm: '0.1.0', rust: '0.1.0' }, 'v0.1.0');
  expect(() => validateVersion('0.1.0', { rust: '0.2.0' })).toThrow('rust has version');
  expect(() => validateVersion('0.1.0', {}, 'v0.2.0')).toThrow('Expected tag');
  for (const version of ['0.1.0-beta.1', '01.1.0', 'v0.1.0', 'main']) {
    expect(() => validateVersion(version, {})).toThrow('Invalid stable');
  }
});

test('public packages are ordered by dependencies and cannot depend on private workspaces', () => {
  const core = { directory: 'core', manifest: { name: '@omochi-ui/core', version: '0.1.0' } };
  const cli = { directory: 'cli', manifest: { name: '@omochi-ui/cli', version: '0.1.0', dependencies: { '@omochi-ui/core': 'workspace:*' } } };
  expect(publicationOrder([cli, core]).map(({ directory }) => directory)).toEqual(['core', 'cli']);
  expect(() => publicationOrder([cli, { ...core, manifest: { ...core.manifest, private: true } }])).toThrow('private');
  expect(() => publicationOrder([cli])).toThrow('Unknown workspace');
  expect(() => publicationOrder([cli, { ...core, manifest: { ...core.manifest, dependencies: { '@omochi-ui/cli': 'workspace:*' } } }])).toThrow('cycle');
});

test('distribution manifests resolve runtime workspace dependencies without changing source manifests', () => {
  const source: Manifest = { name: '@omochi-ui/cli', version: '0.1.0', dependencies: { '@omochi-ui/core': 'workspace:*', ws: '^8.18.0' }, devDependencies: { typescript: '*' }, scripts: { build: 'tsc' } };
  const distributed = distributionManifest(source, new Map([['@omochi-ui/core', '0.1.0']]));
  expect(distributed.dependencies).toEqual({ '@omochi-ui/core': '0.1.0', ws: '^8.18.0' });
  expect(distributed.devDependencies).toBeUndefined();
  expect(distributed.scripts).toBeUndefined();
  expect(source.dependencies!['@omochi-ui/core']).toBe('workspace:*');
  expect(() => distributionManifest(source, new Map())).toThrow('Cannot publish');
});

test('package contents must include exported assets, binaries, types and license', () => {
  const manifest: Manifest = { name: '@omochi-ui/hub-ui', version: '0.1.0', exports: { './assets': './dist/index.html', './contracts': { types: './dist/contracts.d.ts', default: './dist/contracts.js' } } };
  const files = new Set(['package.json', 'LICENSE', 'README.md', 'dist/index.html', 'dist/contracts.d.ts', 'dist/contracts.js']);
  validateContents(manifest, files);
  files.delete('dist/index.html');
  expect(() => validateContents(manifest, files)).toThrow('dist/index.html');
});

test('PyPI retries skip identical files and fail before uploading conflicting distributions', () => {
  const wheel = { filename: 'omochi_ui-0.1.0-py3-none-any.whl', digests: { sha256: 'wheel' } };
  const sdist = { filename: 'omochi_ui-0.1.0.tar.gz', digests: { sha256: 'sdist' } };
  expect(existingPyPiFiles([wheel, sdist], [])).toEqual([]);
  expect(existingPyPiFiles([wheel, sdist], [wheel])).toEqual([wheel.filename]);
  expect(existingPyPiFiles([wheel, sdist], [wheel, sdist])).toEqual([wheel.filename, sdist.filename]);
  expect(() => existingPyPiFiles([wheel, sdist], [wheel, { ...sdist, digests: { sha256: 'other-source' } }])).toThrow('different contents');
});
