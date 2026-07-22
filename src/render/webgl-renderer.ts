// WebGL renderer that uploads WebCodecs VideoFrame objects as RGBA textures.
export class WebGLRenderer {
  readonly type = 'webgl' as const;
  private gl: WebGLRenderingContext;
  private texture: WebGLTexture | null = null;
  private program: WebGLProgram | null = null;
  private vertexShader: WebGLShader | null = null;
  private fragmentShader: WebGLShader | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private contextLost = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
    if (!gl) throw new Error('WebGL context is not available.');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    this.init();
  }

  draw(frame: any): void {
    if (this.contextLost || !this.program || !this.texture) return;
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  clear(): void {
    if (!this.contextLost) this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  destroy(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.releaseResources();
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
  };

  private handleContextRestored = (): void => {
    this.contextLost = false;
    this.releaseResources();
    this.init();
  };

  private releaseResources(): void {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
    if (this.program) gl.deleteProgram(this.program);
    if (this.vertexShader) gl.deleteShader(this.vertexShader);
    if (this.fragmentShader) gl.deleteShader(this.fragmentShader);
    this.texture = null;
    this.vertexBuffer = null;
    this.program = null;
    this.vertexShader = null;
    this.fragmentShader = null;
  }

  private init(): void {
    const gl = this.gl;
    const vertexSource = [
      'attribute vec2 a_pos;',
      'attribute vec2 a_uv;',
      'varying vec2 v_uv;',
      'void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); v_uv = a_uv; }'
    ].join('\n');
    const fragmentSource = [
      'precision mediump float;',
      'varying vec2 v_uv;',
      'uniform sampler2D u_tex;',
      'void main(){ gl_FragColor = texture2D(u_tex, v_uv); }'
    ].join('\n');

    const vertex = this.compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
    this.vertexShader = vertex;
    this.fragmentShader = fragment;
    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program) || 'Failed to link WebGL program.';
      gl.deleteProgram(program);
      throw new Error(error);
    }
    gl.useProgram(program);
    this.program = program;

    const vertices = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1
    ]);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Failed to create WebGL vertex buffer.');
    this.vertexBuffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const pos = gl.getAttribLocation(program, 'a_pos');
    const uv = gl.getAttribLocation(program, 'a_uv');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);

    this.texture = gl.createTexture();
    if (!this.texture) throw new Error('Failed to create WebGL texture.');
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
  }

  private compile(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) throw new Error('Failed to create WebGL shader.');
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const error = this.gl.getShaderInfoLog(shader) || 'Failed to compile WebGL shader.';
      this.gl.deleteShader(shader);
      throw new Error(error);
    }
    return shader;
  }
}
