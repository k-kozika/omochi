import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Where this node's identity and its pinned peers live.
 *
 * Config, not runtime: `$XDG_RUNTIME_DIR` is cleared on reboot, and a node that forgot
 * who it was would have to be paired again every morning. `$XDG_CONFIG_HOME` is
 * Linux-flavoured but `~/.config` is honoured widely enough to use everywhere, which
 * keeps one path to document rather than one per platform.
 */
export function omochiConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_CONFIG_HOME
  if (configured) return path.join(configured, 'omochi')
  return path.join(homedir(), '.config', 'omochi')
}

/** Creates the root if needed and refuses one that another user owns. */
export async function ensureConfigRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by umask and leaves an existing directory untouched.
  await chmod(root, 0o700)
  const stats = await lstat(root)
  if (!stats.isDirectory()) throw new Error(`omochi config path is not a directory: ${root}`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && stats.uid !== uid) {
    throw new Error(`omochi config directory is owned by another user: ${root}`)
  }
}

export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Replaces a file atomically, so a reader never sees a half-written secret and a crash
 * mid-write leaves the previous contents intact.
 */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}
