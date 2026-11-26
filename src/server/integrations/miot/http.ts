export interface MiotCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  secure?: boolean
}

const defaultPath = (pathname: string): string => {
  const idx = pathname.lastIndexOf('/')
  return idx <= 0 ? '/' : pathname.slice(0, idx)
}

const domainMatch = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`)

export const parseSetCookie = (headers: string[], requestUrl: string): MiotCookie[] => {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return []
  }
  const cookies: MiotCookie[] = []
  for (const header of headers) {
    const parts = header.split(';')
    const first = parts.shift() ?? ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const cookie: MiotCookie = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
      domain: url.hostname.toLowerCase(),
      path: defaultPath(url.pathname),
    }
    for (const raw of parts) {
      const attr = raw.trim()
      const attrEq = attr.indexOf('=')
      const key = (attrEq < 0 ? attr : attr.slice(0, attrEq)).trim().toLowerCase()
      const value = attrEq < 0 ? '' : attr.slice(attrEq + 1).trim()
      if (key === 'domain' && value) cookie.domain = value.replace(/^\./, '').toLowerCase()
      else if (key === 'path' && value) cookie.path = value.startsWith('/') ? value : `/${value}`
      else if (key === 'expires') {
        const time = Date.parse(value)
        if (Number.isFinite(time)) cookie.expires = time
      } else if (key === 'max-age') {
        const seconds = Number(value)
        if (Number.isFinite(seconds)) cookie.expires = Date.now() + seconds * 1000
      } else if (key === 'secure') cookie.secure = true
    }
    if (!cookie.name) continue
    cookies.push(cookie)
  }
  return cookies
}

export class CookieJar {
  private cookies: MiotCookie[] = []

  add(cookies: MiotCookie[]): void {
    for (const cookie of cookies) {
      if (cookie.expires !== undefined && cookie.expires <= Date.now()) continue
      const index = this.cookies.findIndex(item =>
        item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path)
      if (index >= 0) this.cookies[index] = cookie
      else this.cookies.push(cookie)
    }
  }

  getValue(name: string, url?: string): string {
    const list = url ? this.match(url) : this.cookies.filter(item => item.name === name)
    for (let i = list.length - 1; i >= 0; i--) {
      const cookie = list[i]
      if (cookie.name === name && (cookie.expires === undefined || cookie.expires > Date.now())) return cookie.value
    }
    return ''
  }

  getNames(): string[] {
    return [...new Set(this.cookies.map(item => item.name))]
  }

  getCookieHeader(url: string): string {
    return this.match(url)
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }

  clear(): void {
    this.cookies = []
  }

  private match(url: string): MiotCookie[] {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return []
    }
    const now = Date.now()
    const hostname = parsed.hostname.toLowerCase()
    const secure = parsed.protocol === 'https:'
    return this.cookies.filter(cookie =>
      (!cookie.expires || cookie.expires > now) &&
      domainMatch(hostname, cookie.domain) &&
      parsed.pathname.startsWith(cookie.path) &&
      (!cookie.secure || secure))
  }
}

const splitSetCookieHeader = (raw: string): string[] => {
  const result: string[] = []
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== ',') continue
    const rest = raw.slice(i + 1, i + 20).trim().toLowerCase()
    if (/^(expires|max-age|path|domain|samesite|secure|httponly)\b/.test(rest) || rest.startsWith('expires=')) continue
    const next = raw.slice(start, i).trim()
    if (next) result.push(next)
    start = i + 1
  }
  const tail = raw.slice(start).trim()
  if (tail) result.push(tail)
  return result
}

export const getSetCookie = (headers: Headers): string[] => {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] }
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie()
  const raw = headers.get('set-cookie')
  return raw ? splitSetCookieHeader(raw) : []
}

export interface MiotFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface MiotFetchResult {
  status: number
  ok: boolean
  headers: Headers
  text: string
  setCookies: string[]
  finalUrl: string
  redirectCount: number
}

export const fetchWithRedirects = async (
  url: string,
  options: MiotFetchOptions,
  cookieJar?: CookieJar,
  maxRedirects = 0,
): Promise<MiotFetchResult> => {
  let currentUrl = url
  let method = (options.method ?? 'GET').toUpperCase()
  let body = options.body

  for (let redirectCount = 0; ; redirectCount++) {
    const headers = new Headers(options.headers)
    if (cookieJar) {
      const cookieHeader = cookieJar.getCookieHeader(currentUrl)
      if (cookieHeader) {
        const existing = headers.get('cookie')
        headers.set('cookie', existing ? `${existing}; ${cookieHeader}` : cookieHeader)
      }
    }
    const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30000)
    const response = await fetch(currentUrl, { method, headers, body, redirect: 'manual', signal })
    const setCookies = getSetCookie(response.headers)
    if (cookieJar && setCookies.length > 0) cookieJar.add(parseSetCookie(setCookies, currentUrl))

    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location && redirectCount < maxRedirects) {
      await response.body?.cancel().catch(() => {})
      currentUrl = new URL(location, currentUrl).toString()
      method = 'GET'
      body = undefined
      continue
    }

    const text = await response.text()
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text,
      setCookies,
      finalUrl: currentUrl,
      redirectCount,
    }
  }
}

export interface MiotBinaryResult {
  status: number
  contentType: string
  data: Buffer
  setCookies: string[]
  finalUrl: string
}

export const fetchBinary = async (url: string, headers: Record<string, string>, cookieJar?: CookieJar): Promise<MiotBinaryResult> => {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  })
  const data = Buffer.from(await response.arrayBuffer())
  const setCookies = getSetCookie(response.headers)
  if (cookieJar && setCookies.length > 0) cookieJar.add(parseSetCookie(setCookies, response.url || url))
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    data,
    setCookies,
    finalUrl: response.url || url,
  }
}
