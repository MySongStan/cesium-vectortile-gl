/** @param {{ z: number, x: number, y: number }} tile */
export function rttCacheKey(
  tile,
  geometrySource = 'maplibre8192',
  bufferExtent = 64,
  uvCorrection = false
) {
  const gs =
    geometrySource === 'pbfRaw' ? 'pbfRaw' : 'maplibre8192'
  const be = Math.max(0, Number(bufferExtent) | 0)
  const uv = uvCorrection ? 1 : 0
  return `${tile.z}/${tile.x}/${tile.y}#${gs}#b${be}#u${uv}`
}

export class TileRttCache {
  constructor(options = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 256)
    this.maxBytes = Math.max(1, options.maxBytes ?? 512 * 1024 * 1024)
    this._items = new Map()
  }

  get size() {
    return this._items.size
  }

  get totalBytes() {
    let bytes = 0
    for (const entry of this._items.values()) {
      bytes += entry.bytes ?? 0
    }
    return bytes
  }

  get(
    tile,
    geometrySource = 'maplibre8192',
    bufferExtent = 64,
    uvCorrection = false
  ) {
    const key = rttCacheKey(tile, geometrySource, bufferExtent, uvCorrection)
    const entry = this._items.get(key)
    if (!entry) return null
    entry.lastUsedFrame = tile.lastVisitTime ?? 0
    return entry.renderer
  }

  set(
    tile,
    renderer,
    bytes = 0,
    geometrySource = 'maplibre8192',
    bufferExtent = 64,
    uvCorrection = false
  ) {
    const key = rttCacheKey(tile, geometrySource, bufferExtent, uvCorrection)
    this._items.set(key, {
      key,
      renderer,
      bytes,
      lastUsedFrame: tile.lastVisitTime ?? 0
    })
  }

  delete(
    tile,
    geometrySource = 'maplibre8192',
    bufferExtent = 64,
    uvCorrection = false
  ) {
    const key = rttCacheKey(tile, geometrySource, bufferExtent, uvCorrection)
    this._items.delete(key)
  }

  updateBytes(
    tile,
    bytes,
    geometrySource = 'maplibre8192',
    bufferExtent = 64,
    uvCorrection = false
  ) {
    const key = rttCacheKey(tile, geometrySource, bufferExtent, uvCorrection)
    const entry = this._items.get(key)
    if (entry) {
      entry.bytes = bytes
    }
  }

  prune(onEvict) {
    let needPrune =
      this._items.size > this.maxEntries || this.totalBytes > this.maxBytes
    if (!needPrune) return

    const ordered = Array.from(this._items.values()).sort(
      (a, b) => a.lastUsedFrame - b.lastUsedFrame
    )
    for (const entry of ordered) {
      if (
        this._items.size <= this.maxEntries &&
        this.totalBytes <= this.maxBytes
      ) {
        break
      }
      this._items.delete(entry.key)
      if (onEvict) {
        onEvict(entry.renderer)
      }
    }
  }

  destroy() {
    for (const entry of this._items.values()) {
      entry.renderer?.destroy?.()
    }
    this._items.clear()
  }
}
