import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'demo/entry/main-entry.ts',
  output: {
    file: 'demo/main-app.js',
    format: 'es',
    sourcemap: true
  },
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    typescript({
      tsconfig: false,
      target: 'ES2020',
      module: 'ESNext',
      lib: ['DOM', 'ES2020', 'WebWorker'],
      sourceMap: true,
      rootDir: '.',
      include: ['src/**/*.ts', 'demo/**/*.ts'],
      exclude: ['**/*.test.ts']
    })
  ]
};