import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

type Schema = Record<string, unknown>
interface Property { name: string; type: string; required: boolean }
interface Component { name: string; properties: Property[] }
interface CatalogModel { id: string; name: string; hash: string; components: Component[] }

export interface GenerateCatalogOptions {
  catalog: string
  name?: string
  typescript?: string
  python?: string
  rust?: string
  check?: boolean
}

const identifier = (value: string): string => value.replace(/[^A-Za-z0-9]+(.)/g, (_, next: string) => next.toUpperCase()).replace(/^[^A-Za-z_]+/, '')
const snake = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()

function referenceType(ref: string, language: 'ts' | 'py' | 'rs'): string {
  const name = ref.split('/').at(-1)!
  const maps = {
    ts: { ComponentId: 'string', ChildList: 'string[] | { componentId: string; path: string }', DataBinding: 'DataBinding', FunctionCall: 'FunctionCall', DynamicValue: 'DynamicValue', DynamicString: 'DynamicString', DynamicNumber: 'DynamicNumber', DynamicBoolean: 'DynamicBoolean', DynamicStringList: 'DynamicStringList', AccessibilityAttributes: 'Accessibility', CheckRule: 'CheckRule', Action: 'WireAction' },
    py: { ComponentId: 'str', ChildList: 'list[str] | dict[str, str]', DataBinding: 'DataBinding', FunctionCall: 'FunctionCall', DynamicValue: 'Any', DynamicString: 'DynamicString', DynamicNumber: 'DynamicNumber', DynamicBoolean: 'DynamicBoolean', DynamicStringList: 'DynamicStringList', AccessibilityAttributes: 'dict[str, DynamicString]', CheckRule: 'dict[str, Any]', Action: 'dict[str, Any]' },
    rs: { ComponentId: 'String', ChildList: 'Value', DataBinding: 'Value', FunctionCall: 'Value', DynamicValue: 'Value', DynamicString: 'Value', DynamicNumber: 'Value', DynamicBoolean: 'Value', DynamicStringList: 'Value', AccessibilityAttributes: 'Value', CheckRule: 'Value', Action: 'Value' },
  } as const
  const value = (maps[language] as Record<string, string>)[name]
  if (!value) throw new Error(`unsupported schema reference: ${ref}`)
  return value
}

function schemaType(schema: Schema, language: 'ts' | 'py' | 'rs'): string {
  if (typeof schema.$ref === 'string') return referenceType(schema.$ref, language)
  if (Array.isArray(schema.allOf)) {
    const values = (schema.allOf as Schema[]).filter((item) => !item.if && !item.then).map((item) => schemaType(item, language))
    if (values.length === 1) return values[0]!
    return language === 'rs' ? 'Value' : values.join(' & ')
  }
  const union = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined
  if (union) {
    const values = union.map((item) => schemaType(item, language))
    return language === 'rs' ? 'Value' : values.join(' | ')
  }
  if (Array.isArray(schema.enum)) {
    if (language === 'ts') return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
    if (language === 'py') return `Literal[${schema.enum.map((value) => JSON.stringify(value)).join(', ')}]`
    return 'String'
  }
  if (schema.type === 'string') return language === 'ts' ? 'string' : language === 'py' ? 'str' : 'String'
  if (schema.type === 'number' || schema.type === 'integer') return language === 'ts' ? 'number' : language === 'py' ? 'float' : 'f64'
  if (schema.type === 'boolean') return language === 'ts' ? 'boolean' : language === 'py' ? 'bool' : 'bool'
  if (schema.type === 'array') {
    const item = schemaType((schema.items as Schema | undefined) ?? {}, language)
    return language === 'ts' ? `${item}[]` : language === 'py' ? `list[${item}]` : `Vec<${item}>`
  }
  if (schema.type === 'object' && schema.properties) {
    const entries = Object.entries(schema.properties as Record<string, Schema>)
    if (language === 'ts') return `{ ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${schemaType(value, language)}`).join('; ')} }`
    return language === 'py' ? 'dict[str, Any]' : 'Value'
  }
  throw new Error(`unsupported schema fragment: ${JSON.stringify(schema)}`)
}

function pointer(document: unknown, fragment: string): unknown {
  if (!fragment || fragment === '#') return document
  if (!fragment.startsWith('#/')) throw new Error(`unsupported JSON Schema fragment: ${fragment}`)
  return fragment.slice(2).split('/').reduce((value: unknown, part) => {
    if (!value || typeof value !== 'object') throw new Error(`unresolved JSON Schema fragment: ${fragment}`)
    return (value as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')]
  }, document)
}

async function resolveLocalRefs(value: unknown, document: unknown, base: string, stack = new Set<string>()): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveLocalRefs(item, document, base, stack)))
  if (!value || typeof value !== 'object') return value
  const object = value as Schema
  if (typeof object.$ref === 'string' && !object.$ref.startsWith('http:') && !object.$ref.startsWith('https:')) {
    const [filename, rawFragment = ''] = object.$ref.split('#', 2)
    const fragment = `#${rawFragment}`
    const referenceKey = `${base}:${object.$ref}`
    if (stack.has(referenceKey)) throw new Error(`circular schema reference: ${object.$ref}`)
    const nextStack = new Set(stack).add(referenceKey)
    if (filename) {
      const path = resolve(base, filename)
      const external = JSON.parse(await readFile(path, 'utf8')) as unknown
      const resolved = pointer(external, fragment)
      return resolveLocalRefs({ ...(resolved as Schema), ...Object.fromEntries(Object.entries(object).filter(([key]) => key !== '$ref')) }, external, dirname(path), nextStack)
    }
    const resolved = pointer(document, fragment)
    return resolveLocalRefs({ ...(resolved as Schema), ...Object.fromEntries(Object.entries(object).filter(([key]) => key !== '$ref')) }, document, base, nextStack)
  }
  return Object.fromEntries(await Promise.all(Object.entries(object).map(async ([key, item]) => [key, await resolveLocalRefs(item, document, base, stack)])))
}

function normalize(raw: string, requestedName?: string, sourceHash?: string): CatalogModel {
  const catalog = JSON.parse(raw) as Schema
  if (!catalog.components || typeof catalog.components !== 'object') throw new Error('catalog must contain a components object')
  const title = requestedName ?? (typeof catalog.title === 'string' ? catalog.title : 'GeneratedCatalog')
  const name = identifier(title)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`catalog name is not a valid identifier: ${title}`)
  const components = Object.entries(catalog.components as Record<string, Schema>).map(([componentName, schema]) => {
    const layers = Array.isArray(schema.allOf) ? schema.allOf as Schema[] : [schema]
    const properties = new Map<string, Schema>()
    const required = new Set<string>()
    for (const layer of layers) {
      if (typeof layer.$ref === 'string') {
        if (layer.$ref.endsWith('/ComponentCommon')) properties.set('accessibility', { $ref: 'https://a2ui.org/specification/v0_9/common_types.json#/$defs/AccessibilityAttributes' })
        else if (layer.$ref.endsWith('/Checkable')) {
          properties.set('checks', { type: 'array', items: { $ref: 'https://a2ui.org/specification/v0_9/common_types.json#/$defs/CheckRule' } })
          properties.set('isValid', { type: 'boolean' })
          properties.set('validationErrors', { type: 'array', items: { type: 'string' } })
        } else if (layer.$ref === '#/$defs/CatalogComponentCommon') properties.set('weight', { type: 'number' })
        else throw new Error(`unsupported component mixin: ${layer.$ref}`)
      }
      for (const [key, value] of Object.entries((layer.properties as Record<string, Schema> | undefined) ?? {})) if (key !== 'component' && key !== 'id') properties.set(key, value)
      for (const key of (layer.required as string[] | undefined) ?? []) if (key !== 'component' && key !== 'id') required.add(key)
    }
    return { name: componentName, properties: [...properties].map(([propertyName, propertySchema]) => ({ name: propertyName, type: JSON.stringify(propertySchema), required: required.has(propertyName) })) }
  })
  return { id: String(catalog.catalogId ?? catalog.$id ?? ''), name, hash: sourceHash ?? createHash('sha256').update(raw).digest('hex'), components }
}

const propertyType = (property: Property, language: 'ts' | 'py' | 'rs') => schemaType(JSON.parse(property.type) as Schema, language)
const header = (model: CatalogModel, comment: string) => `${comment} Generated by omochi-ui from catalog ${model.id}\n${comment} Source SHA-256: ${model.hash}\n`

function typescript(model: CatalogModel): string {
  const body = model.components.map((component) => `export interface ${component.name}Props {\n${component.properties.map((property) => `  ${JSON.stringify(property.name)}${property.required ? '' : '?'}: ${propertyType(property, 'ts')}`).join('\n')}\n}`).join('\n\n')
  const map = model.components.map((component) => `  ${JSON.stringify(component.name)}: ${component.name}Props`).join('\n')
  const knownTypes = ['Accessibility', 'CheckRule', 'DataBinding', 'DynamicBoolean', 'DynamicNumber', 'DynamicString', 'DynamicStringList', 'DynamicValue', 'FunctionCall', 'WireAction']
  const imports = ['CatalogDefinition', ...knownTypes.filter((name) => body.includes(name))]
  return `${header(model, '//')}import type { ${imports.join(', ')} } from '@omochi-ui/sdk'\n\n${body}\n\nexport interface ${model.name}ComponentMap {\n${map}\n}\n\nexport const ${model.name.toUpperCase()}: CatalogDefinition<${model.name}ComponentMap> = { id: ${JSON.stringify(model.id)}, name: ${JSON.stringify(model.name)} }\n`
}

function python(model: CatalogModel): string {
  const body = model.components.map((component) => `class ${component.name}Props(TypedDict, total=False):\n${component.properties.map((property) => `    ${property.name}: ${property.required ? 'Required[' : ''}${propertyType(property, 'py')}${property.required ? ']' : ''}`).join('\n') || '    pass'}`).join('\n\n')
  const overloads = model.components.map((component) => `    @overload\n    def component(self, component: Literal[${JSON.stringify(component.name)}], *, key: str, **props: Unpack[${component.name}Props]) -> None: ...`).join('\n')
  return `${header(model, '#')}from typing import Any, Literal, Required, TypedDict, Unpack, overload\nfrom omochi_ui import Catalog, UI\nfrom omochi_ui.catalog import DataBinding, DynamicBoolean, DynamicNumber, DynamicString, DynamicStringList, FunctionCall\n\n${body}\n\nclass ${model.name}UI(UI):\n${overloads}\n    def component(self, component: str, *, key: str, **props: Any) -> None:\n        super().component(component, key=key, **props)\n\n${model.name.toUpperCase()} = Catalog(id=${JSON.stringify(model.id)}, name=${JSON.stringify(model.name)}, ui_type=${model.name}UI)\n`
}

function rust(model: CatalogModel): string {
  const enumName = (component: Component, property: Property) => `${identifier(component.name)}${identifier(property.name[0]!.toUpperCase() + property.name.slice(1))}`
  const enums = model.components.flatMap((component) => component.properties.flatMap((property) => {
    const values = (JSON.parse(property.type) as Schema).enum
    if (!Array.isArray(values)) return []
    const variants = values.map((value) => {
      const raw = String(value)
      const variant = identifier(raw[0]!.toUpperCase() + raw.slice(1)) || 'Value'
      return `    #[serde(rename = ${JSON.stringify(raw)})]\n    ${/^\d/.test(variant) ? `Value${variant}` : variant},`
    }).join('\n')
    return [`#[derive(Clone, Debug, Serialize)]\npub enum ${enumName(component, property)} {\n${variants}\n}`]
  })).join('\n\n')
  const body = model.components.map((component) => `#[derive(Clone, Debug, Serialize)]\n#[serde(rename_all = "camelCase")]\npub struct ${component.name}Props {\n${component.properties.map((property) => {
    const schema = JSON.parse(property.type) as Schema
    const type = Array.isArray(schema.enum) ? enumName(component, property) : propertyType(property, 'rs')
    return `${property.required ? '' : '    #[serde(skip_serializing_if = "Option::is_none")]\n'}    pub ${snake(property.name)}: ${property.required ? type : `Option<${type}>`},`
  }).join('\n')}\n}\nimpl ComponentProps for ${component.name}Props {\n    const NAME: &'static str = ${JSON.stringify(component.name)};\n    fn into_props(self) -> JsonObject { serde_json::to_value(self).unwrap().as_object().unwrap().clone() }\n}`).join('\n\n')
  return `${header(model, '//')}use omochi_ui::{ComponentProps, JsonObject};\nuse serde::Serialize;\nuse serde_json::Value;\n\npub const CATALOG_ID: &str = ${JSON.stringify(model.id)};\n\n${enums}${enums ? '\n\n' : ''}${body}\n`
}

async function output(path: string, content: string, check: boolean): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (check) { if (current !== content) throw new Error(`generated catalog is stale: ${path}`); return }
  if (current !== content) await writeFile(path, content)
}

export async function generateCatalog(options: GenerateCatalogOptions): Promise<void> {
  if (!options.typescript && !options.python && !options.rust) throw new Error('at least one output flag is required')
  const raw = await readFile(options.catalog, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const resolved = await resolveLocalRefs(parsed, parsed, dirname(resolve(options.catalog)))
  const model = normalize(JSON.stringify(resolved), options.name, createHash('sha256').update(raw).digest('hex'))
  await Promise.all([
    options.typescript ? output(options.typescript, typescript(model), Boolean(options.check)) : undefined,
    options.python ? output(options.python, python(model), Boolean(options.check)) : undefined,
    options.rust ? output(options.rust, rust(model), Boolean(options.check)) : undefined,
  ])
}
