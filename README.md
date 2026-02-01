### 🌍 **cesium-vectortile-gl**

**cesium-vectortile-gl** 是专为 **CesiumJS** 设计的开源矢量瓦片渲染库。原生 Primitive 实现，**不依赖 ImageryProvider 和 第三方矢量瓦片渲染器**，支持 MLT/MVT/PBF 与 GeoJSON，兼容 MapLibre 样式规范，可渲染线/面/文字，支持虚线、贴地、合批优化与 GPU 剔除。

#### ✨ 核心特性

- ✅ **原生 Cesium 渲染**：使用 `Primitive`、`PolylineGeometry` 和自定义 `Appearance`，深度集成 Cesium 渲染管线
- ✅ **多源支持**：加载 **MLT/MVT (PBF)** 矢量瓦片 或 **GeoJSON** 数据（通过 `geojson-vt` 动态切片）
- ✅ **MapLibre 样式兼容**：完整解析 `maplibre-gl-style-spec` 的样式表达式（颜色、透明度、线型、文本等）
- ✅ **丰富图层类型**：支持 `background` / `fill` / `line` / `symbol` 四大基础图层，含**虚线**（`line-dasharray`）、本地字体、文字大小、显隐控制
- ✅ **三维场景融合**：可与 `Entity`、`Model`、贴地线/面等 Cesium 对象共存，实现真三维 GIS 可视化
- ✅ **高性能渲染**：按图层合批构建几何体，通过 `DrawCommand` 的 `offset/count` 复用 buffer，显著提升帧率
- ✅ **GPU 精准剔除**：利用 FBO + RTT 技术生成瓦片 ID 纹理，在 GPU 中高效剔除不可见矢量片段
- ✅ **高度可扩展**：提供清晰接口，轻松接入新数据源（如 TopoJSON）或自定义图层类型（如热力图、流线）
- ✅ **文字符号自动避让**：使用 `maplibre-gl` `GridIndex`类，结合 Cesium.Label 屏幕空间位置和包围盒计算API，实现符号碰撞检测（自动避让）

#### 🧠 技术栈亮点

- 解析：`@mapbox/vector-tile` + `maplibre-gl` + `@maplibre/vt-pbf`
- 切片：`geojson-vt`
- 样式：`@maplibre/maplibre-gl-style-spec`
- 投影与细分：复用 `maplibre-gl` 的线/面投影逻辑
- 文字渲染：`Cesium.LabelCollection`
- 渲染优化：自定义 `Appearance` + 合批 `DrawCommand` + GPU 剔除

---

> 📦 **Apache-2.0 许可证 · 欢迎贡献 · 由 [mesh-3d](https://github.com/mesh-3d) 社区维护** · **QQ交流群 1064447844**

---

#### 📜 许可证变更：MIT → Apache License 2.0

从 **0.3.0 版本**起，本项目已将许可证由 **MIT 许可证** 更改为 **Apache License 2.0**。

此次变更旨在：

- 为贡献者和用户提供明确的**专利授权与保护**，
- 对**商业使用和再分发**提供更清晰的法律条款，
- 与相关地理空间项目（如 CesiumJS）的许可策略保持一致。

Apache 2.0 仍是一个**宽松且对商业友好的许可证**——您依然可以自由地使用、修改和分发本软件（包括用于专有产品），只需保留原始版权声明和免责声明即可。

本次变更后的新贡献均遵循 Apache 2.0 条款。此前发布的版本（MIT 许可）仍按其原始许可证条款继续有效。

详情请参见 [LICENSE](./LICENSE.md) 文件。

## 构建

安装 vite 等开发依赖项

```shell
npm install --save-dev
```

然后可以运行构建命令

```shell
npm run build
```

源码调试

```shell
npm run dev
```

## 安装

```shell
npm install @mesh3d/cesium-vectortile-gl
```

## 使用

```js
import { VectorTileset } from '@mesh3d/cesium-vectortile-gl'

const tileset = new VectorTileset({
  style: '/assets/demotiles/style.json'
})

viewer.scene.primitives.add(tileset)
```

**注意**：请确保通过`window.Cesium`能够访问到可用的 Cesium 包，例如：

```js
import * as Cesium from 'cesium'
window.Cesium = Cesium
```

或者在 html 中通过`script`标签引入 Cesium.js，例如

```html
<script src="libs/cesium/Build/CesiumUnminified/Cesium.js"></script>
```

## 扩展

可以通过实现统一的接口，对图层类型和数据源类型两大模块的进行自定义扩展，以支持更多 Maplibre 规范的数据源类型和图层样式。

#### 扩展图层类型

扩展支持新的图层类型，有两种方式：

- **简单扩展** 只扩展**渲染图层类**，通过继承和重写关键方法的方式实现**IRenderLayer**接口，每个图层对应一个渲染图元（Primitive），这种方式适合确定图层实例极少的情况，是否复用缓冲区对性能的影响不大，可以参考 background 图层渲染类**BackgroundRenderLayer**实现；

- **高级扩展** 扩展**渲染图层类**和**图层渲染器**，实现**IRenderLayer**和**ILayerVisualizer**接口。**图层渲染器**负责瓦片内指定类型图层的合批几何体、批次表、绘图命令（DrawCommand）的构建，以及图层 DrawCommand 浅拷贝副本（shallow clone）的分配；**渲染图层类**只负责更新图层状态（例如同步图层样式）。如果图层实例数量不确定或者很大，每个图层实例独占一个顶点缓冲区和索引缓冲区，性能损耗将很大，**应该**采用这种方式进行扩展，确保**流畅渲染**。可以参考**FillRenderLayer**和**FillLayerVisualizer**的实现。

编写扩展类后，通过如下方式注册：

```js
import { registerRenderLayer } from '@mesh3d/cesium-vectortile-gl'
//简单扩展
registerRenderLayer('layerType', XXXRenderLayer)

//高级扩展
registerRenderLayer('fill', FillRenderLayer, FillLayerVisualizer)
```

- `第一个参数`为图层类型名称，如 circle，**必选**
- `第二个参数`为图层渲染类，**必选**
- `第三个参数`为图层渲染器类，**可选**，仅注册高级扩展时需要传递

#### 扩展数据源类型

数据类型的扩展采用面向接口，只需要按`ISource`的约定编写必须实现的方法（init、requestTile）即可。

- **constructor(styleSource, path = '')** 构造函数，第一个参数接收数据源配置，第二个参数接收样式路径（如果 style 传入 url 的话），可以用于支持相对路径
- **init** 初始化数据源
- **requestTile** 请求瓦片，异步返回 @mapbox/vector-tile 的 VectorTile 类型或者与该类具有一致接口的类型
- **destroy** 销毁实例，释放内部创建的资源

编写扩展类后，通过如下方式注册：

```js
import { registerSource } from '@mesh3d/cesium-vectortile-gl'

registerSource('sourceType', XXXSource)
```

- `第一个参数`为数据源类型名称，如 raster，**必选**
- `第二个参数`为数据源类，**必选**

## 依赖

本项目依赖：

- [@mapbox/vector-tile](https://github.com/mapbox/vector-tile-js)(BSD-3-Clause)
- [@maplibre/maplibre-gl-style-spec](https://github.com/maplibre/maplibre-style-spec)(ISC)
- [@maplibre/vt-pbf](https://github.com/maplibre/vt-pbf)(MIT)
- [geojson-vt](https://github.com/mapbox/geojson-vt)(ISC)
- [maplibre-gl](https://github.com/maplibre/maplibre-gl-js)(BSD-3-Clause)
- [pbf](https://github.com/mapbox/pbf)(BSD-3-Clause)

## 相关项目

- [CesiumVectorTile](https://github.com/MikesWei/CesiumVectorTile) - 基于 ImageryProvider 的轻量版
- [Mesh-3D](http://mesh-3d.com) - 企业级 Web3D 引擎（提供商业支持和高级功能）

更多技术文章及案例，敬请关注微信公众号【**Mesh-3D**】
![Mesh-3D微信公众号](http://www.mesh-3d.com/articles/微信公众号【Mesh-3D】.png)

## 效果图

![效果图1](http://www.mesh-3d.com/cvt-gl/assets/images/screenshot.jpg)
![效果图2](http://www.mesh-3d.com/cvt-gl/assets/images/screenshot2.jpg)
