function containsRectangle(rectangle, lon, lat) {
  return (
    lon >= rectangle.west &&
    lon <= rectangle.east &&
    lat >= rectangle.south &&
    lat <= rectangle.north
  )
}

function mercYRad(lat) {
  const clamped = Cesium.Math.clamp(
    lat,
    -Cesium.Math.PI_OVER_TWO + 1e-10,
    Cesium.Math.PI_OVER_TWO - 1e-10
  )
  return Math.log(Math.tan(Cesium.Math.PI_OVER_TWO * 0.5 + clamped * 0.5))
}

function uvFromCartographic(tile, cartographic) {
  const rect = tile.rectangle
  const u = (cartographic.longitude - rect.west) / (rect.east - rect.west)
  const v = (cartographic.latitude - rect.south) / (rect.north - rect.south)
  return new Cesium.Cartesian2(u, v)
}

/** 与 TileRttRenderer Mercator UV 材质一致，用于 ID 纹理读回 */
function uvFromCartographicMerc(tile, cartographic) {
  const rect = tile.rectangle
  const u = (cartographic.longitude - rect.west) / (rect.east - rect.west)
  const y0 = mercYRad(rect.south)
  const y1 = mercYRad(rect.north)
  const denom = y1 - y0
  const v =
    Math.abs(denom) < 1e-14
      ? (cartographic.latitude - rect.south) / (rect.north - rect.south)
      : (mercYRad(cartographic.latitude) - y0) / denom
  return new Cesium.Cartesian2(u, v)
}

export class TileFeaturePicker {
  constructor(tileset) {
    this.tileset = tileset
  }

  pick(windowPosition, scene = this.tileset.scene) {
    if (!scene || !windowPosition) return null
    const ray = scene.camera.getPickRay(windowPosition)
    if (!ray) return null
    const cartesian = scene.globe.pick(ray, scene)
    if (!cartesian) return null
    return this.pickFromCartesian(cartesian, scene)
  }

  pickFromCartesian(cartesian, scene = this.tileset.scene) {
    const cartographic = Cesium.Cartographic.fromCartesian(cartesian)
    if (!cartographic) return null
    return this.pickFromCartographic(cartographic, scene)
  }

  pickFromCartographic(cartographic, scene = this.tileset.scene) {
    const tiles = this.tileset._tilesToRender
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]
      const renderer = tile._rttRenderer
      if (!renderer) continue
      if (
        !containsRectangle(
          tile.rectangle,
          cartographic.longitude,
          cartographic.latitude
        )
      ) {
        continue
      }
      const uv = this.tileset.getRttUvCorrection()
        ? uvFromCartographicMerc(tile, cartographic)
        : uvFromCartographic(tile, cartographic)
      if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) continue
      const fid = renderer.readFeatureIdAtUv(uv, scene.context)
      if (!fid) return null
      const feature = renderer.featureTable.get(fid)
      if (!feature) return null
      return {
        ...feature,
        tile,
        cartographic
      }
    }
    return null
  }
}
