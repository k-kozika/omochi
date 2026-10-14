// The development host chooses the endpoint; the renderer receives an explicit URL.
export function resolveWebSocketUrl(location: Pick<Location, 'host' | 'protocol' | 'search'>): string {
  const configured = new URLSearchParams(location.search).get('ws')
  const url = configured ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('the ws query parameter must use ws: or wss:')
  }
  return parsed.toString()
}
