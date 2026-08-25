// Disk cache with in-flight de-duplication.
//
// Two problems being solved:
//
//   1. Recomputing a forecast score that is immutable for six hours is waste.
//   2. Fifty clients asking for the same slow thing at once should produce one
//      upstream call, not fifty. The old system had a 190 MB response getting
//      stampeded and that is the failure this prevents.
//
// Writes are atomic, temp file then rename, so a crash mid-write never leaves a
// torn entry that later reads as valid JSON right up until it does not.

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { config } from '../config.js'
import { logger } from './logger.js'

const inflight = new Map()

const keyFor = (prefix, params) => {
  const sorted = Object.keys(params ?? {}).sort().reduce((acc, k) => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') acc[k] = params[k]
    return acc
  }, {})
  const hash = createHash('sha1').update(JSON.stringify(sorted)).digest('hex').slice(0, 20)
  return `${prefix}_${hash}`
}

const pathFor = (key) => path.join(config.cache.dir, `${key}.json`)

async function readEntry (key, ttlSeconds) {
  try {
    const raw = await fs.readFile(pathFor(key), 'utf8')
    const entry = JSON.parse(raw)
    const ageSeconds = (Date.now() - entry.storedAt) / 1000
    if (ageSeconds > ttlSeconds) return null
    return entry.value
  } catch {
    return null
  }
}

async function writeEntry (key, value) {
  const target = pathFor(key)
  const temp = `${target}.${process.pid}.tmp`
  await fs.mkdir(config.cache.dir, { recursive: true })
  await fs.writeFile(temp, JSON.stringify({ storedAt: Date.now(), value }), 'utf8')
  await fs.rename(temp, target)
}

/**
 * Fetch through the cache.
 *
 * Key on something that changes when the content changes. A forecast result
 * keys on creation_time and lead, which makes it immutable, so it can be
 * cached hard and expires on its own when a new cycle arrives.
 */
export async function wrap (prefix, params, producer, { ttlSeconds = config.cache.ttlSeconds } = {}) {
  const key = keyFor(prefix, params)

  const hit = await readEntry(key, ttlSeconds)
  if (hit !== null) {
    logger.debug({ key }, 'cache hit')
    return hit
  }

  // Someone is already producing this exact value, wait for theirs.
  if (inflight.has(key)) {
    logger.debug({ key }, 'joining in-flight request')
    return inflight.get(key)
  }

  const promise = (async () => {
    try {
      const value = await producer()
      await writeEntry(key, value)
      return value
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}

/**
 * The last successfully cached value for a key, regardless of how stale.
 *
 * `wrap` treats an entry past its TTL as absent so it refetches. But when that
 * refetch fails because the upstream is down, a stale entry is far better than a
 * blank surface, so this reads it anyway and reports its age. `maxStaleSeconds`
 * caps how old a fallback may be; older than that returns null and the caller
 * shows its not-available state. Returns { value, ageSeconds } or null.
 */
export async function lastGood (prefix, params, maxStaleSeconds = Infinity) {
  try {
    const raw = await fs.readFile(pathFor(keyFor(prefix, params)), 'utf8')
    const entry = JSON.parse(raw)
    const ageSeconds = (Date.now() - entry.storedAt) / 1000
    if (ageSeconds > maxStaleSeconds) return null
    return { value: entry.value, ageSeconds, storedAt: entry.storedAt }
  } catch {
    return null
  }
}

const bytesPathFor = (prefix, params) => path.join(config.cache.dir, `${keyFor(prefix, params)}.bin`)

/**
 * Cache raw bytes (a radar frame image) so a short loop still plays during a
 * total source outage. Written atomically like the JSON entries.
 */
export async function putBytes (prefix, params, buffer) {
  const target = bytesPathFor(prefix, params)
  const temp = `${target}.${process.pid}.tmp`
  await fs.mkdir(config.cache.dir, { recursive: true })
  await fs.writeFile(temp, buffer)
  await fs.rename(temp, target)
}

/** The cached bytes for a key, or null if none. Ignores age; the listing route
 * is what decides a product has gone stale, an individual frame is best effort. */
export async function getBytes (prefix, params) {
  try {
    return await fs.readFile(bytesPathFor(prefix, params))
  } catch {
    return null
  }
}

export async function invalidate (prefix) {
  try {
    const files = await fs.readdir(config.cache.dir)
    const matching = files.filter((f) => f.startsWith(`${prefix}_`))
    await Promise.all(matching.map((f) => fs.unlink(path.join(config.cache.dir, f))))
    return matching.length
  } catch {
    return 0
  }
}

export async function status () {
  try {
    const files = await fs.readdir(config.cache.dir)
    const byPrefix = {}
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const prefix = file.split('_')[0]
      byPrefix[prefix] = (byPrefix[prefix] || 0) + 1
    }
    return { total: files.length, byPrefix, inflight: inflight.size }
  } catch {
    return { total: 0, byPrefix: {}, inflight: inflight.size }
  }
}

/**
 * Sweep entries older than the configured window.
 *
 * Boundary tiles are excluded because they change once a year at most and
 * re-fetching them is expensive.
 */
export async function prune () {
  const cutoff = Date.now() - config.cache.pruneDays * 24 * 60 * 60 * 1000
  const keep = ['boundaries', 'layers']
  let removed = 0

  try {
    const files = await fs.readdir(config.cache.dir)
    for (const file of files) {
      if (keep.some((k) => file.startsWith(`${k}_`))) continue
      const full = path.join(config.cache.dir, file)
      const stat = await fs.stat(full)
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(full)
        removed += 1
      }
    }
  } catch (err) {
    logger.warn({ err }, 'cache prune failed')
  }

  if (removed) logger.info({ removed }, 'cache pruned')
  return removed
}

export function startPruneTimer () {
  const timer = setInterval(() => { prune() }, config.cache.pruneIntervalMs)
  timer.unref()
  return timer
}

export const cache = { wrap, lastGood, putBytes, getBytes, invalidate, status, prune, startPruneTimer }
