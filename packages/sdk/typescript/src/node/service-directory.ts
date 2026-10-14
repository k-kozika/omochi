import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { rmSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

/** Mirrors the id constraint the hub applies, so `<serviceId>/<surfaceId>` stays splittable. */
export const SERVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Linux caps `sun_path` at 108 bytes and macOS at 104; leave room for the null terminator. */
const MAX_SOCKET_PATH_BYTES = 100;

export function validateServiceId(serviceId: string): string {
  // `.` and `..` match the character class but would collapse or escape the service directory.
  if (serviceId === "." || serviceId === ".." || !SERVICE_ID_PATTERN.test(serviceId)) {
    throw new TypeError(`serviceId must match ${SERVICE_ID_PATTERN} and cannot be "." or "..": ${JSON.stringify(serviceId)}`);
  }
  return serviceId;
}

/**
 * Resolves the directory holding one subdirectory per published service.
 *
 * `$XDG_RUNTIME_DIR` is per-user and mode 0700, and that permission is the entire local
 * trust boundary. A world-writable `/tmp/omochi` is never used, because another local
 * user could pre-create a service directory and squat the socket.
 */
export function omochiRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_RUNTIME_DIR;
  if (configured) return path.join(configured, "omochi");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(tmpdir(), `omochi-${uid}`, "omochi");
}

export async function ensureServiceDirectory(root: string, serviceId: string): Promise<string> {
  const directory = path.join(root, validateServiceId(serviceId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and leaves an existing directory untouched.
  await chmod(root, 0o700);
  await chmod(directory, 0o700);
  return directory;
}

export function assertSocketPathFits(socketPath: string): void {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new RangeError(`unix socket path is too long for this platform: ${socketPath}`);
  }
}

/**
 * Takes ownership of the socket path, removing one left behind by a crash.
 *
 * A path that still accepts connections means another instance owns this service id;
 * that probe is also the mutual-exclusion primitive.
 */
export async function claimSocketPath(socketPath: string): Promise<void> {
  const inUse = await new Promise<boolean>((resolve) => {
    const probe = createConnection(socketPath);
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // A live peer immediately replays its snapshot. Draining it and closing cleanly keeps
    // the probe from resetting the connection, which would surface as an unhandled error.
    probe.on("data", () => {});
    probe.on("error", () => settle(false));
    probe.once("close", () => settle(false));
    probe.once("connect", () => {
      settle(true);
      probe.end();
    });
  });
  if (inUse) throw new Error(`another omochi service already owns ${socketPath}`);
  await rm(socketPath, { force: true });
}

export interface ServiceManifest {
  name: string;
  icon?: string;
  socket: string;
}

/** Publishes the manifest atomically so a discovery pass never reads a half-written file. */
export async function writeServiceManifest(directory: string, manifest: ServiceManifest): Promise<void> {
  const temporary = path.join(directory, `.manifest.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await rename(temporary, path.join(directory, "manifest.json"));
}

/** Retracts the advertisement first, then the socket, then the directory itself. */
export async function removeServiceDirectory(directory: string): Promise<void> {
  await rm(path.join(directory, "manifest.json"), { force: true });
  await rm(directory, { recursive: true, force: true });
}

/** Last-resort cleanup: `process.on("exit")` cannot await asynchronous work. */
export function removeServiceDirectorySync(directory: string): void {
  try {
    unlinkSync(path.join(directory, "manifest.json"));
  } catch {
    // Already gone.
  }
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}
