/**
 * RTT 填充几何：使用 MVT 解码后的原始瓦片坐标（{@link import('@mapbox/vector-tile').VectorTileFeature#loadGeometry}），
 * 范围由 {@link import('@mapbox/vector-tile').VectorTileFeature#extent} 给出（常见 4096，以瓦片为准）。
 * 不经 MapLibre `loadGeometry` 的 8192 归一化。
 */

import { FramebufferTrianglePass } from './framebufferTrianglePass'

function stripClosedRing(ring) {
  if (!ring || ring.length < 2) return ring
  const a = ring[0]
  const b = ring[ring.length - 1]
  if (a.x === b.x && a.y === b.y) {
    return ring.slice(0, -1)
  }
  return ring
}

function extentToPixel(v, tileExtent, textureSize, bufferExtent) {
  const b = Math.max(0, bufferExtent | 0)
  const denom = tileExtent + b * 2
  return ((v + b) / denom) * textureSize
}

/**
 * 将 MVT 环（瓦片坐标系，extent 见参数）三角化并生成 FBO 像素空间 {@link Cesium.Geometry}。
 * @param {import('@mapbox/point-geometry')[][]} rings
 * @param {number} tileExtent PBF 图层/要素 extent，典型 4096
 * @param {number} textureSize RTT 单边像素
 * @param {number} [bufferExtent=0] 映射时两侧扩展像素缓冲（负数按 0 处理）
 * @returns {Cesium.Geometry|null}
 */
export function triangulateRingsToGeometryPbf(
  rings,
  tileExtent,
  textureSize,
  bufferExtent = 0
) {
  const extent = Math.max(1, tileExtent | 0)
  if (!rings || !rings.length) return null
  const points = []
  const holes = []
  const flat = []

  for (let i = 0; i < rings.length; i++) {
    const ring = stripClosedRing(rings[i])
    if (!ring || ring.length < 3) continue
    if (i > 0) {
      holes.push(points.length)
    }
    for (const p of ring) {
      const px = extentToPixel(p.x, extent, textureSize, bufferExtent)
      const py = extentToPixel(p.y, extent, textureSize, bufferExtent)
      points.push(new Cesium.Cartesian2(px, py))
      flat.push(px, py)
    }
  }

  if (points.length < 3) return null
  let tri = Cesium.PolygonPipeline.triangulate(points, holes)
  if (!tri || !tri.length) {
    points.reverse()
    tri = Cesium.PolygonPipeline.triangulate(points, holes)
    if (!tri || !tri.length) return null
  }
  const indices =
    points.length > 65535 ? new Uint32Array(tri) : new Uint16Array(tri)
  return FramebufferTrianglePass.createPixelTriangleGeometry(
    new Float32Array(flat),
    indices
  )
}
