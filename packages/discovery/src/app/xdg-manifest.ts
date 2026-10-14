import { watch, type Dirent, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { isValidServiceId } from '@omochi-ui/core'

import { ensureRuntimeRoot } from '../runtime-dir.js'
import { readServiceManifest, type ServiceManifest } from './manifest.js'
import type { DiscoveredService, DiscoveryProvider, DiscoverySink } from './provider.js'

export interface XdgManifestProviderOptions {
  root: string
  debounceMs?: number
  /** fs.watch silently drops events on some filesystems, so a slow full rescan backs it up. */
  rescanMs?: number
}

function fingerprint(manifest: ServiceManifest): string {
  return JSON.stringify([manifest.name, manifest.icon ?? null, manifest.socket])
}

export function createXdgManifestProvider(options: XdgManifestProviderOptions): DiscoveryProvider {
  const debounceMs = options.debounceMs ?? 100
  const rescanMs = options.rescanMs ?? 5000
  const known = new Map<string, string>()
  let sink: DiscoverySink | null = null
  let watcher: FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  let rescan: NodeJS.Timeout | null = null
  let closed = false

  const scan = async () => {
    if (closed || !sink) return
    let entries: Dirent[]
    try {
      entries = await readdir(options.root, { withFileTypes: true })
    } catch {
      return
    }
    if (closed || !sink) return
    const seen = new Set<string>()
    for (const entry of entries) {
      // The gateway's own socket sits beside the service directories, so anything
      // that is not a directory is not a service.
      if (!entry.isDirectory()) continue
      const serviceId = entry.name
      if (!isValidServiceId(serviceId)) continue
      const directory = path.join(options.root, serviceId)
      const manifest = await readServiceManifest(directory)
      if (closed || !sink) return
      // A directory can exist before its manifest is written; the next scan picks it up.
      if (!manifest) continue
      seen.add(serviceId)
      const service: DiscoveredService = {
        serviceId,
        name: manifest.name,
        endpoint: { kind: 'unix', path: path.join(directory, manifest.socket) },
      }
      if (manifest.icon !== undefined) service.icon = manifest.icon
      const previous = known.get(serviceId)
      const current = fingerprint(manifest)
      if (previous === undefined) {
        known.set(serviceId, current)
        sink.added(service)
      } else if (previous !== current) {
        known.set(serviceId, current)
        sink.changed(service)
      }
    }
    for (const serviceId of [...known.keys()]) {
      if (seen.has(serviceId)) continue
      known.delete(serviceId)
      sink.removed(serviceId)
    }
  }

  const scheduleScan = () => {
    if (closed) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void scan()
    }, debounceMs)
  }

  const arm = () => {
    if (closed) return
    try {
      watcher = watch(options.root, () => scheduleScan())
      // A dropped watch must not take the hub down with it.
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        setTimeout(arm, debounceMs).unref()
      })
    } catch {
      setTimeout(arm, debounceMs).unref()
    }
  }

  return {
    kind: 'xdg-manifest',
    async start(target) {
      sink = target
      await ensureRuntimeRoot(options.root)
      if (closed) return
      // Watch before the first scan so a service created in between is not missed.
      arm()
      await scan()
      if (closed) return
      rescan = setInterval(() => void scan(), rescanMs)
      rescan.unref()
    },
    async close() {
      closed = true
      if (debounce) clearTimeout(debounce)
      if (rescan) clearInterval(rescan)
      watcher?.close()
      watcher = null
      sink = null
    },
  }
}
