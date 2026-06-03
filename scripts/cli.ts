#!/usr/bin/env bun
import process from 'node:process'

// Base URL and API key come from the environment.
const BASE_URL = process.env.JACK_URL ?? 'http://localhost:5225'
const API_KEY = process.env.JACK_API_KEY ?? ''

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

// httpie-style request items, matched in priority order:
//   key==value  -> query param
//   key:=value  -> JSON body field (raw: numbers, booleans, objects, ...)
//   key=value   -> JSON body field (string)
//   Header:value-> request header
const QUERY_RE = /^([^=:]+)==(.*)$/
const RAW_BODY_RE = /^([^=:]+):=(.*)$/
const BODY_RE = /^([^=:]+)=(.*)$/
const HEADER_RE = /^([^:]+):(.*)$/
const ABSOLUTE_URL_RE = /^https?:\/\//

// Minimal ANSI JSON highlighter — strings, keys, numbers, booleans, null.
const JSON_TOKEN_RE = /"(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
const COLOR = { key: '\x1B[34m', string: '\x1B[32m', number: '\x1B[36m', boolean: '\x1B[33m', null: '\x1B[90m', reset: '\x1B[0m' }

function colorizeJson(json: string): string {
  return json.replace(JSON_TOKEN_RE, (token) => {
    let color = COLOR.number
    if (token.startsWith('"'))
      color = token.endsWith(':') ? COLOR.key : COLOR.string
    else if (token === 'true' || token === 'false')
      color = COLOR.boolean
    else if (token === 'null')
      color = COLOR.null
    return `${color}${token}${COLOR.reset}`
  })
}

interface ParsedItems {
  query: Record<string, string>
  headers: Record<string, string>
  body: Record<string, unknown>
}

function parseItems(items: string[]): ParsedItems {
  const query: Record<string, string> = {}
  const headers: Record<string, string> = {}
  const body: Record<string, unknown> = {}

  for (const item of items) {
    const q = QUERY_RE.exec(item)
    if (q) {
      query[q[1] ?? ''] = q[2] ?? ''
      continue
    }
    const raw = RAW_BODY_RE.exec(item)
    if (raw) {
      body[raw[1] ?? ''] = JSON.parse(raw[2] ?? 'null')
      continue
    }
    const b = BODY_RE.exec(item)
    if (b) {
      body[b[1] ?? ''] = b[2] ?? ''
      continue
    }
    const h = HEADER_RE.exec(item)
    if (h) {
      headers[h[1] ?? ''] = h[2] ?? ''
      continue
    }
    throw new Error(`Cannot parse request item: "${item}" (use key==query, key=body, key:=rawjson, or Header:value)`)
  }

  return { query, headers, body }
}

function buildUrl(path: string, query: Record<string, string>): URL {
  const url = ABSOLUTE_URL_RE.test(path) ? new URL(path) : new URL(path, BASE_URL)
  for (const [key, value] of Object.entries(query))
    url.searchParams.append(key, value)
  return url
}

async function request(method: string, url: URL, headers: Record<string, string>, body?: string) {
  const finalHeaders: Record<string, string> = {
    ...(API_KEY ? { 'X-Api-Key': API_KEY } : {}),
    ...(body != null ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  }

  process.stderr.write(`> ${method} ${url}\n`)
  const res = await fetch(url, { method, headers: finalHeaders, body })
  process.stderr.write(`< ${res.status} ${res.statusText}\n`)

  const text = await res.text()
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2)
      // Colorize only for a terminal, so piped output stays valid JSON.
      process.stdout.write(`${process.stdout.isTTY ? colorizeJson(pretty) : pretty}\n`)
      if (!res.ok)
        process.exitCode = 1
      return
    }
    catch {}
  }
  if (text)
    process.stdout.write(`${text}\n`)
  if (!res.ok)
    process.exitCode = 1
}

// cli api [METHOD] <path> [request items...]
async function cmdApi(args: string[]) {
  const rest = [...args]

  let method: string | undefined
  const first = rest[0]
  if (first && HTTP_METHODS.has(first.toUpperCase())) {
    method = first.toUpperCase()
    rest.shift()
  }

  const path = rest.shift()
  if (!path) {
    process.stderr.write('usage: cli api [METHOD] <path> [key==query] [key=body] [key:=rawjson] [Header:value]\n')
    process.exit(2)
  }

  const { query, headers, body } = parseItems(rest)
  const hasBody = Object.keys(body).length > 0
  method ??= hasBody ? 'POST' : 'GET'
  await request(method, buildUrl(path, query), headers, hasBody ? JSON.stringify(body) : undefined)
}

const PEER_SEARCH_FLAGS = ['imdbId', 'tmdbId', 'tvdbId', 'season', 'episode']

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg == null || !arg.startsWith('--'))
      continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
    }
    else {
      out[arg.slice(2)] = args[i + 1] ?? ''
      i++
    }
  }
  return out
}

// cli peer search [--imdbId <id>] [--tmdbId <id>] [--tvdbId <id>] [--season <n>] [--episode <n>]
async function cmdPeerSearch(args: string[]) {
  const flags = parseFlags(args)
  const query: Record<string, string> = {}
  for (const key of PEER_SEARCH_FLAGS) {
    const value = flags[key]
    if (value != null)
      query[key] = value
  }
  await request('GET', buildUrl('/peer/search', query), {})
}

// cli torznab search [--imdbId <id>] [--tmdbId <id>] [--tvdbId <id>] [--season <n>] [--episode <n>]
// Hits /torznab/api the way Radarr/Sonarr do: apikey in the query, returns XML.
async function cmdTorznabSearch(args: string[]) {
  const flags = parseFlags(args)
  const query: Record<string, string> = {}
  if (API_KEY)
    query.apikey = API_KEY

  if (flags.tmdbId != null) {
    query.t = 'movie'
    query.tmdbid = flags.tmdbId
  }
  else if (flags.imdbId != null) {
    query.t = 'movie'
    query.imdbid = flags.imdbId
  }
  else if (flags.tvdbId != null) {
    query.t = 'tvsearch'
    query.tvdbid = flags.tvdbId
  }
  else {
    // No id: t=search. A term returns empty (not fanned out); no term = catalog.
    query.t = 'search'
  }

  if (flags.q != null)
    query.q = flags.q
  if (flags.season != null)
    query.season = flags.season
  if (flags.episode != null)
    query.ep = flags.episode

  await request('GET', buildUrl('/torznab/api', query), {})
}

const USAGE = `jack cli — talk to a running jack

usage:
  cli api [METHOD] <path> [items...]   httpie-style request (key==query, key=body, key:=rawjson, Header:value)
  cli peer search [--imdbId <id>] [--tmdbId <id>] [--tvdbId <id>] [--season <n>] [--episode <n>]
  cli torznab search [--imdbId <id>] [--tmdbId <id>] [--tvdbId <id>] [--season <n>] [--episode <n>]   (returns XML)

env:
  JACK_URL       base URL (default ${BASE_URL})
  JACK_API_KEY   sent as the X-Api-Key header
`

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  switch (command) {
    case 'api':
      await cmdApi(rest)
      break
    case 'peer':
      if (rest[0] === 'search') {
        await cmdPeerSearch(rest.slice(1))
      }
      else {
        process.stderr.write('usage: cli peer search [--imdbId <id>] [--tmdbId <id>] [--tvdbId <id>] [--season <n>] [--episode <n>]\n')
        process.exit(2)
      }
      break
    case 'torznab':
      if (rest[0] === 'search') {
        await cmdTorznabSearch(rest.slice(1))
      }
      else {
        process.stderr.write('usage: cli torznab search [--imdbId <id>] [--tmdbId <id>] [--tvdbId <id>] [--season <n>] [--episode <n>]\n')
        process.exit(2)
      }
      break
    default:
      process.stdout.write(USAGE)
      process.exit(command ? 2 : 0)
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
