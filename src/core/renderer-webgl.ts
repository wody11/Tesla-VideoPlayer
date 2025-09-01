// WebGL renderer with basic color-space awareness and limited->full mapping.
// - Uses createImageBitmap(frame) + WebGL texture upload for portability.
// - Applies a simple BT.709/BT.601 selection and an optional limited->full mapping in the fragment shader.
// - If OffscreenCanvas is available, attempts to offload rendering to a Worker by transferring an OffscreenCanvas.
export class RendererWebGL {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private uApplyLimitedToFullLoc: WebGLUniformLocation | null = null;
  private uPrimariesLoc: WebGLUniformLocation | null = null; // 0=BT.601, 1=BT.709
  private useOffscreen: boolean = false;
  private worker?: Worker;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // If OffscreenCanvas is supported, try to create a worker-based renderer.
    try {
      if ((canvas as any).transferControlToOffscreen && typeof Worker !== 'undefined') {
        // Create an offscreen canvas and spawn a worker with a small runtime script.
        try {
          const off = (canvas as any).transferControlToOffscreen();
          const workerSrc = `
            self.onmessage = async (ev) => {
              const msg = ev.data || {};
              if (msg.type === 'init') {
                self.canvas = msg.canvas;
                self.canvas.width = msg.w; self.canvas.height = msg.h;
                const gl = self.canvas.getContext('webgl');
                // Simple passthrough shader on worker; do minimal processing here to keep logic centralised.
                // We'll just draw the incoming bitmap onto the canvas using WebGL texImage2D + shader that supports limited->full.
                // Create program
                const vs = '\\nattribute vec2 aPos; varying vec2 vUV; void main() { vUV = (aPos+1.0)*0.5; gl_Position = vec4(aPos,0.0,1.0); }';
                // Fragment shader: Sample RGBA, if limited-range flag set, convert RGB->YCbCr (601/709),
                // expand limited->full on Y, Cb, Cr (Y: 16..235, C: 16..240), then convert back to RGB.
                const fs = '\\nprecision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform int uApplyLimited; uniform int uPrimaries; \\\n+                  vec3 rgb2ycbcr709(vec3 rgb){ float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722)); float u = (rgb.b - y) / 1.8556; float v = (rgb.r - y) / 1.5748; return vec3(y, u + 0.5, v + 0.5); } \\\n+                  vec3 ycbcr2rgb709(vec3 yuv){ float y = yuv.x; float u = yuv.y - 0.5; float v = yuv.z - 0.5; float r = y + 1.5748*v; float g = y - 0.1873*u - 0.4681*v; float b = y + 1.8556*u; return vec3(r,g,b); } \\\n+                  vec3 rgb2ycbcr601(vec3 rgb){ float y = dot(rgb, vec3(0.299, 0.587, 0.114)); float u = (rgb.b - y) / 1.772; float v = (rgb.r - y) / 1.402; return vec3(y, u + 0.5, v + 0.5); } \\\n+                  vec3 ycbcr2rgb601(vec3 yuv){ float y = yuv.x; float u = yuv.y - 0.5; float v = yuv.z - 0.5; float r = y + 1.402*v; float g = y - 0.344136*u - 0.714136*v; float b = y + 1.772*u; return vec3(r,g,b); } \\\n+                  vec3 expandLimited(vec3 yuv){ float y = clamp((yuv.x - 16.0/255.0) * (255.0/(235.0-16.0)), 0.0, 1.0); float cScale = 255.0/(240.0-16.0); float u = clamp((yuv.y - 16.0/255.0) * cScale, 0.0, 1.0); float v = clamp((yuv.z - 16.0/255.0) * cScale, 0.0, 1.0); return vec3(y,u,v); } \\\n+                  void main(){ vec4 c = texture2D(uTex, vUV); if(uApplyLimited!=0){ vec3 yuv = (uPrimaries==1) ? rgb2ycbcr709(c.rgb) : rgb2ycbcr601(c.rgb); yuv = expandLimited(yuv); vec3 rgb = (uPrimaries==1) ? ycbcr2rgb709(yuv) : ycbcr2rgb601(yuv); gl_FragColor = vec4(clamp(rgb,0.0,1.0), c.a); } else { gl_FragColor = c; } }';
                function compile(gl, src, type){ const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
                const vsh = compile(gl, vs, gl.VERTEX_SHADER); const fsh = compile(gl, fs, gl.FRAGMENT_SHADER);
                const prog = gl.createProgram(); gl.attachShader(prog, vsh); gl.attachShader(prog, fsh); gl.linkProgram(prog);
                gl.useProgram(prog);
                const aPos = gl.getAttribLocation(prog, 'aPos'); const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
                gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
                const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                const uApply = gl.getUniformLocation(prog, 'uApplyLimited');
                const uPrim = gl.getUniformLocation(prog, 'uPrimaries');
                self._gl = gl; self._prog = prog; self._tex = tex; self._uApply = uApply; self._uPrim = uPrim;
              } else if (msg.type === 'frame') {
                try {
                  const bitmap = msg.bitmap;
                  const applyLimited = msg.applyLimited ? 1 : 0;
                  const uPrimaries = msg.uPrimaries | 0;
                  const gl = self._gl;
                  if (!gl) return;
                  gl.bindTexture(gl.TEXTURE_2D, self._tex);
                  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap); } catch(e) { try{ gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA, bitmap.width, bitmap.height,0,gl.RGBA,gl.UNSIGNED_BYTE, null);}catch{} }
                  gl.viewport(0,0,self.canvas.width,self.canvas.height);
                  gl.useProgram(self._prog);
                  gl.uniform1i(self._uApply, applyLimited);
                  gl.uniform1i(self._uPrim, uPrimaries);
                  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                  bitmap.close();
                } catch(e){}
              }
            };
          `;
          const blob = new Blob([workerSrc], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          this.worker = new Worker(url);
          // send init
          this.worker.postMessage({ type: 'init', canvas: off, w: canvas.width || 640, h: canvas.height || 480 }, [off]);
          this.useOffscreen = true;
          return;
        } catch (e) {
          // fallback to in-thread renderer
        }
      }
    } catch {}

    // Main-thread GL init
    try {
      this.gl = canvas.getContext('webgl');
      if (!this.gl) throw new Error('no webgl');
      const gl = this.gl;
      const vsSrc = `attribute vec2 aPos; varying vec2 vUV; void main(){ vUV = (aPos+1.0)*0.5; gl_Position = vec4(aPos,0.0,1.0); }`;
      const fsSrc = `precision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform int uApplyLimited; uniform int uPrimaries;
        vec3 rgb2ycbcr709(vec3 rgb){ float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722)); float u = (rgb.b - y) / 1.8556; float v = (rgb.r - y) / 1.5748; return vec3(y, u + 0.5, v + 0.5); }
        vec3 ycbcr2rgb709(vec3 yuv){ float y = yuv.x; float u = yuv.y - 0.5; float v = yuv.z - 0.5; return vec3(y + 1.5748*v, y - 0.1873*u - 0.4681*v, y + 1.8556*u); }
        vec3 rgb2ycbcr601(vec3 rgb){ float y = dot(rgb, vec3(0.299, 0.587, 0.114)); float u = (rgb.b - y) / 1.772; float v = (rgb.r - y) / 1.402; return vec3(y, u + 0.5, v + 0.5); }
        vec3 ycbcr2rgb601(vec3 yuv){ float y = yuv.x; float u = yuv.y - 0.5; float v = yuv.z - 0.5; return vec3(y + 1.402*v, y - 0.344136*u - 0.714136*v, y + 1.772*u); }
        vec3 expandLimited(vec3 yuv){ float y = clamp((yuv.x - 16.0/255.0) * (255.0/(235.0-16.0)), 0.0, 1.0); float cScale = 255.0/(240.0-16.0); float u = clamp((yuv.y - 16.0/255.0) * cScale, 0.0, 1.0); float v = clamp((yuv.z - 16.0/255.0) * cScale, 0.0, 1.0); return vec3(y,u,v); }
        void main(){ vec4 c = texture2D(uTex, vUV); if (uApplyLimited != 0) { vec3 yuv = (uPrimaries==1) ? rgb2ycbcr709(c.rgb) : rgb2ycbcr601(c.rgb); yuv = expandLimited(yuv); vec3 rgb = (uPrimaries==1) ? ycbcr2rgb709(yuv) : ycbcr2rgb601(yuv); gl_FragColor = vec4(clamp(rgb,0.0,1.0), c.a); } else { gl_FragColor = c; } }`;
      const compile = (src: string, type: number) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const vsh = compile(vsSrc, gl.VERTEX_SHADER); const fsh = compile(fsSrc, gl.FRAGMENT_SHADER);
      const prog = gl.createProgram()!; gl.attachShader(prog, vsh); gl.attachShader(prog, fsh); gl.linkProgram(prog);
      this.program = prog;
      this.positionBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.useProgram(this.program);
      const aPos = gl.getAttribLocation(this.program, 'aPos'); gl.enableVertexAttribArray(aPos); gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  this.uApplyLimitedToFullLoc = gl.getUniformLocation(this.program, 'uApplyLimited');
  this.uPrimariesLoc = gl.getUniformLocation(this.program, 'uPrimaries');
    } catch (e) {
      // fail silently; will fallback to canvas 2d path in draw
      this.gl = null;
    }
  }

  // draw VideoFrame/ImageBitmap via WebGL (or offscreen worker). Applies limited->full mapping when requested.
  async draw(frame: ImageBitmap | HTMLCanvasElement | VideoFrame) {
    try {
    const cs: any = (frame as any)?.colorSpace || {};
    const applyLimited = cs?.fullRange === false || cs?.range === 'limited';
    // 0=bt601, 1=bt709
    const primaries = (cs?.primaries === 'bt709' || cs?.primaries === 'bt2020') ? 1 : 0;
      if (this.useOffscreen && this.worker) {
        // transfer an ImageBitmap to worker
        try {
          const bmp = await createImageBitmap(frame as any);
      this.worker.postMessage({ type: 'frame', bitmap: bmp, applyLimited: !!applyLimited, uPrimaries: primaries }, [bmp]);
          return;
        } catch (e) { /* fallback to local */ }
      }

      if (!this.gl) {
        // fallback to 2D drawImage
        try { const ctx = this.canvas.getContext('2d'); if (ctx) ctx.drawImage(frame as any, 0, 0, this.canvas.width, this.canvas.height); return; } catch {}
      }
      const gl = this.gl as WebGLRenderingContext;
      // ensure canvas size
  const cw = ((frame && (frame as any).codedWidth) ?? (frame as any).displayWidth ?? (frame as any).width) || this.canvas.width;
  const ch = ((frame && (frame as any).codedHeight) ?? (frame as any).displayHeight ?? (frame as any).height) || this.canvas.height;
      if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
      // upload via ImageBitmap for compatibility
      const bmp = await createImageBitmap(frame as any);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp); } catch (e) { try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); } catch {} }
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.program!);
  gl.uniform1i(this.uApplyLimitedToFullLoc as WebGLUniformLocation, applyLimited ? 1 : 0);
  gl.uniform1i(this.uPrimariesLoc as WebGLUniformLocation, primaries);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      try { bmp.close(); } catch {}
    } catch (e) {
      // final fallback: 2D
      try { const ctx = this.canvas.getContext('2d'); if (ctx) ctx.drawImage(frame as any, 0, 0, this.canvas.width, this.canvas.height); } catch {}
    }
  }

  resize(w: number, h: number) { try { this.canvas.width = w; this.canvas.height = h; } catch {} }
}
