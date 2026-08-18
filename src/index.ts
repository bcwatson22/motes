/* The JavaScript half of the particle field. Rust simulates; this draws.

   The module exposes a pointer into its own linear memory, so a Float32Array
   laid over it is the particle buffer — read directly each frame, with nothing
   crossing the boundary per particle. One tick() call per frame, then ordinary
   canvas arcs. */

import { wasm } from './wasm';

/* The parity spec, kept here rather than in Rust so the numbers a reader wants
   to change sit next to the drawing code that uses most of them. tsparticles
   scaled `count` by canvas area against a 1920x1080 reference, so this is the
   configured number rather than the rendered one — the module does that sum. */
const options = {
  count: 600,
  speed: 0.25,
  size: 2.2,
  bubbleDistance: 175,
  bubbleSize: 4,
} as const;

/* What the field settles at when nothing overrides it. Right on the home
   page, which is always dark: white at 0.3 over near-black reads as texture.
   Wrong on a light page, where a dark colour at 0.3 composites to a pale
   grey — brand blue loses about four fifths of its saturation that way. */
const defaultOpacity = 0.3;

/* A fully bubbled particle in the original config was twice the resting
   opacity — 0.3 and 0.6. Derived rather than configured separately, so
   raising one cannot silently invert the relationship. */
const bubbleOpacityFor = (opacity: number): number => Math.min(1, opacity * 2);

/* Far enough away that no particle is ever within the bubble radius of it. */
const noPointer = -1e9;

/* A frame longer than this is a tab that was backgrounded or a thread that
   stalled; advancing by the real delta would teleport the whole field. */
const maxFrameMs = 50;

type Exports = {
  memory: WebAssembly.Memory;
  configure: (
    count: number,
    speed: number,
    radius: number,
    bubbleRange: number,
  ) => void;
  resize: (width: number, height: number) => void;
  tick: (dt: number, pointerX: number, pointerY: number) => void;
  data_ptr: () => number;
  count: () => number;
  stride: () => number;
};

type Field = {
  destroy: () => void;
};

type Options = {
  color: string;
  opacity?: number;
};

/* The module is inlined rather than fetched, so there is no asset to host, no
   path to configure and no request to fail. atob is a browser builtin and this
   is a browser package; decoding 4KB is well under a millisecond. */
const decode = (encoded: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(encoded);
  /* Backed by an explicit ArrayBuffer rather than `new Uint8Array(length)`:
     since TypeScript 5.7 the array is generic over its buffer, and the default
     ArrayBufferLike does not satisfy the BufferSource that instantiate wants. */
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
};

const instantiate = async (): Promise<Exports> => {
  const { instance } = await WebAssembly.instantiate(decode(wasm), {});

  return instance.exports as Exports;
};

/* Canvas takes a concrete colour — it cannot read `var(--brand-blue)`. Rather
   than parse CSS, set the value on the element and read back what the browser
   computed: that resolves custom properties, colour functions and keywords
   alike, and keeps the brand hexes in globals.css as the only copy.

   Falls back to the value as given if there is nothing to compute against,
   which is the case under jsdom. */
const resolveColor = (value: string, element: HTMLElement): string => {
  element.style.color = value;

  const computed = window.getComputedStyle(element).color;

  return computed || value;
};

const createField = async (
  canvas: HTMLCanvasElement,
  { color, opacity = defaultOpacity }: Options,
): Promise<Field> => {
  const wasm = await instantiate();
  const context = canvas.getContext('2d');
  const resolved = resolveColor(color, canvas);
  const bubbleOpacity = bubbleOpacityFor(opacity);

  if (!context) {
    /* No 2D context is not an error worth surfacing: the field is decoration,
       and the page is correct without it. */
    return { destroy: (): void => {} };
  }

  wasm.configure(
    options.count,
    options.speed,
    options.size,
    options.bubbleDistance,
  );

  let view = new Float32Array(0);
  let width = 0;
  let height = 0;
  let pointerX = noPointer;
  let pointerY = noPointer;

  const resize = (): void => {
    const ratio = window.devicePixelRatio || 1;

    width = canvas.clientWidth;
    height = canvas.clientHeight;

    /* detectRetina: the backing store is scaled by the device pixel ratio and
       the context scaled back down, so a 2x display draws sharp rather than
       upscaling a blurry buffer. */
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    wasm.resize(width, height);

    /* Re-laid after every resize. The module never grows its memory, but a
       view is still only valid for the count it was created with. */
    view = new Float32Array(
      wasm.memory.buffer,
      wasm.data_ptr(),
      wasm.count() * wasm.stride(),
    );
  };

  const draw = (): void => {
    const count = wasm.count();
    const stride = wasm.stride();

    context.clearRect(0, 0, width, height);
    context.fillStyle = resolved;

    for (let i = 0; i < count; i++) {
      const offset = i * stride;
      const bubble = view[offset + 4];

      context.globalAlpha = opacity + (bubbleOpacity - opacity) * bubble;

      context.beginPath();
      context.arc(
        view[offset],
        view[offset + 1],
        options.size + (options.bubbleSize - options.size) * bubble,
        0,
        Math.PI * 2,
      );
      context.fill();
    }

    context.globalAlpha = 1;
  };

  const onPointerMove = (event: PointerEvent): void => {
    pointerX = event.clientX;
    pointerY = event.clientY;
  };

  const onPointerLeave = (): void => {
    pointerX = noPointer;
    pointerY = noPointer;
  };

  let frame = 0;
  let last = performance.now();

  const step = (now: number): void => {
    wasm.tick(Math.min(now - last, maxFrameMs), pointerX, pointerY);
    last = now;
    draw();
    frame = requestAnimationFrame(step);
  };

  resize();

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerleave', onPointerLeave);

  frame = requestAnimationFrame(step);

  return {
    destroy: (): void => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
    },
  };
};

export { bubbleOpacityFor, createField, defaultOpacity, options };
export type { Field, Options };
