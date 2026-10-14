import { constants } from 'node:fs'
import { access, mkdir, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Resolves the directory that holds one subdirectory per published omochi service.
 *
 * `$XDG_RUNTIME_DIR` is the intended location because it is per-user and mode 0700 —
 * that permission is the entire local trust boundary. `/tmp/omochi` is never used as a
 * fallback: its parent is world-writable and sticky, so another local user could
 * pre-create a service directory and squat the socket.
 */
export function omochiRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_RUNTIME_DIR
  if (configured) return path.join(configured, 'omochi')
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return path.join(tmpdir(), `omochi-${uid}`, 'omochi')
}

/**
 * The socket the machine's gateway listens on, beside the per-service directories.
 *
 * It is a file rather than a directory, which is why a discovery scan must skip
 * anything that is not a directory instead of relying on a missing manifest.
 */
export function gatewaySocketPath(root: string): string {
  return path.join(root, 'gateway.sock')
}

/** Creates the root if needed and refuses to use one that other users can reach. */
export async function ensureRuntimeRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by umask and leaves an existing directory untouched.
  await chmod(root, 0o700)
  const stats = await lstat(root)
  if (!stats.isDirectory()) throw new Error(`omochi runtime path is not a directory: ${root}`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && stats.uid !== uid) {
    throw new Error(`omochi runtime directory is owned by another user: ${root}`)
  }
}

export async function runtimeRootExists(root: string): Promise<boolean> {
  try {
    await access(root, constants.F_OK)
    return true
  } catch {
    return false
  }
}
