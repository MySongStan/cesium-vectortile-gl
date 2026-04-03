/**
 * 沿线 symbol 锚点：Web Mercator 米制弧长采样 + 大地线方位角（bearing，弧度，顺时针从北）。
 * 无 Cesium 依赖，可供主线程与 Worker 共用。
 */

const WGS84_A = 6378137

/**
 * @param {number} lonDeg
 * @param {number} latDeg
 * @returns {{ x: number, y: number }}
 */
export function lonLatToMercatorMeters(lonDeg, latDeg) {
  const lon = (lonDeg * Math.PI) / 180
  const lat = (latDeg * Math.PI) / 180
  return {
    x: WGS84_A * lon,
    y: WGS84_A * Math.log(Math.tan(Math.PI / 4 + lat / 2))
  }
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {{ lon: number, lat: number }}
 */
export function mercatorMetersToLonLat(x, y) {
  const lon = (x / WGS84_A) * (180 / Math.PI)
  const lat =
    (2 * Math.atan(Math.exp(y / WGS84_A)) - Math.PI / 2) * (180 / Math.PI)
  return { lon, lat }
}

/**
 * 方位角（弧度），顺时针从北：forward along (lon1,lat1) -> (lon2,lat2)
 */
export function bearingRadians(lon1, lat1, lon2, lat2) {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return Math.atan2(y, x)
}

function segmentLengthMercator(a, b) {
  const dx = b.mx - a.mx
  const dy = b.my - a.my
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * @param {Array<[number, number]>} ringLonLat
 * @returns {{ points: Array<{ lon: number, lat: number, mx: number, my: number }>, cum: Float64Array, total: number }}
 */
function buildPolylineMercator(ringLonLat) {
  const n = ringLonLat.length
  if (n < 2) {
    return { points: [], cum: new Float64Array(0), total: 0 }
  }
  const points = []
  for (let i = 0; i < n; i++) {
    const [lon, lat] = ringLonLat[i]
    const { x: mx, y: my } = lonLatToMercatorMeters(lon, lat)
    points.push({ lon, lat, mx, my })
  }
  const cum = new Float64Array(n)
  cum[0] = 0
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + segmentLengthMercator(points[i - 1], points[i])
  }
  return { points, cum, total: cum[n - 1] }
}

/**
 * @param {{ points: any[], cum: Float64Array, total: number }} poly
 * @param {number} distAlong
 * @returns {{ lon: number, lat: number, segIndex: number, t: number }}
 */
function interpolateAlong(poly, distAlong) {
  const { points, cum, total } = poly
  const n = points.length
  if (n < 2 || total <= 0) {
    return null
  }
  const d = Math.max(0, Math.min(distAlong, total))
  let seg = 0
  for (let i = 1; i < n; i++) {
    if (cum[i] >= d) {
      seg = i - 1
      break
    }
    seg = n - 2
  }
  const segLen = cum[seg + 1] - cum[seg]
  const t = segLen > 0 ? (d - cum[seg]) / segLen : 0
  const p0 = points[seg]
  const p1 = points[seg + 1]
  const mx = p0.mx + t * (p1.mx - p0.mx)
  const my = p0.my + t * (p1.my - p0.my)
  const { lon, lat } = mercatorMetersToLonLat(mx, my)
  return { lon, lat, segIndex: seg, t }
}

function bearingAt(poly, distAlong) {
  const { points, total } = poly
  if (total <= 0 || points.length < 2) return 0
  const delta = Math.min(total * 0.01, 50)
  const d0 = Math.max(0, distAlong - delta)
  const d1 = Math.min(total, distAlong + delta)
  const a = interpolateAlong(poly, d0)
  const b = interpolateAlong(poly, d1)
  if (!a || !b) return 0
  return bearingRadians(a.lon, a.lat, b.lon, b.lat)
}

/**
 * MapLibre text-keep-upright（map 对齐）：倒置时加 π
 * @param {number} bearingRad
 * @param {boolean} keepUpright
 */
export function applyKeepUpright(bearingRad, keepUpright) {
  if (!keepUpright) return bearingRad
  let b = bearingRad
  while (b > Math.PI) b -= 2 * Math.PI
  while (b < -Math.PI) b += 2 * Math.PI
  if (b > Math.PI / 2 || b < -Math.PI / 2) {
    b += Math.PI
    while (b > Math.PI) b -= 2 * Math.PI
    while (b < -Math.PI) b += 2 * Math.PI
  }
  return b
}

/**
 * @param {Array<[number, number]>} ringLonLat
 * @param {object} opts
 * @param {'line'|'line-center'} opts.placement
 * @param {number} opts.spacingMeters
 * @param {boolean} opts.textKeepUpright
 * @returns {Array<{ lon: number, lat: number, rotationRad: number }>}
 */
export function computeLineSymbolPlacements(ringLonLat, opts) {
  const { placement, spacingMeters, textKeepUpright } = opts
  const poly = buildPolylineMercator(ringLonLat)
  const { total } = poly
  if (total <= 0 || poly.points.length < 2) return []

  const out = []

  if (placement === 'line-center') {
    const mid = interpolateAlong(poly, total / 2)
    if (!mid) return []
    const bearing = bearingAt(poly, total / 2)
    const rotationRad = applyKeepUpright(bearing, textKeepUpright)
    out.push({ lon: mid.lon, lat: mid.lat, rotationRad })
    return out
  }

  if (placement === 'line') {
    const spacing = Math.max(spacingMeters || 250, 1)
    const endPad = Math.min(spacing * 0.5, total * 0.25)
    let d = endPad
    if (d >= total - endPad) {
      const mid = interpolateAlong(poly, total / 2)
      if (mid) {
        const bearing = bearingAt(poly, total / 2)
        out.push({
          lon: mid.lon,
          lat: mid.lat,
          rotationRad: applyKeepUpright(bearing, textKeepUpright)
        })
      }
      return out
    }
    while (d <= total - endPad) {
      const p = interpolateAlong(poly, d)
      if (p) {
        const bearing = bearingAt(poly, d)
        out.push({
          lon: p.lon,
          lat: p.lat,
          rotationRad: applyKeepUpright(bearing, textKeepUpright)
        })
      }
      d += spacing
    }
    return out
  }

  return []
}

/**
 * 根据瓦片层级与纬度估算 symbol-spacing（样式像素）对应的地面距离（米）
 * @param {number} z
 * @param {number} latDeg
 * @param {number} spacingPx
 */
export function symbolSpacingToMeters(z, latDeg, spacingPx) {
  const worldSize = 40075016.68557849
  const tileCount = Math.pow(2, z)
  const metersPerPixelEq = worldSize / (256 * tileCount)
  const latRad = (latDeg * Math.PI) / 180
  const metersPerPixel = metersPerPixelEq * Math.cos(latRad)
  return (spacingPx || 250) * metersPerPixel
}
