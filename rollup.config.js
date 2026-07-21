import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default {
  input: {
    index: 'src/index.ts',
    'worker-entry': 'src/worker/worker-entry.ts'
  },
  output: {
    dir: 'dist',
    format: 'es',
    sourcemap: true,
    entryFileNames: '[name].js'
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.json' }),
    resolve({ browser: true }),
    commonjs()
  ]
};
