import { afterEach, describe, expect, it, vi } from 'vitest'
import { remoteSigningResolver } from '../src/remoteSigning.js'

const config = {
  's3.signer.uri': 'https://catalog.example.com/api/iceberg/catalog',
  's3.signer.endpoint': 'v1/signer/wh/tabular-id/t/v1/aws/s3/sign',
  's3.endpoint': 'https://s3.example.com/',
  's3.region': 'jp-north-1',
}

describe('remoteSigningResolver', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('requires signer config', () => {
    expect(() => remoteSigningResolver({ config: {} })).toThrow('s3.signer')
  })

  it('has the catalog sign each request, then sends the signed request to storage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/sign')) {
        return Promise.resolve(new Response(JSON.stringify({ uri: 'https://s3.example.com/b/k?sig=1', headers: { authorization: ['signed'] } })))
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }))
    })
    const resolver = remoteSigningResolver({ config, requestInit: { headers: { Authorization: 'Bearer t' } } })
    const file = await resolver.reader('s3://b/k')
    expect(file.byteLength).toBe(3)
    await file.slice(0, 3)

    const [signUrl, signInit] = fetchMock.mock.calls[0]
    expect(signUrl).toBe('https://catalog.example.com/api/iceberg/catalog/v1/signer/wh/tabular-id/t/v1/aws/s3/sign')
    expect(signInit?.headers).toMatchObject({ authorization: 'Bearer t' })
    expect(JSON.parse(String(signInit?.body))).toEqual({ region: 'jp-north-1', method: 'HEAD', uri: 'https://s3.example.com/b/k', headers: {} })

    const [, getInit] = fetchMock.mock.calls[3]
    expect(getInit).toMatchObject({ method: 'GET', headers: { range: 'bytes=0-2', authorization: 'signed' } })
  })
})
