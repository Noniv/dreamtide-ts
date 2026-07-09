// WebGPU instanced world renderer.
//
// The endgame frame cost was proven to be per-draw-call CPU overhead in the
// browser's compositor process (halving render resolution didn't move it;
// collapsing enemies from ~40 path-ops to 1 blit each didn't move it either —
// because hundreds of *separate* Canvas2D draws, whatever their size, each
// cross into the GPU process). The fix is to stop issuing per-entity draws at
// all: every sprite in the world (enemies, gems, projectiles, bullets, glows,
// particles) becomes one instance in a shared buffer, drawn in TWO instanced
// calls per frame — one alpha-blended pass for opaque-ish bodies, one additive
// pass for glows. Thousands of entities, a couple of draw calls.
//
// WebGPU only. On a browser without WebGPU the engine keeps a minimal Canvas2D
// fallback (playable, not perf-tuned).
//
// Instance layout (16 floats, std140-friendly 4×vec4):
//   [0..1]  pos.xy      screen-space centre (CSS px)
//   [2]     half        half-extent (px); quad spans centre ± half
//   [3]     rot         radians
//   [4..7]  uvRect      u0,v0,u1,v1  (atlas UV; for a flat glow use the 'glow' tile)
//   [8..10] tintRGB     tint colour 0..1
//   [11]    tintMix     0 = sprite as-is, 1 = replace rgb with tint (keep sprite alpha)
//   [12]    alpha       overall multiply
//   [13..15] pad

import type { CamRect } from './particles';
import { getAtlas, type Atlas, type AtlasEntry } from './enemySprites';

export const FLOATS_PER_QUAD = 16;
const MAX_QUADS = 16384; // enemies+gems+projectiles+particles ceiling with headroom

// ---- one growable instance list the engine fills each frame ----
// Two blend groups packed into the SAME Float32Array: alpha group grows from
// the front, additive group written to a scratch then appended — simpler: we
// keep two arrays and two counts.
export class QuadList {
  atlas: Atlas;
  alphaData = new Float32Array(MAX_QUADS * FLOATS_PER_QUAD);
  addData = new Float32Array(MAX_QUADS * FLOATS_PER_QUAD);
  alphaN = 0;
  addN = 0;

  constructor() { this.atlas = getAtlas(); }

  reset() { this.alphaN = 0; this.addN = 0; }

  // look up a sprite's atlas entry (uv + half)
  uv(id: string): AtlasEntry | undefined { return this.atlas.entries.get(id); }

  // push one quad. `additive` chooses the blend group. tint defaults to none.
  push(
    additive: boolean,
    e: AtlasEntry,
    x: number, y: number, half: number, rot: number,
    alpha: number,
    tintR = 1, tintG = 1, tintB = 1, tintMix = 0,
  ) {
    const data = additive ? this.addData : this.alphaData;
    const i = additive ? this.addN : this.alphaN;
    if (i >= MAX_QUADS) return;
    const o = i * FLOATS_PER_QUAD;
    data[o] = x; data[o + 1] = y; data[o + 2] = half; data[o + 3] = rot;
    data[o + 4] = e.u0; data[o + 5] = e.v0; data[o + 6] = e.u1; data[o + 7] = e.v1;
    data[o + 8] = tintR; data[o + 9] = tintG; data[o + 10] = tintB; data[o + 11] = tintMix;
    data[o + 12] = alpha; data[o + 13] = 0; data[o + 14] = 0; data[o + 15] = 0;
    if (additive) this.addN++; else this.alphaN++;
  }
}

const WGSL = /* wgsl */ `
struct Uniforms { viewport: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) tint: vec4<f32>,   // rgb + mix
  @location(2) alpha: f32,
};

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) iPos: vec2<f32>,
  @location(1) iHalfRot: vec2<f32>,   // half, rot
  @location(2) iUV: vec4<f32>,        // u0 v0 u1 v1
  @location(3) iTint: vec4<f32>,      // r g b mix
  @location(4) iAlpha: vec4<f32>,     // alpha, pad, pad, pad
) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(1.0,1.0),
    vec2(-1.0,-1.0), vec2(1.0,1.0), vec2(-1.0,1.0),
  );
  var uvs = array<vec2<f32>, 6>(
    vec2(0.0,0.0), vec2(1.0,0.0), vec2(1.0,1.0),
    vec2(0.0,0.0), vec2(1.0,1.0), vec2(0.0,1.0),
  );
  let corner = corners[vi];
  let half = iHalfRot.x;
  let rot = iHalfRot.y;
  let c = cos(rot); let s = sin(rot);
  let local = vec2(corner.x * half, corner.y * half);
  let rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  let px = iPos + rotated;
  let clip = vec2(px.x / u.viewport.x * 2.0 - 1.0, 1.0 - px.y / u.viewport.y * 2.0);
  var out: VSOut;
  out.pos = vec4(clip, 0.0, 1.0);
  out.uv = mix(iUV.xy, iUV.zw, uvs[vi]);
  out.tint = iTint;
  out.alpha = iAlpha.x;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  var texel = textureSample(tex, samp, in.uv);
  // tintMix replaces rgb (keeps sprite alpha) — used for flash/frozen bodies
  // and for colouring the flat white 'glow' sprite.
  let rgb = mix(texel.rgb, in.tint.rgb, in.tint.a);
  let a = texel.a * in.alpha;
  return vec4(rgb * a, a); // premultiplied
}
`;

export interface WorldGPU {
  readonly canvas: HTMLCanvasElement;
  resize(cssW: number, cssH: number, dpr: number): void;
  begin(clear: boolean): void;                 // start a frame's render pass
  drawQuads(list: QuadList): void;             // alpha pass then additive pass
  end(): void;
  dispose(): void;
  readonly device: GPUDevice;                  // shared with the particle layer
  readonly format: GPUTextureFormat;
}

function makeCanvas(host: HTMLCanvasElement, cls: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'game-canvas ' + cls;
  c.style.position = 'absolute';
  c.style.inset = '0';
  c.style.pointerEvents = 'none';
  host.parentNode!.insertBefore(c, host.nextSibling);
  return c;
}

class WorldGPUImpl implements WorldGPU {
  readonly canvas: HTMLCanvasElement;
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  private ctx: GPUCanvasContext;
  private pipeAlpha: GPURenderPipeline;
  private pipeAdd: GPURenderPipeline;
  private uniBuf: GPUBuffer;
  private bind: GPUBindGroup;
  private alphaBuf: GPUBuffer;
  private addBuf: GPUBuffer;
  private uniData = new Float32Array(4);
  private cssW = 1; private cssH = 1;
  private encoder: GPUCommandEncoder | null = null;
  private pass: GPURenderPassEncoder | null = null;

  constructor(host: HTMLCanvasElement, device: GPUDevice, atlas: Atlas) {
    this.device = device;
    // `host` here is the dedicated middle GPU canvas the engine created and
    // stacked between the 2D background and the 2D overlay.
    this.canvas = host;
    const ctx = host.getContext('webgpu');
    if (!ctx) throw new Error('no webgpu context on host');
    this.ctx = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    // this is the MIDDLE layer — it must be transparent so the 2D bottom layer
    // (sky, zones) shows through everywhere entities aren't drawn
    this.ctx.configure({ device, format: this.format, alphaMode: 'premultiplied' });

    const module = device.createShaderModule({ code: WGSL });
    const attrs: GPUVertexAttribute[] = [
      { shaderLocation: 0, offset: 0, format: 'float32x2' },   // pos
      { shaderLocation: 1, offset: 8, format: 'float32x2' },   // half,rot
      { shaderLocation: 2, offset: 16, format: 'float32x4' },  // uv
      { shaderLocation: 3, offset: 32, format: 'float32x4' },  // tint
      { shaderLocation: 4, offset: 48, format: 'float32x4' },  // alpha,pad
    ];
    const vbLayout: GPUVertexBufferLayout = {
      arrayStride: FLOATS_PER_QUAD * 4, stepMode: 'instance', attributes: attrs,
    };
    // explicit shared layout so ONE bind group is valid for both pipelines
    // (with layout:'auto' each pipeline gets an incompatible auto-layout)
    const bgLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [bgLayout] });
    const mkPipe = (add: boolean) => device.createRenderPipeline({
      layout: pipeLayout,
      vertex: { module, entryPoint: 'vs', buffers: [vbLayout] },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: add
            ? { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } }
            : { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.pipeAlpha = mkPipe(false);
    this.pipeAdd = mkPipe(true);

    // upload the atlas as a texture
    const tex = device.createTexture({
      size: [atlas.size, atlas.size],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: atlas.canvas },
      { texture: tex, premultipliedAlpha: false },
      [atlas.size, atlas.size],
    );
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    this.uniBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bind = device.createBindGroup({
      layout: bgLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniBuf } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: tex.createView() },
      ],
    });
    const bytes = MAX_QUADS * FLOATS_PER_QUAD * 4;
    this.alphaBuf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.addBuf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  resize(cssW: number, cssH: number, dpr: number) {
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.cssW = cssW; this.cssH = cssH;
  }

  begin(clear: boolean) {
    this.encoder = this.device.createCommandEncoder();
    this.pass = this.encoder.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, // transparent — middle layer
        loadOp: clear ? 'clear' : 'load',
        storeOp: 'store',
      }],
    });
    this.uniData[0] = this.cssW; this.uniData[1] = this.cssH;
    this.device.queue.writeBuffer(this.uniBuf, 0, this.uniData);
  }

  drawQuads(list: QuadList) {
    const pass = this.pass!;
    if (list.alphaN > 0) {
      this.device.queue.writeBuffer(this.alphaBuf, 0, list.alphaData, 0, list.alphaN * FLOATS_PER_QUAD);
      pass.setPipeline(this.pipeAlpha);
      pass.setBindGroup(0, this.bind);
      pass.setVertexBuffer(0, this.alphaBuf);
      pass.draw(6, list.alphaN);
    }
    if (list.addN > 0) {
      this.device.queue.writeBuffer(this.addBuf, 0, list.addData, 0, list.addN * FLOATS_PER_QUAD);
      pass.setPipeline(this.pipeAdd);
      pass.setBindGroup(0, this.bind);
      pass.setVertexBuffer(0, this.addBuf);
      pass.draw(6, list.addN);
    }
  }

  end() {
    this.pass!.end();
    this.device.queue.submit([this.encoder!.finish()]);
    this.pass = null; this.encoder = null;
  }

  dispose() {
    this.alphaBuf.destroy();
    this.addBuf.destroy();
    this.uniBuf.destroy();
  }
}

// Create the world renderer on the given host canvas. Returns null if WebGPU is
// unavailable (caller falls back to Canvas2D).
export async function createWorldGPU(host: HTMLCanvasElement): Promise<WorldGPU | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const atlas = getAtlas();
    return new WorldGPUImpl(host, device, atlas);
  } catch (e) {
    console.warn('[worldGPU] init failed, Canvas2D fallback:', e);
    return null;
  }
}

export { makeCanvas };
export type { CamRect };
