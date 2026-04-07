/**
 * FramebufferTrianglePass 离屏渲染 → FBO 纹理贴到单个贴地矩形（GroundPrimitive）。
 * 开发：npm run dev 后打开 /fbo-material-rectangle.html
 */
import { FramebufferTrianglePass } from '../index.js'

const viewer = new Cesium.Viewer(document.body, {
  creditContainer: document.createElement('div'),
  scene3DOnly: true,
  infoBox: false
})
viewer.resolutionScale = devicePixelRatio
viewer.scene.globe.depthTestAgainstTerrain = false

/** 贴图用的单块贴地矩形（与 FBO 一一对应，UV 0–1 只铺这一张面） */
const textureRectangle = Cesium.Rectangle.fromDegrees(-100.2, 33.2, -96.8, 35.8)

const texturedVF = Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat

/** FBO 分辨率；顶点用像素坐标时与几何里的范围一致 */
const fboW = 512
const fboH = 512
// FBO 默认 Pass.GLOBE，须早于 GroundPrimitive 的 TERRAIN_CLASSIFICATION；勿用 OPAQUE（会整片发黑）
const fboPass = new FramebufferTrianglePass({
  context: viewer.scene.context,
  width: fboW,
  height: fboH,
  /** 顶点 position 为 FBO 像素（左上原点、y 向下），着色器内除以 width/height 映射到裁剪空间 */
  vertexPositionSpace: 'pixel'
})

/** 参数曲线心形（数学坐标 y 向上，尖朝下） */
const HEART_SEG = 160
function heartMath(t) {
  const sx = Math.sin(t)
  return {
    x: 16 * sx * sx * sx,
    y:
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t)
  }
}

function sampleHeartRing() {
  const pts = []
  for (let i = 0; i < HEART_SEG; i++) {
    const t = (i / HEART_SEG) * Cesium.Math.TWO_PI
    pts.push(heartMath(t))
  }
  return pts
}

function heartBBox(pts) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 将心形环映射到 FBO 像素矩形 [pxLeft, pxRight]×[pxTop, pxBottom]（左上原点，y 向下）。
 */
function heartRingToPixelRect(pts, pxLeft, pxRight, pxTop, pxBottom, pad = 4) {
  const { minX, minY, maxX, maxY } = heartBBox(pts)
  const w = maxX - minX || 1
  const h = maxY - minY || 1
  const uA = pxLeft + pad
  const uB = pxRight - pad
  const vA = pxTop + pad
  const vB = pxBottom - pad
  const flat = new Float32Array(pts.length * 2)
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const nx = (p.x - minX) / w
    const nv = (maxY - p.y) / h
    flat[i * 2] = uA + nx * (uB - uA)
    flat[i * 2 + 1] = vA + nv * (vB - vA)
  }
  return flat
}

function reverseUvRing(flat) {
  const n = flat.length / 2
  const out = new Float32Array(flat.length)
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i
    out[i * 2] = flat[j * 2]
    out[i * 2 + 1] = flat[j * 2 + 1]
  }
  return out
}

/** 右半：心形三角网（earcut），顶点为像素坐标 */
function buildHeartFillGeometry(pixelFlat) {
  const n = pixelFlat.length / 2
  const positions2D = []
  for (let i = 0; i < n; i++) {
    positions2D.push(new Cesium.Cartesian2(pixelFlat[i * 2], pixelFlat[i * 2 + 1]))
  }
  let flat = pixelFlat
  let tri
  try {
    tri = Cesium.PolygonPipeline.triangulate(positions2D)
  } catch {
    flat = reverseUvRing(pixelFlat)
    positions2D.length = 0
    for (let i = 0; i < n; i++) {
      positions2D.push(new Cesium.Cartesian2(flat[i * 2], flat[i * 2 + 1]))
    }
    tri = Cesium.PolygonPipeline.triangulate(positions2D)
  }
  return FramebufferTrianglePass.createPixelTriangleGeometry(flat, new Uint16Array(tri))
}

const heartRing = sampleHeartRing()
// 左半像素区：线框；右半：填充（与 fboW 同量级，例如 0…256）
const midX = fboW * 0.5
const heartLinePx = heartRingToPixelRect(heartRing, 2, midX - 4, 6, fboH - 6)
const heartFillPx = heartRingToPixelRect(heartRing, midX + 4, fboW - 2, 6, fboH - 6)
/** 心形轮廓：像素线宽要够粗，否则贴地缩小 + 双线性采样会像断点；FBO 纹理已用 NEAREST */
const HEART_LINE_WIDTH_PX = 14
const heartLineGeom = FramebufferTrianglePass.createPixelWideLineLoopGeometry(
  heartLinePx,
  HEART_LINE_WIDTH_PX,
  { miterLimit: 4 }
)
const heartFillGeom = buildHeartFillGeometry(heartFillPx)

/** 配色 A：左线 / 右面 */
const paletteA = {
  line: [1, 0.35, 0.55, 1],
  fill: [0.95, 0.2, 0.35, 1]
}
const paletteB = {
  line: [0.4, 0.95, 1, 1],
  fill: [0.25, 0.55, 1, 1]
}

fboPass.setGeometries([
  { geometry: heartFillGeom, color: paletteA.fill },
  { geometry: heartLineGeom, color: paletteA.line }
])
fboPass.setStyle({
  background: [0.02, 0.02, 0.06, 0.0],
  tint: [1, 1, 1, 1],
  opacity: 1,
  defaultFillColor: [1, 1, 1, 1]
})
fboPass.render()

/**
 * 每帧把 FBO 的 ClearCommand + DrawCommand 塞进 frameState.commandList。
 * GroundPrimitive 走 TERRAIN_CLASSIFICATION，早于 OPAQUE；FBO 须用默认 GLOBE（或同序更早的 pass），否则会先采样后写入、整片发黑。
 */
const fboCommandInjector = {
  update(frameState) {
    fboPass.pushCommands(frameState)
  },
  isDestroyed() {
    return false
  },
  destroy() {}
}

/** 用构造函数传入 NEAREST，避免 fromType 默认 LINEAR；贴地时与 FBO 纹理采样一致 */
const tileMaterial =  Cesium.Material.fromType('Image', {
  image: fboPass.colorTexture,
  repeat: new Cesium.Cartesian2(1, 1),
  color: new Cesium.Color(1, 1, 1, 1)
})

const groundPrim = new Cesium.GroundPrimitive({
  geometryInstances: new Cesium.GeometryInstance({
    id: 'fbo-texture-rect',
    geometry: new Cesium.RectangleGeometry({
      rectangle: textureRectangle,
      vertexFormat: texturedVF
    })
  }),
  appearance: new Cesium.MaterialAppearance({
    material: tileMaterial,
    /** 不透明贴图走非半透明路径，避免地形分类里把边缘「洗」成细线 */
    translucent: false,
    flat: true,
    faceForward: true,
    materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED
  }),
  asynchronous: true,
  releaseGeometryInstances: true
})

viewer.scene.primitives.add(fboCommandInjector)
viewer.scene.primitives.add(groundPrim)

viewer.camera.flyTo({ destination: textureRectangle })

const hud = document.createElement('div')
hud.style.cssText =
  'position:absolute;left:8px;top:8px;z-index:999;background:rgba(0,0,0,.75);color:#eee;font:12px/1.45 system-ui,sans-serif;padding:10px 12px;max-width:420px;border-radius:6px;'
hud.innerHTML = [
  '<div><b>FBO → 纹理 → GroundPrimitive（单矩形）</b></div>',
  '<div>顶点为 <b>FBO 像素坐标</b>（0…' +
    fboW +
    '），非 0–1；映射在顶点着色器里用 <code>u_fboSize</code> 完成，无需改 DrawCommand。</div>',
  '<div><b>左半</b>线框（约 ' +
    HEART_LINE_WIDTH_PX +
    'px）· <b>右半</b>填充。材质 <b>NEAREST</b> + 贴地 <b>translucent:false</b>，避免细线被滤没。</div>',
  '<div style="margin-top:8px"><button type="button" id="btn-swap">切换心形配色</button></div>'
].join('')
document.body.appendChild(hud)

let swap = false
hud.querySelector('#btn-swap')?.addEventListener('click', () => {
  swap = !swap
  const pal = swap ? paletteB : paletteA
  fboPass.setGeometries([
    { geometry: heartFillGeom, color: pal.fill },
    { geometry: heartLineGeom, color: pal.line }
  ])
  fboPass.setStyle({
    background: swap ? [0.04, 0.03, 0.08, 1] : [0.02, 0.02, 0.06, 1],
    tint: [1, 1, 1, 1]
  })
  fboPass.render()
  viewer.scene.requestRender()
})

window.fboPass = fboPass
window.viewer = viewer
