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

    super.update(frameState, tileset)
  }
}

registerRenderLayer('fill', FillRenderLayer, FillLayerVisualizer)
