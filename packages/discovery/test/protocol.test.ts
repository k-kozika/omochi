import assert from 'node:assert/strict'
import { test } from '@omochi-ui/core/testing'
import { gatewayRequestOptions, gatewayWsUrl } from '../src/gateway/protocol.js'

test('WebSocket URLs bracket IPv6 while request options keep the bare host', () => {
  for (const [host, authority] of [
    ['::1', '[::1]'],
    ['2001:db8:1234:5678:90ab:cdef:1234:5678', '[2001:db8:1234:5678:90ab:cdef:1234:5678]'],
    ['127.0.0.1', '127.0.0.1'],
    ['gateway.example', 'gateway.example'],
  ]) {
    const endpoint = { kind: 'tcp' as const, host: host!, port: 8443 }
    for (const route of ['/v1/control', '/v1/a2ui']) {
      const url = gatewayWsUrl(endpoint, route)
      assert.equal(url, `wss://${authority}:8443${route}`)
      assert.equal(new URL(url).pathname, route)
      assert.deepEqual(gatewayRequestOptions(endpoint, route), { host, port: 8443, path: route, method: 'GET' })
    }
  }
  const unix = { kind: 'unix' as const, socketPath: '/tmp/gateway.sock' }
  assert.equal(gatewayWsUrl(unix, '/v1/a2ui'), 'ws+unix:/tmp/gateway.sock:/v1/a2ui')
  assert.deepEqual(gatewayRequestOptions(unix, '/v1/a2ui'), { socketPath: unix.socketPath, path: '/v1/a2ui', method: 'GET' })
})
