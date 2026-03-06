import { VectorTileset } from '../VectorTileset'
import { IRenderLayer } from './IRenderLayer'
import { registerRenderLayer } from './registerRenderLayer'
import { FillLayerVisualizer } from './visualizers/FillLayerVisualizer'

export class FillRenderLayer extends IRenderLayer {
  /**
   * @param {Cesium.FrameState} frameState
   * @param {VectorTileset} tileset
   */
  update(frameState, tileset) {
    //可以在这里实现同步样式，动态更新图层颜色等样式
    if (this.paintNeedsUpdate) {
      const style = this.style,
        tile = this.tile,
        batchTable = this._batchTable

      for (const feature of this.features) {
        const fillColor = style.convertColor(
          style.paint.getDataValue('fill-color', tile.z, feature)
        )
        const fillOpacity = style.paint.getDataValue(
          'fill-opacity',
          tile.z,
          feature
        )
        feature.fillColor = fillColor
        feature.fillOpacity = fillOpacity

        const id = feature.id
        const colorBytes = fillColor.toBytes()
        colorBytes[3] = Math.floor(colorBytes[3] * fillOpacity)
        batchTable.setBatchedAttribute(id, 0, colorBytes)
      }

      this.paintNeedsUpdate = false
    }
    super.update(frameState, tileset)
  }
}

registerRenderLayer('fill', FillRenderLayer, FillLayerVisualizer)
