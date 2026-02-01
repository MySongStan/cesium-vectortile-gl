import { expression, latest } from '@maplibre/maplibre-gl-style-spec'

export class StyleLayerProperties {
  constructor(groupName, styleProperties = {}) {
    this.data = styleProperties
    /**@type {Map<string,import('@maplibre/maplibre-gl-style-spec').StylePropertyExpression>} */
    this.props = new Map()

    const groupReference = latest[groupName]
    for (const key in groupReference) {
      if (Object.hasOwnProperty.call(groupReference, key)) {
        const reference = groupReference[key]
        const value = styleProperties[key]
        const property = expression.normalizePropertyExpression(
          value === undefined ? reference.default : value,
          reference
        )
        this.props.set(key, property)
      }
    }
  }

  /**
   * Replace tokens in a string template with values in an object
   *
   * @param properties - a key/value relationship between tokens and replacements
   * @param text - the template string
   * @returns the template with tokens replaced
   */
  resolveTokens(properties, text) {
    return text.replace(/{([^{}]+)}/g, (match, key) => {
      return properties && key in properties ? String(properties[key]) : ''
    })
  }
  getDataConstValue(name, zoom) {
    const expr = this.props.get(name)
    return expr && expr.evaluate({ zoom })
  }

  getDataValue(name, zoom, feature) {
    const expr = this.props.get(name)
    return expr && expr.evaluate({ zoom }, feature)
  }
}
