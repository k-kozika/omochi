import {
  A2uiMessageSchema,
  type A2uiMessage,
  type CreateSurfaceMessage,
} from '@a2ui/web_core/v0_9'

interface SurfaceSnapshot {
  create: CreateSurfaceMessage
  components: Map<string, Record<string, unknown>>
  data: unknown
  hasData: boolean
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function pointerParts(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`data model path must start with "/": ${JSON.stringify(path)}`)
  return path.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function isArrayIndex(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value)
}

function setOwn(target: object, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function updateAtPointer(root: unknown, path: string, present: boolean, value: unknown): unknown {
  if (path === '' || path === '/') return present ? clone(value) : undefined

  const parts = pointerParts(path)
  let result: unknown = clone(root)
  if (result === null || typeof result !== 'object') result = isArrayIndex(parts[0]!) ? [] : {}
  let current = result as Record<string, unknown> | unknown[]

  for (const [index, part] of parts.slice(0, -1).entries()) {
    const nextPart = parts[index + 1]!
    let child: unknown
    if (Array.isArray(current)) {
      if (!isArrayIndex(part)) throw new Error(`array data model path segment must be an index: ${JSON.stringify(part)}`)
      child = Object.hasOwn(current, part) ? current[Number(part)] : undefined
      if (child === null || typeof child !== 'object') {
        child = isArrayIndex(nextPart) ? [] : {}
        setOwn(current, part, child)
      }
    } else {
      child = Object.hasOwn(current, part) ? current[part] : undefined
      if (child === null || typeof child !== 'object') {
        child = isArrayIndex(nextPart) ? [] : {}
        setOwn(current, part, child)
      }
    }
    current = child as Record<string, unknown> | unknown[]
  }

  const last = parts.at(-1)!
  if (Array.isArray(current)) {
    if (!isArrayIndex(last)) throw new Error(`array data model path segment must be an index: ${JSON.stringify(last)}`)
    const position = Number(last)
    if (present) setOwn(current, position, clone(value))
    else if (position < current.length) {
      // Shift only own indices: splice() would copy inherited entries into the model.
      for (let index = position; index < current.length - 1; index++) {
        if (Object.hasOwn(current, index + 1)) setOwn(current, index, current[index + 1])
        else delete current[index]
      }
      delete current[current.length - 1]
      current.length -= 1
    }
  } else if (present) {
    setOwn(current, last, clone(value))
  } else {
    delete current[last]
  }
  return result
}

/** Materializes one shared A2UI stream so a new renderer can join without replaying its history. */
export class A2uiSnapshot {
  private readonly surfaces = new Map<string, SurfaceSnapshot>()

  apply(value: unknown): A2uiMessage {
    const parsed = A2uiMessageSchema.safeParse(value)
    if (!parsed.success || parsed.data.version !== 'v0.9') {
      const detail = parsed.success ? `unsupported version: ${parsed.data.version}` : parsed.error.issues[0]?.message
      throw new Error(detail ?? 'invalid A2UI v0.9 message')
    }
    const message = parsed.data

    if ('createSurface' in message) {
      const surfaceId = message.createSurface.surfaceId
      if (this.surfaces.has(surfaceId)) throw new Error(`surface already exists: ${JSON.stringify(surfaceId)}`)
      this.surfaces.set(surfaceId, {
        create: clone(message),
        components: new Map(),
        data: undefined,
        hasData: false,
      })
    } else if ('updateComponents' in message) {
      const { surfaceId, components } = message.updateComponents
      const surface = this.surface(surfaceId)
      for (const component of components) {
        if (typeof component.id !== 'string') throw new Error('component must contain a string id')
        surface.components.set(component.id, clone(component))
      }
    } else if ('updateDataModel' in message) {
      const update = message.updateDataModel
      const surface = this.surface(update.surfaceId)
      surface.data = updateAtPointer(surface.data, update.path ?? '/', 'value' in update, update.value)
      surface.hasData = true
    } else {
      this.surfaces.delete(message.deleteSurface.surfaceId)
    }

    return message
  }

  messages(): A2uiMessage[] {
    const messages: A2uiMessage[] = []
    for (const [surfaceId, surface] of this.surfaces) {
      messages.push(clone(surface.create))
      if (surface.components.size) {
        messages.push({
          version: 'v0.9',
          updateComponents: {
            surfaceId,
            components: [...surface.components.values()].map(clone),
          },
        })
      }
      if (surface.hasData) {
        const update: { surfaceId: string; path: string; value?: unknown } = { surfaceId, path: '/' }
        if (surface.data !== undefined) update.value = clone(surface.data)
        messages.push({ version: 'v0.9', updateDataModel: update })
      }
    }
    return messages
  }

  private surface(surfaceId: string): SurfaceSnapshot {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) throw new Error(`unknown surface: ${JSON.stringify(surfaceId)}`)
    return surface
  }
}
