const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vendor', 'jessibuca-runtime');
const dest = path.join(root, 'dist');

for (const name of ['jessibuca.js', 'decoder.js', 'decoder.wasm']) {
  const from = path.join(source, name);
  const to = path.join(dest, name);
  if (!fs.existsSync(from)) {
    throw new Error(`Jessibuca runtime asset missing: ${from}`);
  }
  fs.copyFileSync(from, to);
}

const h265Runtime = path.join(root, 'vendor', 'h265webjs', 'dist', 'h265webjs.js');
if (fs.existsSync(h265Runtime)) {
  fs.copyFileSync(h265Runtime, path.join(dest, 'h265webjs.js'));
}
