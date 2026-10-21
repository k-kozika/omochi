import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts/npm');
const registry = 'https://registry.npmjs.org/';
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface Workspace { directory: string; manifest: Manifest }
interface Packed { name: string; version: string; filename: string; integrity: string }
interface PyPiFile { filename: string; digests: { sha256: string } }

export function existingPyPiFiles(local: PyPiFile[], remote: PyPiFile[]): string[] {
  const existing: string[] = [];
  for (const file of local) {
    const published = remote.find(({ filename }) => filename === file.filename);
    if (!published) continue;
    if (published.digests.sha256 !== file.digests.sha256) throw new Error(`${file.filename} already exists on PyPI with different contents`);
    existing.push(file.filename);
  }
  return existing;
}

export function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

export function validateVersion(version: string, versions: Record<string, string>, tag?: string): void {
  // Restrict releases to the shared stable-version syntax understood by all three registries.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`Invalid stable release version: ${version}`);
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Expected tag v${version}, got ${tag}`);
  for (const [name, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`${name} has version ${actual}; expected ${version}`);
  }
}

export function publicationOrder(workspaces: Workspace[]): Workspace[] {
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
  const ordered: Workspace[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(workspace: Workspace): void {
    const { manifest } = workspace;
    if (visited.has(manifest.name)) return;
    if (visiting.has(manifest.name)) throw new Error(`Dependency cycle at ${manifest.name}`);
    visiting.add(manifest.name);
    for (const field of dependencyFields) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        const dependency = byName.get(name);
        if (version.startsWith('workspace:') && !dependency) throw new Error(`Unknown workspace dependency: ${name}`);
        if (!dependency) continue;
        if (dependency.manifest.private) throw new Error(`${manifest.name} depends on private package ${name}`);
        if (version !== 'workspace:*') throw new Error(`Use workspace:* for ${manifest.name}'s dependency on ${name}`);
        visit(dependency);
      }
    }
    visiting.delete(manifest.name);
    visited.add(manifest.name);
    ordered.push(workspace);
  }
  for (const workspace of workspaces) if (!workspace.manifest.private) visit(workspace);
  return ordered;
}

export function distributionManifest(manifest: Manifest, versions: Map<string, string>): Manifest {
  const result = structuredClone(manifest);
  delete result.scripts;
  delete result.devDependencies;
  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(result[field] ?? {})) {
      if (!version.startsWith('workspace:')) continue;
      const resolved = versions.get(name);
      if (version !== 'workspace:*' || !resolved) throw new Error(`Cannot publish workspace dependency ${name}: ${version}`);
      result[field]![name] = resolved;
    }
  }
  return result;
}

export function validateContents(manifest: Manifest, files: Set<string>): void {
  function entrypoints(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (value && typeof value === 'object') return Object.values(value).flatMap(entrypoints);
    return [];
  }
  const required = ['package.json', 'LICENSE', 'README.md', manifest.main, manifest.types,
    ...Object.values(manifest.bin ?? {}), ...entrypoints(manifest.exports)].filter((value): value is string => !!value);
  for (const file of required) {
    if (!files.has(file.replace(/^\.\//, ''))) throw new Error(`${manifest.name}: missing published file ${file}`);
  }
}

export async function loadRelease(tag?: string): Promise<{ version: string; packages: Workspace[] }> {
  const workspace = await Bun.file(path.join(root, 'package.json')).json();
  const workspaces: Workspace[] = await Promise.all(workspace.workspaces.map(async (directory: string) => ({
    directory, manifest: await Bun.file(path.join(root, directory, 'package.json')).json(),
  })));
  const python = Bun.TOML.parse(await Bun.file(path.join(root, 'packages/sdk/python/pyproject.toml')).text()) as { project: { version: string } };
  const pythonRoot = Bun.TOML.parse(await Bun.file(path.join(root, 'pyproject.toml')).text()) as { project: { version: string } };
  const rust = Bun.TOML.parse(await Bun.file(path.join(root, 'packages/sdk/rust/Cargo.toml')).text()) as { package: { version: string } };
  const version = python.project.version;
  validateVersion(version, {
    ...Object.fromEntries(workspaces.map(({ manifest }) => [manifest.name, manifest.version])),
    'Python workspace': pythonRoot.project.version, 'Rust SDK': rust.package.version,
  }, tag);
  const license = await readFile(path.join(root, 'LICENSE'));
  for (const sdk of ['python', 'rust']) {
    if (!license.equals(await readFile(path.join(root, `packages/sdk/${sdk}/LICENSE`)))) {
      throw new Error(`${sdk} LICENSE must match the repository LICENSE`);
    }
  }
  return { version, packages: publicationOrder(workspaces) };
}

async function pack(): Promise<void> {
  const release = await loadRelease();
  const versions = new Map(release.packages.map(({ manifest }) => [manifest.name, manifest.version]));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const packages: Packed[] = [];
  for (const { directory, manifest } of release.packages) {
    const staging = await mkdtemp(path.join(tmpdir(), 'omochi-pack-'));
    try {
      if (!manifest.files?.includes('dist')) throw new Error(`${manifest.name} needs an explicit files allowlist including dist`);
      for (const file of manifest.files) {
        if (path.isAbsolute(file) || file.split('/').includes('..') || /[*?]/.test(file)) throw new Error(`Unsupported files entry: ${file}`);
        await cp(path.join(root, directory, file), path.join(staging, file), { recursive: true });
      }
      const distributed = distributionManifest(manifest, versions);
      await writeFile(path.join(staging, 'package.json'), JSON.stringify(distributed, null, 2) + '\n');
      await cp(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'));
      const readme = path.join(root, directory, 'README.md');
      await cp(await Bun.file(readme).exists() ? readme : path.join(root, 'README.md'), path.join(staging, 'README.md'));
      const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], staging));
      validateContents(distributed, new Set(packed.files.map((file: { path: string }) => file.path)));
      packages.push({ name: manifest.name, version: manifest.version, filename: packed.filename, integrity: packed.integrity });
      console.log(`Packed ${manifest.name}@${manifest.version}`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: release.version, packages }, null, 2) + '\n');
}

async function publishNpm(): Promise<void> {
  const release = await loadRelease();
  const packed = await Bun.file(path.join(output, 'manifest.json')).json() as { version: string; packages: Packed[] };
  if (packed.version !== release.version || packed.packages.length !== release.packages.length) throw new Error('Unexpected npm artifact manifest');
  // Check every tarball before making the first irreversible registry write.
  for (const [index, { manifest }] of release.packages.entries()) {
    const artifact = packed.packages[index]!;
    if (artifact.name !== manifest.name || artifact.version !== manifest.version || artifact.filename !== `omochi-ui-${manifest.name.split('/')[1]}-${manifest.version}.tgz`) {
      throw new Error(`Unexpected npm artifact for ${manifest.name}`);
    }
    const integrity = `sha512-${createHash('sha512').update(await readFile(path.join(output, artifact.filename))).digest('base64')}`;
    if (integrity !== artifact.integrity) throw new Error(`Corrupt npm artifact: ${artifact.filename}`);
  }
  const unpublished: Packed[] = [];
  for (const artifact of packed.packages) {
    const response = await fetch(`${registry}${encodeURIComponent(artifact.name)}/${artifact.version}`, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) {
      const existing = await response.json() as { dist: { integrity: string } };
      if (existing.dist.integrity !== artifact.integrity) throw new Error(`${artifact.name}@${artifact.version} already exists with different contents`);
      console.log(`Already published ${artifact.name}@${artifact.version}; skipping`);
    } else if (response.status === 404) {
      unpublished.push(artifact);
    } else {
      throw new Error(`npm lookup failed for ${artifact.name}: HTTP ${response.status}`);
    }
  }
  for (const artifact of unpublished) {
    console.log(run('npm', ['publish', path.join(output, artifact.filename), '--access', 'public', '--provenance', '--ignore-scripts', '--registry', registry]));
  }
}

async function preparePyPi(): Promise<void> {
  const { version } = await loadRelease();
  const directory = path.join(root, 'artifacts/python');
  const filenames = (await readdir(directory)).filter((name) => name.endsWith('.whl') || name.endsWith('.tar.gz'));
  if (filenames.length !== 2 || !filenames.some((name) => name.endsWith('.whl')) || !filenames.some((name) => name.endsWith('.tar.gz'))) {
    throw new Error('Expected a Python wheel and source distribution');
  }
  const local = await Promise.all(filenames.map(async (filename) => ({
    filename, digests: { sha256: createHash('sha256').update(await readFile(path.join(directory, filename))).digest('hex') },
  })));
  const response = await fetch(`https://pypi.org/pypi/omochi-ui/${version}/json`, { signal: AbortSignal.timeout(30_000) });
  let existing: string[] = [];
  if (response.ok) {
    const { urls } = await response.json() as { urls: PyPiFile[] };
    existing = existingPyPiFiles(local, urls);
  } else if (response.status !== 404) {
    throw new Error(`PyPI lookup failed: HTTP ${response.status}`);
  }
  // Validate all hashes before removing any existing files from this job's copy.
  for (const filename of existing) await rm(path.join(directory, filename));
  const publish = existing.length !== local.length;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  console.log(`${local.length - existing.length} Python distributions to upload; ${existing.length} identical files already published`);
}

if (import.meta.main) {
  const [command, tag] = process.argv.slice(2);
  if (command === 'check') {
    const release = await loadRelease(tag);
    if (tag !== undefined) {
      const commit = run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
      if (commit !== run('git', ['rev-parse', 'HEAD'])) throw new Error('Checkout does not match the release tag');
      run('git', ['merge-base', '--is-ancestor', commit, 'origin/main']);
    }
    console.log(`Release ${release.version}: ${release.packages.map(({ manifest }) => manifest.name).join(', ')}`);
  } else if (command === 'pack') await pack();
  else if (command === 'publish-npm') await publishNpm();
  else if (command === 'prepare-pypi') await preparePyPi();
  else throw new Error('Usage: bun scripts/release.ts check [vX.Y.Z] | pack | publish-npm | prepare-pypi');
}
