import * as MVT from '@mapbox/vector-tile'
import { classifyRings } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { EXTENT } from 'maplibre-gl/src/data/extent'
import { loadGeometry } from 'maplibre-gl/src/data/load_geometry'
import { FramebufferTrianglePass } from './framebufferTrianglePass'
import { triangulateRingsToGeometryPbf } from './tileRttFillGeometryPbf.js'

/** @typedef {'maplibre8192' | 'pbfRaw'} RttGeometrySource */

/** 单瓦片矢量 RTT：仅 rasterize 样式类型为 fill 的面；line/symbol 等由 VectorTileLOD 走原 Visualizer。 */

const TILE_BUFFER_EXTENT = 64

function normalizeBufferExtent(value, fallback = TILE_BUFFER_EXTENT) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.floor(n))
}

function normalizeUvCorrection(v) {
  return v === true
}

function tileKey(tile) {
  return `${tile.z}/${tile.x}/${tile.y}`
}

function rgbaToFeatureId(rgba) {
  return (
    ((rgba[0] & 255) << 24) |
    ((rgba[1] & 255) << 16) |
    ((rgba[2] & 255) << 8) |
    (rgba[3] & 255)
  )
}

function featureIdToRgba(id) {
  return [
    ((id >>> 24) & 255) / 255,
    ((id >>> 16) & 255) / 255,
    ((id >>> 8) & 255) / 255,
    (id & 255) / 255
  ]
}

function stripClosedRing(ring) {
  if (!ring || ring.length < 2) return ring
  const a = ring[0]
  const b = ring[ring.length - 1]
  if (a.x === b.x && a.y === b.y) {
    return ring.slice(0, -1)
  }
  return ring
}

function extentToPixel(v, extent, textureSize, bufferExtent) {
  const denom = extent + bufferExtent * 2
  return ((v + bufferExtent) / denom) * textureSize
}

function triangulateRingsToGeometry(rings, extent, textureSize, bufferExtent) {
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
  const indices = points.length > 65535 ? new Uint32Array(tri) : new Uint16Array(tri)
  return FramebufferTrianglePass.createPixelTriangleGeometry(
    new Float32Array(flat),
    indices
  )
}

function parseSourceTile(tileSource) {
  if (!tileSource) return null
  if (tileSource.layers) return tileSource
  if (!tileSource.buffer) return null
  try {
    return new MVT.VectorTile(new Pbf(tileSource.buffer))
  } catch {
    return null
  }
}

function createTileMaterial(texture, uvCorrection = false) {
  if (uvCorrection) {
    return new Cesium.Material({
      fabric: {
        type: 'RttImageMercatorUv',
        uniforms: {
          // 自定义 fabric 里 sampler2D 需先用可识别类型声明；rebuild 时再赋 RTT 纹理。
          image: Cesium.Material.DefaultImageId,
          west: 0,
          east: 1,
          south: 0,
          north: 1,
          color: new Cesium.Color(1, 1, 1, 1)
        },
        source: `
float rttMercY(float lat) {
  lat = clamp(lat, -1.57079632679 + 1e-7, 1.57079632679 - 1e-7);
  return log(tan(0.78539816339 + 0.5 * lat));
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material m = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  float lon = mix(west, east, st.x);
  float lat = mix(south, north, st.y);
  float u = (lon - west) / (east - west);
  float y0 = rttMercY(south);
  float y1 = rttMercY(north);
  float denom = y1 - y0;
  float v = abs(denom) < 1e-10 ? st.y : (rttMercY(lat) - y0) / denom;
  vec2 uv = clamp(vec2(u, v), vec2(0.0), vec2(1.0));
  vec4 tex = texture(image, uv);
  m.diffuse = tex.rgb * color.rgb;
  m.alpha = tex.a * color.a;
  return m;
}
`
      }
    })
  }
  return Cesium.Material.fromType('Image', {
    image: texture,
    repeat: new Cesium.Cartesian2(1, 1),
    color: new Cesium.Color(1, 1, 1, 1)
  })
  // return new Cesium.Material({
  //   fabric: {
  //     type: 'Image',
  //     uniforms: {
  //       image: texture,
  //       repeat: new Cesium.Cartesian2(1, 1),
  //       color: new Cesium.Color(1, 1, 1, 1)
  //     }
  //   },
  //   minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
  //   magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR
  // })
}

export class TileRttRenderer {
  constructor(options) {
    this.tile = options.tile
    this.context = options.context
    this.pass = options.pass ?? Cesium.Pass.GLOBE
    this.resolution = Math.max(64, options.resolution ?? 512)
    /** @type {RttGeometrySource} */
    this._geometrySource =
      options.geometrySource === 'pbfRaw' ? 'pbfRaw' : 'maplibre8192'
    this._bufferExtent = normalizeBufferExtent(options.bufferExtent)
    this._uvCorrection = normalizeUvCorrection(options.uvCorrection)

    this._dataRevision = -1
    this._styleRevision = -1
    this._resolutionKey = this.resolution
    this._built = false

    this._featureTable = new Map()
    this._nextFeatureId = 1

    this._colorPass = new FramebufferTrianglePass({
      context: this.context,
      width: this.resolution,
      height: this.resolution,
      pass: this.pass,
      vertexPositionSpace: 'pixel'
    })
    this._idPass = new FramebufferTrianglePass({
      context: this.context,
      width: this.resolution,
      height: this.resolution,
      pass: this.pass,
      vertexPositionSpace: 'pixel'
    })
    this._colorPass.setStyle({
      background: [0, 0, 0, 0],
      tint: [1, 1, 1, 1],
      defaultFillColor: [1, 1, 1, 1]
    })
    this._idPass.setStyle({
      background: [0, 0, 0, 0],
      tint: [1, 1, 1, 1],
      defaultFillColor: [0, 0, 0, 0]
    })

    this._tilePrimitive = null
    this._tileCommands = []
  }

  get key() {
    return tileKey(this.tile)
  }

  get colorTexture() {
    return this._colorPass.colorTexture
  }

  get idFramebuffer() {
    return this._idPass._framebuffer
  }

  get featureTable() {
    return this._featureTable
  }

  estimateBytes() {
    return this.resolution * this.resolution * 4 * 2
  }

  ensureResolution(resolution) {
    const r = Math.max(64, resolution | 0)
    if (r === this.resolution) return false
    this.resolution = r
    this._resolutionKey = r
    this._colorPass.setSize(r, r)
    this._idPass.setSize(r, r)
    this._tileCommands.length = 0
    return true
  }

  ensureBufferExtent(bufferExtent) {
    const b = normalizeBufferExtent(bufferExtent)
    if (b === this._bufferExtent) return false
    this._bufferExtent = b
    return true
  }

  ensureUvCorrection(enabled) {
    const v = normalizeUvCorrection(enabled)
    if (v === this._uvCorrection) return false
    this._uvCorrection = v
    this._tilePrimitive = null
    this._tileCommands.length = 0
    return true
  }

  /**
   * @param {RttGeometrySource} [geometrySource] - 须与 tileset 当前模式一致；变化则强制重建
   */
  needsRebuild(
    dataRevision,
    styleRevision,
    resolutionKey,
    geometrySource,
    bufferExtent
  ) {
    const gs =
      geometrySource === 'pbfRaw' ? 'pbfRaw' : 'maplibre8192'
    const be = normalizeBufferExtent(bufferExtent)
    return (
      !this._built ||
      dataRevision !== this._dataRevision ||
      styleRevision !== this._styleRevision ||
      resolutionKey !== this._resolutionKey ||
      gs !== this._geometrySource ||
      be !== this._bufferExtent
    )
  }

  rebuildFromTile(tile, tileset, styleRevision) {
    const colorEntries = []
    const idEntries = []
    this._featureTable.clear()
    this._nextFeatureId = 1

    const styleLayers = tileset._styleLayers
    for (const styleLayer of styleLayers) {
      if (styleLayer.type !== 'fill') continue
      const sourceData = tile.sources[styleLayer.source]
      const sourceTile = parseSourceTile(sourceData)
      if (!sourceTile) continue
      const sourceLayerId =
        styleLayer.sourceLayer ?? styleLayer.data?.['source-layer'] ?? '_geojsonTileLayer'
      const sourceLayer = sourceTile.layers[sourceLayerId]
      if (!sourceLayer) continue

      for (let i = 0; i < sourceLayer.length; i++) {
        const feature = sourceLayer.feature(i)
        if (
          styleLayer.filter &&
          !styleLayer.filter.filter({ zoom: tile.z }, feature)
        ) {
          continue
        }
        const featureId = this._nextFeatureId++
        const idColor = featureIdToRgba(featureId)
        const meta = {
          tileKey: this.key,
          layerId: styleLayer.id,
          sourceLayer: styleLayer.sourceLayer,
          featureId: feature.id ?? null,
          properties: feature.properties || {},
          geometryType: MVT.VectorTileFeature.types[feature.type]
        }
        this._featureTable.set(featureId, meta)

        const fillColor = styleLayer.convertColor(
          styleLayer.paint.getDataValue('fill-color', tile.z, feature)
        )
        const fillOpacity = styleLayer.paint.getDataValue(
          'fill-opacity',
          tile.z,
          feature
        )
        const rgba = fillColor.toBytes()
        rgba[3] = Math.floor(rgba[3] * fillOpacity)
        const fillRgba = [
          rgba[0] / 255,
          rgba[1] / 255,
          rgba[2] / 255,
          rgba[3] / 255
        ]

        const usePbfRaw = this._geometrySource === 'pbfRaw'
        const rings = usePbfRaw
          ? feature.loadGeometry()
          : loadGeometry(feature)
        const polygons = classifyRings(rings)
        const tileExtentForPbf =
          feature.extent || sourceLayer.extent || 4096
        for (const polygon of polygons) {
          const tri = usePbfRaw
            ? triangulateRingsToGeometryPbf(
                polygon,
                tileExtentForPbf,
                this.resolution,
                this._bufferExtent
              )
            : triangulateRingsToGeometry(
                polygon,
                EXTENT,
                this.resolution,
                this._bufferExtent
              )
          if (!tri) continue
          colorEntries.push({ geometry: tri, color: fillRgba })
          idEntries.push({ geometry: tri, color: idColor })
        }
      }
    }

    this._colorPass.setGeometries(colorEntries)
    this._colorPass.render()
    this._idPass.setGeometries(idEntries)
    this._idPass.render()

    const ctx = this.context
    if (ctx) {
      this._colorPass.executeCommands(ctx, undefined)
      this._idPass.executeCommands(ctx, undefined)
    }

    this._ensureTileCommands(tileset.scene?.frameState)
    if (this._tilePrimitive?.appearance?.material?.uniforms) {
      this._tilePrimitive.appearance.material.uniforms.image = this.colorTexture
      this._tileCommands.length = 0
    }

    this._built = true
    this._dataRevision = tile._rttDataRevision ?? tile._workerEpoch ?? 0
    this._styleRevision = styleRevision
    this._resolutionKey = this.resolution
  }

  _ensureTileCommands(frameState) {
    if (!frameState) return
    if (!this._tilePrimitive) {
      const texturedVF =
        Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat
      this._tilePrimitive = new Cesium.GroundPrimitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.RectangleGeometry({
            rectangle: this.tile.rectangle,
            vertexFormat: texturedVF
          })
        }),
        appearance: new Cesium.MaterialAppearance({
          material: createTileMaterial(this.colorTexture, this._uvCorrection),
          translucent: false,
          flat: true,
          faceForward: true,
          materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED
        }),
        asynchronous: false,
        releaseGeometryInstances: true
      })
    }

    const uniforms = this._tilePrimitive?.appearance?.material?.uniforms
    if (this._uvCorrection && uniforms && uniforms.west !== undefined) {
      const rect = this.tile.rectangle
      uniforms.west = rect.west
      uniforms.east = rect.east
      uniforms.south = rect.south
      uniforms.north = rect.north
    }

    if (!this._tileCommands.length) {
      const saved = frameState.commandList
      const list = (frameState.commandList = [])
      this._tilePrimitive.update(frameState)
      // 保留 GroundPrimitive 默认 pass（TERRAIN_CLASSIFICATION）；改为 CESIUM_3D_TILE 会破坏贴地分类深度，出现「边缘有、中心无」。
      for (let i = 0; i < list.length; i++) {
        this._tileCommands.push(list[i])
      }
      frameState.commandList = saved
    }
  }

  pushRttCommands(frameState) {
    if (!this._built) return
    this._colorPass.pushCommands(frameState)
    this._idPass.pushCommands(frameState)
  }

  pushTileCommands(renderList, frameState) {
    if (!this._built) return
    this._ensureTileCommands(frameState)
    if (this._tileCommands.length) {
      renderList.rttFillCommands.push(...this._tileCommands)
    }
  }

  readFeatureIdAtUv(uv, context) {
    if (!this._built || !this.idFramebuffer) return 0
    const x = Math.max(
      0,
      Math.min(this.resolution - 1, Math.floor(uv.x * this.resolution))
    )
    const yTop = Math.max(
      0,
      Math.min(this.resolution - 1, Math.floor((1 - uv.y) * this.resolution))
    )
    const y = this.resolution - 1 - yTop
    const pixels = context.readPixels({
      x,
      y,
      width: 1,
      height: 1,
      framebuffer: this.idFramebuffer
    })
    return rgbaToFeatureId(pixels)
  }

  destroy() {
    this._tileCommands.length = 0
    if (this._tilePrimitive) {
      this._tilePrimitive.destroy()
      this._tilePrimitive = null
    }
    this._colorPass?.destroy()
    this._idPass?.destroy()
    this._featureTable.clear()
  }
}
