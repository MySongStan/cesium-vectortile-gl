import { defineConfig } from 'vite'
import * as path from 'path'
import license from 'vite-plugin-license'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'Source')
    }
  },
  define: {
    'process.env': {}
  },
  build: {
    outDir: './dist',
    lib: {
      entry: path.resolve(__dirname, 'index.js'),
      name: 'CVT',
      fileName(format) {
        if (format == 'es') {
          return 'cvt-gl.js'
        } else {
          return 'cvt-gl.min.js'
        }
      }
    },
    sourcemap: true
  },
  esbuild: {
    drop: ['debugger']
  },
  plugins: [
    license({
      thirdParty: {
        output: './dist/THIRD-PARTY-LICENSES.txt'
      }
    })
  ]
})
