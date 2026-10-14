import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { isValidNodeId, isValidServiceId } from '@omochi-ui/core'
import type { DashboardPreset, Panel } from '@omochi-ui/hub-ui/contracts'
import { parse } from 'smol-toml'

type Height = 'small' | 'medium' | 'large'

export interface CompositionService {
  id: string
  command: string[]
  cwd: string
  env: Record<string, string>
}

export interface Composition {
  id: string
  services: CompositionService[]
  preset: DashboardPreset
}

const HEIGHTS: Record<Height, number> = { small: 4, medium: 6, large: 9 }
const UTILITY_MODES = new Set(['button', 'watch', 'process', 'tail', 'http'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a table`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key))
  if (unexpected) throw new Error(`${label} has unknown field ${JSON.stringify(unexpected)}`)
}

function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
  return value.trim()
}

function argv(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`${label} must be a non-empty array of strings`)
  }
  return [...value] as string[]
}

function utilityExecutable(): string {
  return fileURLToPath(import.meta.resolve('@omochi-ui/utils/bin/omochi-utils.js'))
}

function parseService(id: string, value: unknown, root: string): CompositionService {
  if (!isValidServiceId(id)) throw new Error(`invalid service id: ${JSON.stringify(id)}`)
  const service = record(value, `services.${id}`)
  keys(service, ['command', 'utility', 'cwd', 'env'], `services.${id}`)
  const hasCommand = Object.hasOwn(service, 'command')
  const hasUtility = Object.hasOwn(service, 'utility')
  if (hasCommand === hasUtility) throw new Error(`services.${id} must define exactly one of command or utility`)

  let command: string[]
  if (hasUtility) {
    const utility = argv(service.utility, `services.${id}.utility`)
    if (!UTILITY_MODES.has(utility[0]!)) {
      throw new Error(`services.${id}.utility must start with button, watch, process, tail, or http`)
    }
    command = [process.execPath, utilityExecutable(), utility[0]!, '--service-id', id, ...utility.slice(1)]
  } else command = argv(service.command, `services.${id}.command`)

  const cwd = service.cwd === undefined ? root : path.resolve(root, text(service.cwd, `services.${id}.cwd`, 4096))
  const environment: Record<string, string> = {}
  if (service.env !== undefined) {
    const env = record(service.env, `services.${id}.env`)
    for (const [name, raw] of Object.entries(env)) {
      if (!name || typeof raw !== 'string') throw new Error(`services.${id}.env values must be strings`)
      environment[name] = raw
    }
  }
  environment.OMOCHI_SERVICE = id
  return { id, command, cwd, env: environment }
}

/** Parse a composition and resolve its semantic rows onto the hub's twelve-column grid. */
export function parseComposition(source: string, file: string, nodeId: string): Composition {
  if (!isValidNodeId(nodeId)) throw new Error(`invalid local node id: ${JSON.stringify(nodeId)}`)
  let raw: unknown
  try { raw = parse(source) }
  catch (error) { throw new Error(`could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`) }
  const root = record(raw, 'composition')
  keys(root, ['version', 'id', 'services', 'dashboard'], 'composition')
  if (root.version !== 1) throw new Error('composition.version must be 1')
  const id = text(root.id, 'composition.id', 100)
  const directory = path.dirname(path.resolve(file))

  const servicesTable = record(root.services, 'services')
  if (!Object.keys(servicesTable).length) throw new Error('services must not be empty')
  const services = Object.entries(servicesTable).map(([serviceId, value]) => parseService(serviceId, value, directory))
  const serviceIds = new Set(services.map((service) => service.id))

  const dashboard = record(root.dashboard, 'dashboard')
  keys(dashboard, ['name', 'rows', 'panels'], 'dashboard')
  const name = text(dashboard.name, 'dashboard.name')
  if (!Array.isArray(dashboard.rows) || !dashboard.rows.length) throw new Error('dashboard.rows must be a non-empty array of tables')
  const panelsTable = record(dashboard.panels, 'dashboard.panels')
  const definitions = new Map<string, { title: string; service: string; surface: string }>()
  for (const [panelId, value] of Object.entries(panelsTable)) {
    text(panelId, 'dashboard panel id', 100)
    const panel = record(value, `dashboard.panels.${panelId}`)
    keys(panel, ['title', 'service', 'surface'], `dashboard.panels.${panelId}`)
    const service = text(panel.service, `dashboard.panels.${panelId}.service`, 64)
    if (!serviceIds.has(service)) throw new Error(`dashboard.panels.${panelId} references undeclared service ${JSON.stringify(service)}`)
    definitions.set(panelId, {
      title: text(panel.title, `dashboard.panels.${panelId}.title`),
      service,
      surface: panel.surface === undefined ? 'main' : text(panel.surface, `dashboard.panels.${panelId}.surface`, 4096),
    })
  }
  if (!definitions.size) throw new Error('dashboard.panels must not be empty')

  const placed = new Set<string>()
  const panels: Panel[] = []
  let y = 0
  for (const [rowIndex, rawRow] of dashboard.rows.entries()) {
    const row = record(rawRow, `dashboard.rows[${rowIndex}]`)
    keys(row, ['panels', 'height'], `dashboard.rows[${rowIndex}]`)
    if (!Array.isArray(row.panels) || !row.panels.length || row.panels.length > 12 || row.panels.some((panel) => typeof panel !== 'string')) {
      throw new Error(`dashboard.rows[${rowIndex}].panels must contain 1 to 12 panel ids`)
    }
    const height = row.height === undefined ? 'medium' : row.height
    if (height !== 'small' && height !== 'medium' && height !== 'large') {
      throw new Error(`dashboard.rows[${rowIndex}].height must be small, medium, or large`)
    }
    const count = row.panels.length
    const base = Math.floor(12 / count)
    const remainder = 12 % count
    let x = 0
    for (const [column, panelId] of (row.panels as string[]).entries()) {
      const definition = definitions.get(panelId)
      if (!definition) throw new Error(`dashboard.rows[${rowIndex}] references unknown panel ${JSON.stringify(panelId)}`)
      if (placed.has(panelId)) throw new Error(`dashboard panel ${JSON.stringify(panelId)} is placed more than once`)
      placed.add(panelId)
      const width = base + (column < remainder ? 1 : 0)
      panels.push({
        id: panelId,
        title: definition.title,
        reference: { nodeId, serviceId: definition.service, surfaceId: definition.surface },
        x, y, w: width, h: HEIGHTS[height],
      })
      x += width
    }
    y += HEIGHTS[height]
  }
  const missing = [...definitions.keys()].find((panelId) => !placed.has(panelId))
  if (missing) throw new Error(`dashboard panel ${JSON.stringify(missing)} is not placed in a row`)
  return { id, services, preset: { id, name, panels } }
}

export async function loadComposition(file: string, nodeId: string): Promise<Composition> {
  const resolved = path.resolve(file)
  let source: string
  try { source = await readFile(resolved, 'utf8') }
  catch (error) { throw new Error(`could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`) }
  return parseComposition(source, resolved, nodeId)
}

export interface ServiceSupervisor {
  close(): Promise<void>
}

export function startCompositionServices(services: readonly CompositionService[]): ServiceSupervisor {
  const children = new Set<ChildProcess>()
  const groups = new Set<number>()
  let closing = false
  for (const service of services) {
    const [command, ...args] = service.command
    const child = spawn(command!, args, {
      cwd: service.cwd,
      env: { ...process.env, ...service.env },
      detached: true,
      shell: false,
      stdio: 'inherit',
    })
    children.add(child)
    if (child.pid !== undefined) groups.add(child.pid)
    child.once('error', (error) => {
      if (!closing) process.stderr.write(`[omochi-ui] service ${service.id} failed to start: ${error.message}\n`)
    })
    child.once('close', (code, signal) => {
      children.delete(child)
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 0) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') groups.delete(child.pid) }
      }
      if (!closing) process.stderr.write(`[omochi-ui] service ${service.id} exited${signal ? ` from ${signal}` : ` with code ${code}`}\n`)
    })
  }

  const signal = (name: NodeJS.Signals) => {
    for (const group of groups) {
      try { process.kill(-group, name) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') groups.delete(group)
      }
    }
  }
  return {
    async close() {
      if (closing) return
      closing = true
      signal('SIGTERM')
      await Promise.race([
        Promise.allSettled([...children].map((child) => new Promise<void>((resolve) => child.once('close', () => resolve())))),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ])
      signal('SIGKILL')
    },
  }
}

/** Best-effort desktop opener; the hub remains running when no desktop is available. */
export function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url]
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: 'ignore' })
  child.once('error', (error) => process.stderr.write(`[omochi-ui] could not open a browser: ${error.message}\n`))
  child.unref()
}
