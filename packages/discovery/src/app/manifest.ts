import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface ServiceManifest {
  name: string
  icon?: string
  socket: string
}

/** Emoji fit easily; a data URL icon is capped so a hostile manifest cannot bloat /services. */
const MAX_ICON_LENGTH = 64 * 1024

function isPlainFileName(value: string): boolean {
  if (!value || value === '.' || value === '..') return false
  return !value.includes('/') && !value.includes('\\') && value === path.basename(value)
}

function isSupportedIcon(value: string): boolean {
  if (value.length > MAX_ICON_LENGTH) return false
  if (!value.startsWith('data:')) return true
  return /^data:image\/(png|svg\+xml|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(value)
}

/**
 * Validates one manifest. A manifest is written by an arbitrary local process, so the
 * socket name must stay inside the service directory and the icon must be renderable
 * by a browser without the hub serving files from the runtime directory.
 */
export function parseServiceManifest(value: unknown): ServiceManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const { name, icon, socket } = record
  if (typeof name !== 'string' || !name.trim()) return null
  if (typeof socket !== 'string' || !isPlainFileName(socket)) return null
  if (icon !== undefined && (typeof icon !== 'string' || !isSupportedIcon(icon))) return null
  const manifest: ServiceManifest = { name, socket }
  if (typeof icon === 'string') manifest.icon = icon
  return manifest
}

/** Returns null for a missing, unreadable, half-written, or invalid manifest. */
export async function readServiceManifest(directory: string): Promise<ServiceManifest | null> {
  try {
    const text = await readFile(path.join(directory, 'manifest.json'), 'utf8')
    return parseServiceManifest(JSON.parse(text))
  } catch {
    return null
  }
}
