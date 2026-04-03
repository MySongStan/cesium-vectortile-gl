/**
 * 多 Worker 池：与 [VectorTileWorker.js](./VectorTileWorker.js) 相同消息协议
 * `{ id, parameters }` → `{ id, result }`（result.error 表示失败），支持 transferList。
 * 空闲 Worker 不足时在主线程排队，始终返回 Promise（不再出现 undefined）。
 */
export class VectorTileWorkerPool {
  /**
   * @param {string} workerUrl - Worker 脚本 URL（如 dist/cvt-gl-worker.js）
   * @param {number} [poolSize=4] - 并行 Worker 数量
   */
  constructor(workerUrl, poolSize = 4) {
    this._workerUrl = workerUrl
    this._poolSize = Math.max(1, poolSize | 0)
    /** @type {Worker[]} */
    this._idle = []
    /** @type {Worker[]} */
    this._all = []
    this._nextId = 1
    /** @type {Map<number, { resolve: function, reject: function, worker: Worker }>} */
    this._pending = new Map()
    /** @type {Array<{ parameters: object, transferList: ArrayBuffer[], resolve: function, reject: function }>} */
    this._queue = []
    this._destroyed = false

    for (let i = 0; i < this._poolSize; i++) {
      const w = this._createWorker()
      this._all.push(w)
      this._idle.push(w)
    }
  }

  _createWorker() {
    const w = new Worker(this._workerUrl)
    w.onmessage = e => this._onWorkerMessage(w, e)
    w.onerror = err => this._onWorkerError(w, err)
    return w
  }

  /**
   * @param {object} parameters - processTileTask 参数
   * @param {ArrayBuffer[]} [transferList]
   * @returns {Promise<object>}
   */
  schedule(parameters, transferList) {
    if (this._destroyed) {
      return Promise.reject(new Error('VectorTileWorkerPool is destroyed'))
    }
    return new Promise((resolve, reject) => {
      const task = { parameters, transferList: transferList || [], resolve, reject }
      if (this._idle.length > 0) {
        this._dispatch(task, this._idle.pop())
      } else {
        this._queue.push(task)
      }
    })
  }

  _dispatch(task, worker) {
    if (this._destroyed) {
      task.reject(new Error('VectorTileWorkerPool is destroyed'))
      return
    }
    const id = this._nextId++
    this._pending.set(id, {
      resolve: task.resolve,
      reject: task.reject,
      worker
    })
    const tl = task.transferList.slice()
    worker.postMessage({ id, parameters: task.parameters }, tl)
  }

  _onWorkerMessage(worker, e) {
    if (this._destroyed) return
    const { id, result } = e.data
    const entry = this._pending.get(id)
    if (!entry) return
    this._pending.delete(id)
    const { resolve, reject } = entry
    if (result && result.error) {
      reject(new Error(result.error))
    } else {
      resolve(result)
    }
    this._releaseWorker(worker)
  }

  _onWorkerError(worker, err) {
    if (this._destroyed) return
    for (const [id, entry] of this._pending) {
      if (entry.worker === worker) {
        this._pending.delete(id)
        entry.reject(
          new Error(
            err && err.message ? err.message : String(err && err.error || err)
          )
        )
        break
      }
    }
    try {
      worker.terminate()
    } catch (_) {}
    const idx = this._all.indexOf(worker)
    if (idx >= 0) this._all.splice(idx, 1)
    const idleIdx = this._idle.indexOf(worker)
    if (idleIdx >= 0) this._idle.splice(idleIdx, 1)
    if (!this._destroyed && this._all.length < this._poolSize) {
      const w = this._createWorker()
      this._all.push(w)
      this._idle.push(w)
      this._pumpQueue()
    }
  }

  _releaseWorker(worker) {
    if (this._destroyed) return
    if (this._queue.length > 0) {
      const task = this._queue.shift()
      this._dispatch(task, worker)
    } else {
      this._idle.push(worker)
    }
  }

  _pumpQueue() {
    while (this._queue.length > 0 && this._idle.length > 0) {
      const task = this._queue.shift()
      this._dispatch(task, this._idle.pop())
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    for (const task of this._queue) {
      task.reject(new Error('VectorTileWorkerPool is destroyed'))
    }
    this._queue.length = 0
    for (const [, entry] of this._pending) {
      entry.reject(new Error('VectorTileWorkerPool is destroyed'))
    }
    this._pending.clear()
    for (const w of this._all) {
      try {
        w.terminate()
      } catch (_) {}
    }
    this._all.length = 0
    this._idle.length = 0
  }

  isDestroyed() {
    return this._destroyed
  }
}
