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
/* The defaults, which are the settings the effect was originally ported from.
   Every one is overridable — a library that hardcodes its own particle count
   is not really a library. */
const defaults = {
  opacity: 0.3,
  count: 600,
  speed: 0.25,
  size: 2.2,
  bubbleSize: 4,
  bubbleDistance: 175,
} as const;

const TAU = Math.PI * 2;

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
    size: number,
    bubbleSize: number,
    opacity: number,
    bubbleRange: number,
  ) => void;
  resize: (width: number, height: number) => void;
  tick: (dt: number, pointerX: number, pointerY: number) => void;
  data_ptr: () => number;
  count: () => number;
  stride: () => number;
};

/* Everything the simulation needs, with nothing optional left. */
type Settings = Required<Omit<Options, 'respectReducedMotion'>>;

/* Spread would let an explicit `undefined` blank a default — which is exactly
   what a caller passing optional props through does: `{ opacity }` where
   opacity happens to be undefined should mean "leave it alone", not "clear
   it". Returns the keys that actually changed, since the caller needs to know
   whether `count` was among them. */
const applyDefined = (
  target: Settings,
  changes: Partial<Options>,
): Set<string> => {
  const applied = new Set<string>();

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;

    (target as Record<string, unknown>)[key] = value;
    applied.add(key);
  }

  return applied;
};

type Field = {
  /* Change settings without restarting the field. Everything but `count`
     applies on the next frame with no respawn, because the simulation reads
     these values every tick rather than baking them into each particle. */
  update: (options: Partial<Options>) => void;
  destroy: () => void;
};

type Options = {
  /* Any CSS colour. Resolved against the document, so custom properties and
     colour functions work as well as hexes. */
  color: string;
  /* How solid a particle is at rest, 0 to 1. Worth raising on a light
     background: a dark colour at the default 0.3 composites against near-white
     to something close to grey. */
  opacity?: number;
  /* Scaled by canvas area against a 1920x1080 reference, so this is not the
     number that appears on screen — see the README. */
  count?: number;
  speed?: number;
  size?: number;
  /* What a particle grows to directly under the pointer. */
  bubbleSize?: number;
  /* How far the pointer's influence reaches, in CSS pixels. */
  bubbleDistance?: number;
  /* Set false only if the animation is genuinely essential rather than
     decorative. It defaults to true because a field of drifting particles is
     decoration, and someone who has asked their system for less motion has
     asked for a reason. */
  respectReducedMotion?: boolean;
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

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

const createField = async (
  canvas: HTMLCanvasElement,
  { respectReducedMotion = true, ...given }: Options,
): Promise<Field> => {
  /* One mutable record of the current settings, so `update` has somewhere to
     merge into and `configure` has one place to read from. */
  const settings: Settings = { ...defaults, color: given.color };

  applyDefined(settings, given);

  const wasm = await instantiate();
  const context = canvas.getContext('2d');

  let resolved = resolveColor(settings.color, canvas);

  if (!context) {
    /* No 2D context is not an error worth surfacing: the field is decoration,
       and the page is correct without it. */
    return { update: (): void => {}, destroy: (): void => {} };
  }

  const configure = (): void =>
    wasm.configure(
      settings.count,
      settings.speed,
      settings.size,
      settings.bubbleSize,
      settings.opacity,
      settings.bubbleDistance,
    );

  configure();

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

    /* Four reads and an arc. The radius and alpha arrive interpolated — the
       simulation writes what the canvas needs rather than a progress value for
       this loop to expand, so nothing is recomputed per particle here. */
    for (let i = 0; i < count; i++) {
      const offset = i * stride;

      context.globalAlpha = view[offset + 5];

      context.beginPath();
      context.arc(view[offset], view[offset + 1], view[offset + 4], 0, TAU);
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
  let running = false;
  let last = performance.now();

  const step = (now: number): void => {
    wasm.tick(Math.min(now - last, maxFrameMs), pointerX, pointerY);
    last = now;
    draw();
    frame = requestAnimationFrame(step);
  };

  const start = (): void => {
    if (running) return;

    running = true;
    /* Reset, or resuming after a pause hands the first frame the entire time
       the loop was stopped and teleports the field. */
    last = performance.now();
    frame = requestAnimationFrame(step);
  };

  const stop = (): void => {
    if (!running) return;

    running = false;
    cancelAnimationFrame(frame);
  };

  const motion = window.matchMedia(reducedMotionQuery);

  const applyMotionPreference = (): void => {
    if (respectReducedMotion && motion.matches) {
      stop();

      /* Drawn once, and then left alone. The guidance is to remove the motion,
         not the content — a still field is a background that is not moving,
         where an empty canvas is a missing feature. */
      draw();

      return;
    }

    start();
  };

  resize();

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerleave', onPointerLeave);
  /* Subscribed rather than read once: someone changing the setting with the
     page open should see the field stop, without reloading. */
  motion.addEventListener('change', applyMotionPreference);

  applyMotionPreference();

  return {
    update: (next: Partial<Options>): void => {
      const { respectReducedMotion: _ignored, ...changes } = next;
      const applied = applyDefined(settings, changes);

      if (applied.has('color')) {
        resolved = resolveColor(settings.color, canvas);
      }

      configure();

      /* Count is the only setting the simulation cannot pick up on the next
         tick: it decides how many particles exist, so the field has to spawn
         the shortfall or drop the surplus, and the buffer view has to be
         relaid over the new length. Everything else is read every frame. */
      if (applied.has('count')) {
        resize();
      }

      /* Redrawn immediately when there is no loop to do it — otherwise a
         change under reduced motion would not appear until something else
         forced a frame. */
      if (!running) {
        draw();
      }
    },
    destroy: (): void => {
      stop();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      motion.removeEventListener('change', applyMotionPreference);
    },
  };
};

export { createField, defaults };
export type { Field, Options };
