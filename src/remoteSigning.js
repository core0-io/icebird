/**
 * @import {Resolver} from '../src/types.js'
 */

/**
 * Build a read-only `Resolver` for tables whose catalog signs storage requests
 * (Iceberg REST remote signing, e.g. Lakekeeper warehouses without STS).
 * Each request is sent to the signer named in the load-table `config`, then
 * the signed request is made against the storage endpoint.
 *
 * @param {object} options
 * @param {Record<string, string>} options.config - `config` from `restCatalogLoadTable`
 * @param {RequestInit} [options.requestInit] - auth for the signer (e.g. Authorization header)
 * @returns {Resolver}
 */
export function remoteSigningResolver({ config, requestInit }) {
  if (!config['s3.signer.uri'] || !config['s3.signer.endpoint']) {
    throw new Error('config has no s3.signer.uri and s3.signer.endpoint')
  }
  const signerUrl = new URL(config['s3.signer.endpoint'], config['s3.signer.uri'].replace(/\/?$/, '/')).href
  const endpoint = config['s3.endpoint']?.replace(/\/$/, '')
  const region = config['s3.region']
  const pathStyle = config['s3.path-style-access'] !== 'false'

  /**
   * @param {string} path
   * @returns {string}
   */
  function toHttps(path) {
    if (!/^s3a?:\/\//.test(path)) return path
    const rest = path.slice(path.indexOf('://') + 3)
    const slash = rest.indexOf('/')
    if (slash === -1) throw new Error(`invalid S3 URL: ${path}`)
    const bucket = rest.slice(0, slash)
    const key = rest.slice(slash + 1)
    if (!endpoint) return `https://${bucket}.s3.${region ?? 'us-east-1'}.amazonaws.com/${key}`
    if (pathStyle) return `${endpoint}/${bucket}/${key}`
    const { protocol, host } = new URL(endpoint)
    return `${protocol}//${bucket}.${host}/${key}`
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {Record<string, string>} [extra]
   * @returns {Promise<Response>}
   */
  async function signedFetch(method, path, extra = {}) {
    const headers = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, [v]]))
    const signRes = await fetch(signerUrl, {
      ...requestInit,
      method: 'POST',
      headers: { ...Object.fromEntries(new Headers(requestInit?.headers)), 'content-type': 'application/json' },
      body: JSON.stringify({ region, method, uri: toHttps(path), headers }),
    })
    if (!signRes.ok) throw new Error(`sign ${method} ${path}: ${signRes.status} ${await signRes.text()}`)
    const signed = await signRes.json()
    const signedHeaders = Object.fromEntries(Object.entries(signed.headers ?? {})
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]))
    return fetch(signed.uri, { method, headers: { ...extra, ...signedHeaders } })
  }

  return {
    async reader(path, byteLength) {
      let length = byteLength
      if (length === undefined) {
        const res = await signedFetch('HEAD', path)
        if (!res.ok) throw new Error(`HEAD ${path}: ${res.status} ${res.statusText}`)
        length = Number(res.headers.get('content-length'))
        if (!Number.isFinite(length)) throw new Error(`HEAD ${path}: missing Content-Length`)
      }
      const fileLength = length
      return {
        byteLength: fileLength,
        async slice(start, end) {
          const range = `bytes=${start}-${(end ?? fileLength) - 1}`
          const res = await signedFetch('GET', path, { range })
          if (!res.ok) throw new Error(`GET ${path} ${range}: ${res.status} ${res.statusText}`)
          return res.arrayBuffer()
        },
      }
    },
  }
}
