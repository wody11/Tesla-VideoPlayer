import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';

export default {
  input: 'src/worker/index.ts',
  output: {
    dir: 'dist',
    format: 'es',
    sourcemap: true,
    entryFileNames: '[name].js'
  },
  plugins: [
    resolve({ browser: true }),
    commonjs(),
  typescript({ tsconfig: './tsconfig.json', clean: true })
  ]
};
