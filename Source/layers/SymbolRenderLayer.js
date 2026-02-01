import * as MVT from '@mapbox/vector-tile'
import { StyleLayer } from '../style/StyleLayer'
import { VectorTileLOD } from '../VectorTileLOD'
import { IRenderLayer } from './IRenderLayer'
import { SymbolLayerVisualizer } from './visualizers/SymbolLayerVisualizer'
import { registerRenderLayer } from './registerRenderLayer'

export class SymbolRenderLayer extends IRenderLayer {
  /**
   * @param {MVT.VectorTileFeature[]} sourceFeatures
   * @param {StyleLayer} style
   * @param {VectorTileLOD} tile
   */
  constructor(sourceFeatures, styleLayer, tile) {
    super(sourceFeatures, styleLayer, tile)
    this.labels = []
  }

  /**
   * @param {Cesium.FrameState} frameState
   * @param {VectorTileset} tileset
   */
  update(frameState, tileset) {
    //TODO：动态更新符号样式

    super.update(frameState, tileset)
  }
}

registerRenderLayer('symbol', SymbolRenderLayer, SymbolLayerVisualizer)
