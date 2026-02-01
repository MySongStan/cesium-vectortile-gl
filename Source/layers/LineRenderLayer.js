import * as MVT from '@mapbox/vector-tile'
import { StyleLayer } from '../style/StyleLayer'
import { VectorTileset } from '../VectorTileset'
import { IRenderLayer } from './IRenderLayer'
import { registerRenderLayer } from './registerRenderLayer'
import { VectorTileLOD } from '../VectorTileLOD'
import { LineLayerVisualizer } from './visualizers/LineLayerVisualizer'

export class LineRenderLayer extends IRenderLayer {
  /**
   * @param {MVT.VectorTileFeature[]} sourceFeatures
   * @param {StyleLayer} styleLayer
   * @param {VectorTileLOD} tile
   */
  constructor(sourceFeatures, styleLayer, tile) {
    super(sourceFeatures, styleLayer, tile)
    this.primitive = null
    this.dasharray = []
    this.dashLength = 0
  }

  createPrimitve(frameState, tileset) {
    const primitive = new Cesium.PolylineCollection()
    const sourceFeatures = this.sourceFeatures
    const style = this.style
    const tile = this.tile

    function addPolyline(coordinates, lineWidth, lineColor) {
      if (coordinates.length < 2) return

      const positions = coordinates.map(coord =>
        Cesium.Cartesian3.fromDegrees(coord[0], coord[1])
      )
      primitive.add({
        positions,
        width: lineWidth,
        material: Cesium.Material.fromType('Color', {
          color: style.convertColor(lineColor)
        })
      })
    }

    for (const sourceFeature of sourceFeatures) {
      const feature = sourceFeature.toGeoJSON(tile.x, tile.y, tile.z)
      if (!feature.geometry) continue

      //读取图层样式属性
      const lineWidth = style.paint.getDataValue(
        'line-width',
        tile.z,
        sourceFeature
      )
      const lineColor = style.paint.getDataValue(
        'line-color',
        tile.z,
        sourceFeature
      )

      const geometryType = feature.geometry.type
      const coordinates = feature.geometry.coordinates
      if (geometryType == 'LineString') {
        addPolyline(coordinates, lineWidth, lineColor)
      } else if (
        geometryType == 'MultiLineString' ||
        geometryType == 'Polygon'
      ) {
        for (const ring of coordinates) {
          addPolyline(ring, lineWidth, lineColor)
        }
      } else if (geometryType == 'MultiPolygon') {
        for (const polygon of coordinates) {
          for (const ring of polygon) {
            addPolyline(ring, lineWidth, lineColor)
          }
        }
      } else {
        console.log('暂不支持几何类型：' + geometryType)
      }
    }

    this.primitive = primitive
  }

  /**
   * @param {Cesium.FrameState} frameState
   * @param {VectorTileset} tileset
   */
  update(frameState, tileset) {
    // if (!this.primitive) {
    //     this.createPrimitve(frameState, tileset)
    // }
    // if (this.primitive && this.primitive.length) {
    //     this.primitive.update(frameState)
    // }
    super.update(frameState, tileset)
  }

  destroy() {
    this.primitive = this.primitive && this.primitive.destroy()
    super.destroy()
  }
}

registerRenderLayer('line', LineRenderLayer, LineLayerVisualizer)
