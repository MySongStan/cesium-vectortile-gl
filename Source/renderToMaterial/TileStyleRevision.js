export class TileStyleRevision {
  constructor() {
    this._revision = 1
    this._changedLayers = new Set()
  }

  get revision() {
    return this._revision
  }

  bump(layerId) {
    this._revision++
    if (layerId) {
      this._changedLayers.add(layerId)
    }
    return this._revision
  }

  hasLayerChanged(layerId) {
    return this._changedLayers.has(layerId)
  }

  clearChangedLayers() {
    this._changedLayers.clear()
  }
}
