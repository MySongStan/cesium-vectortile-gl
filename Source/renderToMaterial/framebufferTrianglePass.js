/**
 * 在 **Cesium 同一 Context** 下将几何（UV 三角网）按样式渲染到离屏 FBO 颜色纹理。
 *
 * **数据流**：你提供 {@link Cesium.Geometry}（顶点属性名为 `position`，**2 分量 float**）+
 * {@link FramebufferTrianglePass#setStyle}；调用 `render()` 时**在内部**生成 `ClearCommand` 与若干
 * `DrawCommand`。**不要**自己构造 DrawCommand。
 *
 * **顶点坐标**：默认 `vertexPositionSpace: 'normalized'`，`position` 为 [0,1]²（与纹理 UV 一致）；设为
 * `'pixel'` 时，`position` 为 **FBO 像素坐标**，原点在**左上角**，`x` 向右、`y` 向下，典型范围
 * `[0, width] × [0, height]`（与 {@link FramebufferTrianglePass#width} / {@link FramebufferTrianglePass#height}
 * 一致）。映射在顶点着色器内完成，无需改 `DrawCommand`。
 *
 * 每帧把生成好的命令推进场景：`pushCommands(frameState)`。与 GroundPrimitive 同用时勿用 `Pass.OPAQUE`，见构造选项 `pass`。
 *
 * 若没有现成的 Geometry，可用 {@link FramebufferTrianglePass.createUvTriangleGeometry} /
 * {@link FramebufferTrianglePass.createPixelWideLineLoopGeometry} 等。需要**可控线宽**时用
 * `createPixelWideLine*` / `createUvWideLine*`（**miter 拐角**的三角形带，可选 `miterLimit`），勿依赖
 * `gl.lineWidth`（多数平台恒为 1）。
 * 也支持 `PrimitiveType.LINE_STRIP`、`LINE_LOOP`（仅 1px 粗）。
 *
 * **归一化模式**：`x,y` ∈ [0,1]，向右、向下，映射到裁剪空间时翻转 `y`。**像素模式**：`x,y` 为像素，左上原点。
 */

const VS_SOURCE = `
in vec2 position;
uniform vec4 u_tint;
uniform float u_opacity;
uniform vec2 u_fboSize;
uniform float u_pixelCoords;
out vec4 v_tintColor;
void main() {
  float x;
  float y;
  if (u_pixelCoords > 0.5) {
    x = position.x / u_fboSize.x * 2.0 - 1.0;
    y = 1.0 - position.y / u_fboSize.y * 2.0;
  } else {
    x = position.x * 2.0 - 1.0;
    y = 1.0 - position.y * 2.0;
  }
  gl_Position = vec4(x, y, 0.0, 1.0);
  vec4 c = u_tint;
  c.a *= u_opacity;
  v_tintColor = c;
}
`

const FS_SOURCE = `
in vec4 v_tintColor;
uniform vec4 u_drawColor;
void main() {
  out_FragColor = v_tintColor * u_drawColor;
}
`

const ATTRIBUTE_LOCATIONS = { position: 0 }

/** @type {Cesium.BoundingSphere} */
let _sharedUvBounds

function getSharedUvBoundingSphere() {
  if (!_sharedUvBounds) {
    _sharedUvBounds = new Cesium.BoundingSphere(
      new Cesium.Cartesian3(0.5, 0.5, 0),
      2
    )
  }
  return _sharedUvBounds
}

/**
 * @typedef {[number, number, number, number]} RgbaTuple
 */

/**
 * 一块待光栅化的几何；`render()` 会为每项生成一个 DrawCommand。
 * @typedef {Object} FramebufferGeometryEntry
 * @property {Cesium.Geometry} geometry 须含 `position`：2 分量 FLOAT；含义见 {@link FramebufferTrianglePass} 的 `vertexPositionSpace`
 * @property {RgbaTuple} [color] 与 `u_tint` / `opacity` 相乘；省略则用样式的 `defaultFillColor`
 */

/**
 * @typedef {Object} FramebufferPassStyle
 * @property {RgbaTuple} [background] clear 颜色，默认透明
 * @property {RgbaTuple} [tint] 全局乘色，默认 (1,1,1,1)
 * @property {number} [opacity] 全局透明度因子，默认 1
 * @property {RgbaTuple} [defaultFillColor] 各 geometry 未指定 `color` 时的乘色，默认 (1,1,1,1)
 */

/**
 * @typedef {Object} FramebufferTrianglePassOptions
 * @property {Cesium.Context} context {@link Cesium.Scene#context}
 * @property {number} width
 * @property {number} height
 * @property {Cesium.Pass} [pass] 默认 {@link Cesium.Pass.GLOBE}。若贴到 {@link Cesium.GroundPrimitive}（地形分类），须早于
 *   {@link Cesium.Pass.TERRAIN_CLASSIFICATION} 执行；{@link Cesium.Pass.OPAQUE} 过晚会导致每帧先采样再写入 FBO、纹理发黑。
 * @property {'normalized'|'pixel'} [vertexPositionSpace='normalized'] `pixel` 时顶点为 FBO 像素坐标（左上原点）
 */

/**
 * 为缺少 `boundingSphere` 的几何补一个外包球（不修改传入实例）。
 * @param {Cesium.Geometry} geometry
 * @param {Cesium.BoundingSphere} fallbackBs
 */
function geometryWithBoundingSphere(geometry, fallbackBs) {
  if (geometry.boundingSphere) {
    return geometry
  }
  return new Cesium.Geometry({
    attributes: geometry.attributes,
    indices: geometry.indices,
    primitiveType: geometry.primitiveType ?? Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: fallbackBs
  })
}

/**
 * @param {Cesium.DrawCommand[]} commands
 */
function destroyDrawCommandVertexArrays(commands) {
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]
    if (
      c instanceof Cesium.DrawCommand &&
      c.vertexArray &&
      !c.vertexArray.isDestroyed()
    ) {
      c.vertexArray.destroy()
    }
  }
}

/**
 * 折线拐角 miter（polyline-miter-util 思路）：lineA / lineB 为从角点指向相邻顶点的单位向量。
 */
function miterJointLR(px, py, cx, cy, nx, ny, halfW, miterLimit) {
  let lax = px - cx
  let lay = py - cy
  let lbx = nx - cx
  let lby = ny - cy
  let la = Math.hypot(lax, lay)
  let lb = Math.hypot(lbx, lby)
  if (la < 1e-10) {
    la = 1e-10
  }
  if (lb < 1e-10) {
    lb = 1e-10
  }
  lax /= la
  lay /= la
  lbx /= lb
  lby /= lb
  const tx = lax + lbx
  const ty = lay + lby
  const tlen = Math.hypot(tx, ty)
  if (tlen < 1e-10) {
    const ox = -lay * halfW
    const oy = lax * halfW
    return {
      lx: cx + ox,
      ly: cy + oy,
      rx: cx - ox,
      ry: cy - oy
    }
  }
  const mcx = tx / tlen
  const mcy = ty / tlen
  const mitx = -mcy
  const mity = mcx
  const tmpX = -lay
  const tmpY = lax
  let denom = mitx * tmpX + mity * tmpY
  if (Math.abs(denom) < 1e-10) {
    denom = denom >= 0 ? 1e-10 : -1e-10
  }
  let miterLen = halfW / denom
  const cap = halfW * miterLimit
  if (miterLen > cap) {
    miterLen = cap
  } else if (miterLen < -cap) {
    miterLen = -cap
  }
  return {
    lx: cx + mitx * miterLen,
    ly: cy + mity * miterLen,
    rx: cx - mitx * miterLen,
    ry: cy - mity * miterLen
  }
}

function endCapLR(cx, cy, ox, oy, nx, ny, halfW) {
  let dx = nx - ox
  let dy = ny - oy
  let len = Math.hypot(dx, dy)
  if (len < 1e-10) {
    len = 1e-10
  }
  dx /= len
  dy /= len
  const px = -dy * halfW
  const py = dx * halfW
  return {
    lx: cx + px,
    ly: cy + py,
    rx: cx - px,
    ry: cy - py
  }
}

/**
 * 折线/闭合环挤出为三角形带，拐角 miter + 长度限制（避免尖刺）。
 * @param {Float32Array} positions2d xy 交错
 * @param {number} halfWidth 半线宽
 * @param {boolean} closed 是否闭合
 * @param {number} [miterLimit=4] miter 最大为 halfWidth 的倍数
 */
function extrudePolylineToTriangles(positions2d, halfWidth, closed, miterLimit = 4) {
  const p = positions2d
  const n = p.length >> 1
  if (n < 2 || !(halfWidth > 0)) {
    return {
      positions: new Float32Array(0),
      indices: new Uint16Array(0)
    }
  }

  const hw = halfWidth
  const Lx = new Float32Array(n)
  const Ly = new Float32Array(n)
  const Rx = new Float32Array(n)
  const Ry = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const cx = p[i * 2]
    const cy = p[i * 2 + 1]
    if (closed) {
      const im = (i - 1 + n) % n
      const ip = (i + 1) % n
      const m = miterJointLR(
        p[im * 2],
        p[im * 2 + 1],
        cx,
        cy,
        p[ip * 2],
        p[ip * 2 + 1],
        hw,
        miterLimit
      )
      Lx[i] = m.lx
      Ly[i] = m.ly
      Rx[i] = m.rx
      Ry[i] = m.ry
    } else if (i === 0) {
      const m = endCapLR(cx, cy, cx, cy, p[2], p[3], hw)
      Lx[i] = m.lx
      Ly[i] = m.ly
      Rx[i] = m.rx
      Ry[i] = m.ry
    } else if (i === n - 1) {
      const m = endCapLR(
        cx,
        cy,
        p[(i - 1) * 2],
        p[(i - 1) * 2 + 1],
        cx,
        cy,
        hw
      )
      Lx[i] = m.lx
      Ly[i] = m.ly
      Rx[i] = m.rx
      Ry[i] = m.ry
    } else {
      const m = miterJointLR(
        p[(i - 1) * 2],
        p[(i - 1) * 2 + 1],
        cx,
        cy,
        p[(i + 1) * 2],
        p[(i + 1) * 2 + 1],
        hw,
        miterLimit
      )
      Lx[i] = m.lx
      Ly[i] = m.ly
      Rx[i] = m.rx
      Ry[i] = m.ry
    }
  }

  const positions = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    positions[i * 4] = Lx[i]
    positions[i * 4 + 1] = Ly[i]
    positions[i * 4 + 2] = Rx[i]
    positions[i * 4 + 3] = Ry[i]
  }

  const segCount = closed ? n : n - 1
  const idx = []
  for (let i = 0; i < segCount; i++) {
    const i1 = closed ? (i + 1) % n : i + 1
    const a0 = i * 2
    const a1 = i * 2 + 1
    const b0 = i1 * 2
    const b1 = i1 * 2 + 1
    idx.push(a0, a1, b0, a1, b1, b0)
  }

  const vertCount = n * 2
  const IndexArray = vertCount > 65535 ? Uint32Array : Uint16Array
  const indices = IndexArray.from(idx)
  return { positions, indices }
}

/**
 * @param {{ miterLimit?: number }|undefined} options
 */
function wideLineMiterLimit(options) {
  const m = options && options.miterLimit
  if (typeof m === 'number' && m > 0) {
    return m
  }
  return 4
}

export class FramebufferTrianglePass {
  /**
   * 由 UV 平面三角网顶点（及可选索引）构造 {@link Cesium.Geometry}，供 {@link #setGeometries} 使用。
   * @param {Float32Array} positions 每顶点 2 分量
   * @param {Uint16Array|Uint32Array} [indices]
   * @returns {Cesium.Geometry}
   */
  static createUvTriangleGeometry(positions, indices) {
    return new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: positions
        })
      },
      indices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: getSharedUvBoundingSphere()
    })
  }

  /**
   * UV 折线闭合环（`LINE_LOOP`），用于轮廓线等。
   * @param {Float32Array} positions 每顶点 2 分量，至少 3 点
   * @returns {Cesium.Geometry}
   */
  static createUvLineLoopGeometry(positions) {
    return new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: positions
        })
      },
      primitiveType: Cesium.PrimitiveType.LINE_LOOP,
      boundingSphere: getSharedUvBoundingSphere()
    })
  }

  /**
   * 与 {@link #createUvTriangleGeometry} 相同，仅语义说明：在 `vertexPositionSpace: 'pixel'` 下使用，坐标为像素。
   * @param {Float32Array} positions
   * @param {Uint16Array|Uint32Array} [indices]
   * @returns {Cesium.Geometry}
   */
  static createPixelTriangleGeometry(positions, indices) {
    return FramebufferTrianglePass.createUvTriangleGeometry(positions, indices)
  }

  /**
   * 与 {@link #createUvLineLoopGeometry} 相同，仅语义说明：在 `vertexPositionSpace: 'pixel'` 下使用。
   * @param {Float32Array} positions
   * @returns {Cesium.Geometry}
   */
  static createPixelLineLoopGeometry(positions) {
    return FramebufferTrianglePass.createUvLineLoopGeometry(positions)
  }

  /**
   * 闭合折线挤出为三角形，`lineWidthPx` 为**整条线宽（像素）**。须配合 `vertexPositionSpace: 'pixel'`。
   * 拐角为 **miter**（可限制长度，避免尖刺）。
   * @param {Float32Array} positions2d
   * @param {number} lineWidthPx
   * @param {{ miterLimit?: number }} [options] `miterLimit`：尖角处 miter 最大为半线宽的倍数，默认 4
   * @returns {Cesium.Geometry}
   */
  static createPixelWideLineLoopGeometry(positions2d, lineWidthPx, options) {
    const ml = wideLineMiterLimit(options)
    const { positions, indices } = extrudePolylineToTriangles(
      positions2d,
      Math.max(1e-6, lineWidthPx) * 0.5,
      true,
      ml
    )
    return FramebufferTrianglePass.createPixelTriangleGeometry(positions, indices)
  }

  /**
   * 开放折线挤出为三角形（`LINE_STRIP` 语义：顶点依次相连，不闭合）。须配合 `vertexPositionSpace: 'pixel'`。
   * @param {Float32Array} positions2d 至少 2 顶点
   * @param {number} lineWidthPx
   * @param {{ miterLimit?: number }} [options]
   * @returns {Cesium.Geometry}
   */
  static createPixelWideLineStripGeometry(positions2d, lineWidthPx, options) {
    const ml = wideLineMiterLimit(options)
    const { positions, indices } = extrudePolylineToTriangles(
      positions2d,
      Math.max(1e-6, lineWidthPx) * 0.5,
      false,
      ml
    )
    return FramebufferTrianglePass.createPixelTriangleGeometry(positions, indices)
  }

  /**
   * 归一化坐标 [0,1]² 下的宽线闭合环：在 FBO 像素空间挤出（线宽为 `lineWidthPx`），再除回宽高。
   * 须配合 `vertexPositionSpace: 'normalized'`。
   * @param {{ miterLimit?: number }} [options]
   */
  static createUvWideLineLoopGeometry(
    positionsNorm2d,
    lineWidthPx,
    fboWidth,
    fboHeight,
    options
  ) {
    const ml = wideLineMiterLimit(options)
    const n = positionsNorm2d.length >> 1
    const px = new Float32Array(positionsNorm2d.length)
    for (let i = 0; i < n; i++) {
      px[i * 2] = positionsNorm2d[i * 2] * fboWidth
      px[i * 2 + 1] = positionsNorm2d[i * 2 + 1] * fboHeight
    }
    const { positions, indices } = extrudePolylineToTriangles(
      px,
      Math.max(1e-6, lineWidthPx) * 0.5,
      true,
      ml
    )
    const out = new Float32Array(positions.length)
    for (let i = 0; i < positions.length; i += 2) {
      out[i] = positions[i] / fboWidth
      out[i + 1] = positions[i + 1] / fboHeight
    }
    return FramebufferTrianglePass.createUvTriangleGeometry(out, indices)
  }

  /**
   * 归一化坐标下的开放宽线，语义同 {@link #createPixelWideLineStripGeometry}。
   * @param {{ miterLimit?: number }} [options]
   */
  static createUvWideLineStripGeometry(
    positionsNorm2d,
    lineWidthPx,
    fboWidth,
    fboHeight,
    options
  ) {
    const ml = wideLineMiterLimit(options)
    const n = positionsNorm2d.length >> 1
    const px = new Float32Array(positionsNorm2d.length)
    for (let i = 0; i < n; i++) {
      px[i * 2] = positionsNorm2d[i * 2] * fboWidth
      px[i * 2 + 1] = positionsNorm2d[i * 2 + 1] * fboHeight
    }
    const { positions, indices } = extrudePolylineToTriangles(
      px,
      Math.max(1e-6, lineWidthPx) * 0.5,
      false,
      ml
    )
    const out = new Float32Array(positions.length)
    for (let i = 0; i < positions.length; i += 2) {
      out[i] = positions[i] / fboWidth
      out[i + 1] = positions[i + 1] / fboHeight
    }
    return FramebufferTrianglePass.createUvTriangleGeometry(out, indices)
  }

  /**
   * @param {FramebufferTrianglePassOptions} options
   */
  constructor(options) {
    const context = options.context
    if (!context) {
      throw new Error('FramebufferTrianglePass: 需要 options.context（Cesium.Context）')
    }
    if (!context.webgl2) {
      throw new Error('FramebufferTrianglePass: 当前仅支持 WebGL2（Cesium.Context.webgl2）')
    }

    this._context = context
    this._width = Math.max(1, options.width | 0)
    this._height = Math.max(1, options.height | 0)
    this._pass = options.pass ?? Cesium.Pass.GLOBE
    const vps = options.vertexPositionSpace ?? 'normalized'
    this._usePixelSpace = vps === 'pixel'

    /** @type {Cesium.Cartesian2} */
    this._scratchFboSize = new Cesium.Cartesian2()

    /** @type {FramebufferPassStyle} */
    this._style = {
      background: [0, 0, 0, 0],
      tint: [1, 1, 1, 1],
      opacity: 1,
      defaultFillColor: [1, 1, 1, 1]
    }

    /** @type {FramebufferGeometryEntry[]} */
    this._geometryEntries = []

    /** @type {(Cesium.ClearCommand|Cesium.DrawCommand)[]} */
    this._gpuCommands = []

    this._shaderProgram = Cesium.ShaderProgram.fromCache({
      context,
      vertexShaderSource: VS_SOURCE,
      fragmentShaderSource: FS_SOURCE,
      attributeLocations: ATTRIBUTE_LOCATIONS
    })

    this._fallbackBs = getSharedUvBoundingSphere()

    this._createFramebufferResources()

    this._destroyed = false
    this.render()
  }

  _createFramebufferResources() {
    const context = this._context
    this._colorTexture = new Cesium.Texture({
      context,
      width: this._width,
      height: this._height,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      // 贴地时纹理常被缩小采样：LINEAR min 会把细线融进背景；NEAREST min 保线。放大用 LINEAR 减轻填充锯齿。
      sampler: new Cesium.Sampler({
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR
      })
    })

    this._framebuffer = new Cesium.Framebuffer({
      context,
      colorTextures: [this._colorTexture],
      destroyAttachments: false
    })
  }

  /** @type {Cesium.Texture} */
  get colorTexture() {
    return this._colorTexture
  }

  /** 最近一次 `render()` 生成的 GPU 命令（只读）。 */
  get gpuCommands() {
    return this._gpuCommands
  }

  get width() {
    return this._width
  }

  get height() {
    return this._height
  }

  /**
   * @returns {'normalized'|'pixel'}
   */
  get vertexPositionSpace() {
    return this._usePixelSpace ? 'pixel' : 'normalized'
  }

  /**
   * 切换顶点坐标含义后须保证几何数据与模式一致，并调用 `render()`（本方法会调用）。
   * @param {'normalized'|'pixel'} space
   */
  setVertexPositionSpace(space) {
    if (this._destroyed) return
    const pixel = space === 'pixel'
    if (pixel === this._usePixelSpace) return
    this._usePixelSpace = pixel
    this.render()
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    if (this._destroyed) return
    const w = Math.max(1, width | 0)
    const h = Math.max(1, height | 0)
    if (w === this._width && h === this._height) return

    this._width = w
    this._height = h

    destroyDrawCommandVertexArrays(this._gpuCommands)
    this._gpuCommands = []

    this._framebuffer.destroy()
    this._colorTexture.destroy()
    this._createFramebufferResources()
    this.render()
  }

  /**
   * 设置全局样式（清屏色、整体 tint/opacity、默认填充色）。
   * @param {FramebufferPassStyle} partial
   */
  setStyle(partial) {
    if (this._destroyed) return
    if (partial.background) {
      this._style.background = [...partial.background]
    }
    if (partial.tint) {
      this._style.tint = [...partial.tint]
    }
    if (partial.opacity !== undefined) {
      this._style.opacity = partial.opacity
    }
    if (partial.defaultFillColor) {
      this._style.defaultFillColor = [...partial.defaultFillColor]
    }
  }

  /** @returns {Readonly<FramebufferPassStyle>} */
  getStyle() {
    return {
      background: [...this._style.background],
      tint: [...this._style.tint],
      opacity: this._style.opacity,
      defaultFillColor: [...this._style.defaultFillColor]
    }
  }

  /**
   * 设置本 pass 要光栅化的几何列表；**DrawCommand 由 {@link #render} 根据这些 Geometry + 样式生成**。
   * @param {FramebufferGeometryEntry[]} entries
   */
  setGeometries(entries) {
    if (this._destroyed) return
    this._geometryEntries = entries ?? []
  }

  /** @returns {ReadonlyArray<FramebufferGeometryEntry>} */
  getGeometries() {
    return this._geometryEntries
  }

  /**
   * 根据当前 `setStyle` / `setGeometries` 重建 GPU 命令序列。
   */
  render() {
    if (this._destroyed) return

    const prev = this._gpuCommands
    this._gpuCommands = []
    destroyDrawCommandVertexArrays(prev)

    const context = this._context
    const w = this._width
    const h = this._height
    const viewport = new Cesium.BoundingRectangle(0, 0, w, h)

    const clearRenderState = Cesium.RenderState.fromCache({
      viewport,
      depthTest: { enabled: false },
      depthMask: false
    })

    const bg = this._style.background
    const clearColor = new Cesium.Color(bg[0], bg[1], bg[2], bg[3])
    const clearCmd = new Cesium.ClearCommand({
      color: clearColor,
      framebuffer: this._framebuffer,
      renderState: clearRenderState,
      pass: this._pass,
      owner: this
    })
    this._gpuCommands.push(clearCmd)

    const drawRenderState = Cesium.RenderState.fromCache({
      viewport,
      depthTest: { enabled: false },
      depthMask: false,
      blending: Cesium.BlendingState.DISABLED,
      cull: { enabled: false }
    })

    const t = this._style.tint
    const tintColor = new Cesium.Color(t[0], t[1], t[2], t[3])
    const opacity = this._style.opacity
    const def = this._style.defaultFillColor

    for (const entry of this._geometryEntries) {
      const raw = entry.geometry
      if (!raw || !raw.attributes?.position) continue

      const posAttr = raw.attributes.position
      if (
        posAttr.componentsPerAttribute !== 2 ||
        posAttr.componentDatatype !== Cesium.ComponentDatatype.FLOAT
      ) {
        continue
      }

      const n = Cesium.Geometry.computeNumberOfVertices(raw)
      const prim = raw.primitiveType ?? Cesium.PrimitiveType.TRIANGLES
      const minVerts =
        prim === Cesium.PrimitiveType.LINE_STRIP ||
        prim === Cesium.PrimitiveType.LINES
          ? 2
          : prim === Cesium.PrimitiveType.LINE_LOOP
            ? 3
            : 3
      if (n < minVerts) continue

      const rgba = entry.color ?? def
      const drawColor = new Cesium.Color(rgba[0], rgba[1], rgba[2], rgba[3])

      const self = this
      const uniformMap = {
        u_tint() {
          return tintColor
        },
        u_opacity() {
          return opacity
        },
        u_drawColor() {
          return drawColor
        },
        u_fboSize() {
          return Cesium.Cartesian2.fromElements(
            self._width,
            self._height,
            self._scratchFboSize
          )
        },
        u_pixelCoords() {
          return self._usePixelSpace ? 1.0 : 0.0
        }
      }

      const geometry = geometryWithBoundingSphere(raw, this._fallbackBs)

      const vertexArray = Cesium.VertexArray.fromGeometry({
        context,
        geometry,
        attributeLocations: ATTRIBUTE_LOCATIONS,
        bufferUsage: Cesium.BufferUsage.STREAM_DRAW
      })

      const drawCommand = new Cesium.DrawCommand({
        vertexArray,
        primitiveType: prim,
        renderState: drawRenderState,
        shaderProgram: this._shaderProgram,
        uniformMap,
        framebuffer: this._framebuffer,
        pass: this._pass,
        owner: this
      })
      drawCommand.cull = false
      drawCommand.occlude = false

      this._gpuCommands.push(drawCommand)
    }
  }

  /**
   * @param {Cesium.FrameState} frameState
   */
  pushCommands(frameState) {
    if (this._destroyed || !this._gpuCommands.length) return
    const list = frameState.commandList
    const cmds = this._gpuCommands
    for (let i = 0; i < cmds.length; i++) {
      list.push(cmds[i])
    }
  }

  /**
   * 立即执行当前 `_gpuCommands`（不经 frameState.commandList）。
   * Cesium 每帧重建 commandList；离屏 FBO 若只在 rebuild 时 push，后续帧可能无法正确维持与贴图采样顺序，故在内容更新后直接 execute。
   * @param {Cesium.Context} context
   * @param {Cesium.PassState} [passState]
   */
  executeCommands(context, passState) {
    if (this._destroyed || !this._gpuCommands.length) return
    const cmds = this._gpuCommands
    for (let i = 0; i < cmds.length; i++) {
      cmds[i].execute(context, passState)
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    destroyDrawCommandVertexArrays(this._gpuCommands)
    this._gpuCommands = []
    this._framebuffer.destroy()
    this._colorTexture.destroy()
  }
}
