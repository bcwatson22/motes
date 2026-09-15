import type { Mock } from 'vitest';

import { createField, defaults, type Options as FieldOptions } from './index';
import { wasm as encoded } from './wasm';

/* A stand-in for the compiled module. The simulation itself is tested in Rust
   with cargo; what matters here is that this half drives it correctly and
   draws what it reports. */
const stride = 6;

/* Where the stand-in puts its first particle; each one after is a pixel on. */
const spawn = { x: 10, y: 20 };

const width = 1280;
const height = 800;
const color = '#245385';

/* Mirrors the field's own parking spot for a pointer it has not seen: far
   enough away that nothing is ever within the bubble radius. */
const parked = -1e9;

/* One frame at roughly 60fps, which is what almost every test wants. */
const elapsed = 16;

type Point = { clientX: number; clientY: number };

/* Anywhere will do; what matters is that the same point comes back out. */
const point: Point = { clientX: 400, clientY: 300 };

/* A canvas that is not at the viewport origin, as one in a box would be. */
const inset = { left: 120, top: 80 } as DOMRect;

/* The arguments `configure` takes, in its order, for the defaults with any
   overrides merged over them. */
const configuredWith = (overrides: Partial<FieldOptions> = {}): number[] => {
  const settings = { ...defaults, ...overrides };

  return [
    settings.count,
    settings.speed,
    settings.size,
    settings.bubbleSize,
    settings.opacity,
    settings.bubbleDistance,
  ];
};

const pointer = (type: string, init: PointerEventInit = {}): void => {
  window.dispatchEvent(new PointerEvent(type, { ...point, ...init }));
};

/* jsdom has no Touch constructor, so the list is laid on a plain event. */
const touchMove = (touches: Point[] = [point]): void => {
  window.dispatchEvent(Object.assign(new Event('touchmove'), { touches }));
};

type WasmOptions = {
  count?: number;
  /* The simulation writes finished values, so these are what it would have
     interpolated rather than a progress value this side expands. */
  radii?: number[];
  alphas?: number[];
};

const createWasm = ({
  count = 2,
  radii = [],
  alphas = [],
}: WasmOptions = {}) => {
  const buffer = new ArrayBuffer(count * stride * 4);
  const view = new Float32Array(buffer);

  for (let i = 0; i < count; i++) {
    view[i * stride] = spawn.x + i;
    view[i * stride + 1] = spawn.y + i;
    view[i * stride + 4] = radii[i] ?? defaults.size;
    view[i * stride + 5] = alphas[i] ?? defaults.opacity;
  }

  return {
    memory: { buffer } as WebAssembly.Memory,
    configure: vi.fn<() => void>(),
    resize: vi.fn<() => void>(),
    tick: vi.fn<() => void>(),
    data_ptr: vi.fn<() => number>(() => 0),
    count: vi.fn<() => number>(() => count),
    stride: vi.fn<() => number>(() => stride),
  };
};

const createContext = () => ({
  clearRect: vi.fn<() => void>(),
  setTransform: vi.fn<() => void>(),
  beginPath: vi.fn<() => void>(),
  arc: vi.fn<() => void>(),
  fill: vi.fn<() => void>(),
  fillStyle: '',
  globalAlpha: 1,
});

type Options = {
  wasm?: ReturnType<typeof createWasm>;
  color?: string;
  opacity?: number;
  prefersReducedMotion?: boolean;
  respectReducedMotion?: boolean;
  /* Whether the canvas yields a 2D context at all. A flag rather than a
     nullable context, so `context` below is never null and the assertions do
     not have to chain through it. */
  hasContext?: boolean;
  ratio?: number;
  clientWidth?: number;
  clientHeight?: number;
};

/* Fired to simulate someone changing the setting with the page open. */
let changeMotionPreference: (() => void) | undefined;

/* And to fire the listener without the value having changed, which a media
   query will do. */
let refireMotionPreference: (() => void) | undefined;

const setup = async ({
  wasm = createWasm(),
  color: given = color,
  opacity,
  prefersReducedMotion = false,
  respectReducedMotion,
  hasContext = true,
  ratio = 1,
  clientWidth = width,
  clientHeight = height,
}: Options = {}) => {
  const context = createContext();
  vi.stubGlobal('devicePixelRatio', ratio);

  /* jsdom has no matchMedia, and the field reads one at startup. Matches on
     the reduced-motion query only, so a stub cannot accidentally report every
     query as true. */
  let matches = prefersReducedMotion;

  vi.stubGlobal(
    'matchMedia',
    vi.fn<(query: string) => MediaQueryList>(
      (query: string) =>
        ({
          get matches() {
            return query.includes('reduced-motion') ? matches : false;
          },
          media: query,
          addEventListener: vi.fn<(type: string, handler: () => void) => void>(
            (_, handler) => {
              changeMotionPreference = () => {
                matches = !matches;
                handler();
              };
              refireMotionPreference = handler;
            },
          ),
          removeEventListener: vi.fn<() => void>(),
        }) as unknown as MediaQueryList,
    ),
  );
  /* Cast through Mock: `instantiate` is overloaded, and TypeScript resolves
     the spy to the Module signature — which resolves to an Instance rather
     than the { instance } this one returns. */
  (vi.spyOn(WebAssembly, 'instantiate') as unknown as Mock).mockResolvedValue({
    instance: { exports: wasm },
  });

  const canvas = document.createElement('canvas');

  /* Attached, because jsdom resolves computed styles differently for an
     element outside the document — and the colour is read back off the
     element. */
  document.body.append(canvas);

  Object.defineProperty(canvas, 'clientWidth', { value: clientWidth });
  Object.defineProperty(canvas, 'clientHeight', { value: clientHeight });
  vi.spyOn(canvas, 'getContext').mockReturnValue(
    hasContext ? (context as unknown as CanvasRenderingContext2D) : null,
  );

  const field = await createField(canvas, {
    color: given,
    opacity,
    respectReducedMotion,
  });

  return { field, wasm, context, canvas };
};

/* Runs the frame the loop has queued. */
const advance = (at: number): void => {
  const queued = (requestAnimationFrame as Mock).mock.calls.at(-1)?.[0];

  queued?.(at);
};

const frame = (): void => advance(performance.now() + elapsed);

describe('createField', () => {
  beforeEach(() => {
    changeMotionPreference = undefined;
    refireMotionPreference = undefined;
    vi.clearAllMocks();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn<() => number>(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn<() => void>());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /* Inlined rather than fetched: no asset to host, no path to configure, and
     nothing that can 404 in a consumer's app. */
  it('decodes and instantiates the inlined module', async () => {
    await setup();

    expect(WebAssembly.instantiate).toHaveBeenNthCalledWith(
      1,
      Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
      {},
    );
  });

  it('hands the simulation the parity constants', async () => {
    const { wasm } = await setup();

    expect(wasm.configure).toHaveBeenNthCalledWith(1, ...configuredWith());
  });

  it('hands the simulation the opacity it was given', async () => {
    const opacity = 0.55;
    const { wasm } = await setup({ opacity });

    expect(wasm.configure).toHaveBeenNthCalledWith(
      1,
      ...configuredWith({ opacity }),
    );
  });

  it('sizes the simulation in CSS pixels', async () => {
    const { wasm } = await setup({ ratio: 2 });

    expect(wasm.resize).toHaveBeenNthCalledWith(1, width, height);
  });

  /* detectRetina: the backing store is scaled up and the context scaled back
     down, so a 2x display draws sharp rather than upscaling a blurry buffer. */
  it('scales the backing store by the device pixel ratio', async () => {
    const ratio = 2;
    const { canvas, context } = await setup({ ratio });

    expect(canvas.width).toBe(width * ratio);
    expect(canvas.height).toBe(height * ratio);
    expect(context.setTransform).toHaveBeenNthCalledWith(
      1,
      ratio,
      0,
      0,
      ratio,
      0,
      0,
    );
  });

  it('falls back to a ratio of 1 where there is none', async () => {
    const { canvas } = await setup({ ratio: 0 });

    expect(canvas.width).toBe(width);
  });

  it('starts the loop', async () => {
    await setup();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  describe('each frame', () => {
    /* Nothing has touched the pointer, so it is still parked. */
    it('advances the simulation by the elapsed time', async () => {
      const startedAt = 1000;

      vi.spyOn(performance, 'now').mockReturnValue(startedAt);

      const { wasm } = await setup();

      advance(startedAt + elapsed);

      expect(wasm.tick).toHaveBeenNthCalledWith(1, elapsed, parked, parked);
    });

    /* A backgrounded tab returns a delta of minutes. Advancing by it would
       teleport the whole field on the frame the tab is restored. */
    it('clamps a frame that took too long', async () => {
      const maxFrameMs = 50;
      const { wasm } = await setup();

      advance(performance.now() + 60_000);

      expect(wasm.tick).toHaveBeenNthCalledWith(1, maxFrameMs, parked, parked);
    });

    it('draws one arc per particle', async () => {
      const count = 3;
      const { context } = await setup({ wasm: createWasm({ count }) });

      frame();

      expect(context.arc).toHaveBeenCalledTimes(count);
    });

    it('clears the canvas before drawing', async () => {
      const { context } = await setup();

      frame();

      expect(context.clearRect).toHaveBeenNthCalledWith(1, 0, 0, width, height);
    });

    /* Canvas cannot read `var(--brand-blue)`, so the value is set on the
       element and read back resolved — which is why this is rgb rather than
       the hex it was handed. */
    it('draws in the colour it was given, resolved', async () => {
      const { context } = await setup();

      frame();

      expect(context.fillStyle).toBe('rgb(36, 83, 133)');
    });

    /* Custom properties are the point of resolving rather than parsing — a
       page names the token and the brand hexes stay in globals.css as the
       only copy. Not asserted here: jsdom returns `var(--x)` from
       getComputedStyle unresolved, so this is verified in a real browser
       instead. Hex above covers the mechanism itself. */

    /* Nothing to compute against — the value is used as given rather than
       leaving the field with an empty fillStyle and drawing nothing. */
    it('falls back to the value as given when nothing resolves', async () => {
      vi.spyOn(window, 'getComputedStyle').mockReturnValue({
        color: '',
      } as unknown as CSSStyleDeclaration);

      const { context } = await setup();

      frame();

      expect(context.fillStyle).toBe(color);
    });

    /* The point of the split: the radius arrives interpolated, so this loop
       reads it rather than recomputing it.

       3.5 rather than a value like 3.1 because the buffer is Float32Array and
       3.1 reads back as 3.0999999046325684 — exactly representable values keep
       the assertion about the behaviour rather than about float precision. */
    it('draws each particle where and how the simulation says', async () => {
      const radius = 3.5;
      const { context } = await setup({
        wasm: createWasm({ count: 1, radii: [radius] }),
      });

      frame();

      expect(context.arc).toHaveBeenNthCalledWith(
        1,
        spawn.x,
        spawn.y,
        radius,
        0,
        Math.PI * 2,
      );
    });

    it('queues the next frame', async () => {
      await setup();

      frame();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    });
  });

  /* How opacity is arrived at is the simulation's business and is asserted in
     the crate. What matters here is that whatever it wrote reaches the canvas
     unaltered, and that the alpha is reset afterwards so the next thing drawn
     on this context is not silently transparent. */
  describe('alpha', () => {
    it('draws each particle at the alpha the simulation wrote', async () => {
      const alphas = [0.5, 0.75];
      const drawn: number[] = [];
      const { context } = await setup({
        wasm: createWasm({ count: alphas.length, alphas }),
      });

      (context.fill as Mock).mockImplementation(() => {
        drawn.push(context.globalAlpha);
      });

      frame();

      expect(drawn).toEqual(alphas);
    });

    it('restores full alpha when the frame is done', async () => {
      const { context } = await setup({
        wasm: createWasm({ count: 1, alphas: [0.5] }),
      });

      frame();

      expect(context.globalAlpha).toBe(1);
    });
  });

  /* A drifting field is decoration, and someone who has asked their system for
     less motion has asked for a reason. The package honours that itself rather
     than leaving it to whoever pastes the example. */
  describe('reduced motion', () => {
    it('does not start the loop', async () => {
      await setup({ prefersReducedMotion: true });

      expect(requestAnimationFrame).toHaveBeenCalledTimes(0);
    });

    /* Drawn once and left alone: the guidance is to remove the motion, not the
       content. An empty canvas is a missing feature. */
    it('still draws the field, once', async () => {
      const count = 3;
      const { context } = await setup({
        prefersReducedMotion: true,
        wasm: createWasm({ count }),
      });

      expect(context.arc).toHaveBeenCalledTimes(count);
    });

    it('starts the loop if the preference is turned off', async () => {
      await setup({ prefersReducedMotion: true });

      expect(requestAnimationFrame).toHaveBeenCalledTimes(0);

      changeMotionPreference?.();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('stops the loop if the preference is turned on', async () => {
      await setup();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

      changeMotionPreference?.();

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    });

    /* A media query will fire change without the value having flipped, so
       re-applying the preference must not queue a second loop alongside the
       one already running. */
    it('does not start a second loop when it is already running', async () => {
      await setup();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

      refireMotionPreference?.();
      refireMotionPreference?.();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('resumes after being stopped and started again', async () => {
      await setup();

      changeMotionPreference?.();
      changeMotionPreference?.();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('stops listening when destroyed', async () => {
      const { field } = await setup();

      field.destroy();
      changeMotionPreference?.();

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    });

    describe('when the caller opts out', () => {
      it('animates anyway', async () => {
        await setup({
          prefersReducedMotion: true,
          respectReducedMotion: false,
        });

        expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('the pointer', () => {
    it('follows it', async () => {
      const { wasm } = await setup();

      pointer('pointermove');
      frame();

      expect(wasm.tick).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        point.clientX,
        point.clientY,
      );
    });

    /* The simulation works in the canvas's own space, so a pointer position
       has to be converted into it. A full-screen canvas sits at the viewport
       origin and needs no conversion, which is how this went unnoticed — put
       the same field in a box and the bubble trails the cursor by however far
       the box is inset. */
    it('converts the position into the canvas own space', async () => {
      const { wasm, canvas } = await setup();

      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(inset);

      pointer('pointermove');
      frame();

      expect(wasm.tick).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        point.clientX - inset.left,
        point.clientY - inset.top,
      );
    });

    /* Parked far enough away that nothing is ever within the bubble radius,
       rather than tracked to an edge where it would still pull particles. */
    it('forgets it when it leaves the window', async () => {
      const { wasm } = await setup();

      pointer('pointermove');
      window.dispatchEvent(new PointerEvent('pointerleave'));
      frame();

      expect(wasm.tick).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        parked,
        parked,
      );
    });
  });

  /* A finger fires no pointermove for a tap, and stops firing it once a drag
     turns into a scroll, so the field reads the press and touchmove too. */
  describe('touch', () => {
    it('follows a tap', async () => {
      const { wasm } = await setup();

      pointer('pointerdown', { pointerType: 'touch' });
      frame();

      expect(wasm.tick).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        point.clientX,
        point.clientY,
      );
    });

    it('keeps it once the finger lifts', async () => {
      const { wasm } = await setup();

      pointer('pointerdown', { pointerType: 'touch' });
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerType: 'touch' }),
      );
      frame();

      expect(wasm.tick).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        point.clientX,
        point.clientY,
      );
    });

    it('follows a finger while the page scrolls', async () => {
      const { wasm, canvas } = await setup();

      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(inset);

      touchMove();
      frame();

      expect(wasm.tick).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        point.clientX - inset.left,
        point.clientY - inset.top,
      );
    });

    it('ignores a touchmove with no touches', async () => {
      const { wasm } = await setup();

      touchMove([]);
      frame();

      expect(wasm.tick).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        parked,
        parked,
      );
    });
  });

  describe('on resize', () => {
    it('reflows the simulation', async () => {
      const { wasm } = await setup();

      window.dispatchEvent(new Event('resize'));

      expect(wasm.resize).toHaveBeenCalledTimes(2);
    });

    /* Resizing the backing store clears the canvas, and a running loop
       repaints it on the next frame anyway. */
    it('leaves a running loop to repaint', async () => {
      const { context } = await setup({ wasm: createWasm({ count: 2 }) });

      window.dispatchEvent(new Event('resize'));

      expect(context.arc).toHaveBeenCalledTimes(0);
    });

    /* With no loop, nothing else would repaint it, and the field would sit
       blank until the next update. */
    it('redraws straight away when the loop is not running', async () => {
      const count = 2;
      const { context } = await setup({
        prefersReducedMotion: true,
        wasm: createWasm({ count }),
      });

      window.dispatchEvent(new Event('resize'));

      expect(context.arc).toHaveBeenCalledTimes(count * 2);
    });
  });

  /* A page's own pause control. Destroying and recreating the field would
     scatter a new one, so pausing has to hold the particles where they are. */
  describe('pause', () => {
    it('stops the loop', async () => {
      const { field } = await setup();

      field.pause();

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('leaves the field on the canvas', async () => {
      const { field, context } = await setup();

      frame();
      field.pause();

      expect(context.clearRect).toHaveBeenCalledTimes(1);
    });

    it('is safe to call twice', async () => {
      const { field } = await setup();

      field.pause();
      field.pause();

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    });

    /* A media query can fire change with the page open; turning reduced
       motion off must not quietly undo a pause someone asked for. */
    it('holds when reduced motion is turned off', async () => {
      const { field } = await setup({ prefersReducedMotion: true });

      field.pause();
      changeMotionPreference?.();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(0);
    });

    it('still applies updates while paused', async () => {
      const count = 2;
      const { field, context } = await setup({
        wasm: createWasm({ count }),
      });

      field.pause();
      field.update({ size: 3 });

      expect(context.arc).toHaveBeenCalledTimes(count);
    });
  });

  describe('resume', () => {
    it('starts the loop again', async () => {
      const { field } = await setup();

      field.pause();
      field.resume();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    });

    /* The first frame after resuming is measured from the resume, not from
       the last frame before the pause, or the field teleports. */
    it('does not hand the first frame the time spent paused', async () => {
      const { field, wasm } = await setup();

      const resumedAt = 60_000;

      vi.spyOn(performance, 'now').mockReturnValue(10_000);
      field.pause();

      (performance.now as Mock).mockReturnValue(resumedAt);
      field.resume();
      advance(resumedAt + elapsed);

      expect(wasm.tick).toHaveBeenNthCalledWith(1, elapsed, parked, parked);
    });

    it('does not start a second loop when not paused', async () => {
      const { field } = await setup();

      field.resume();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    /* Resuming is the caller's decision; reduced motion is the visitor's, and
       it outranks the page. */
    it('leaves the field still under reduced motion', async () => {
      const { field } = await setup({ prefersReducedMotion: true });

      field.pause();
      field.resume();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(0);
    });

    it('lets reduced motion being turned off start it again', async () => {
      const { field } = await setup({ prefersReducedMotion: true });

      field.pause();
      field.resume();
      changeMotionPreference?.();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });
  });

  /* The point of update over destroy-and-recreate: a control that restarts the
     field on every input event restarts the animation on every pixel of drag. */
  describe('update', () => {
    it('reconfigures the simulation without restarting the loop', async () => {
      const { field, wasm } = await setup();

      field.update({ speed: 1.5 });

      expect(wasm.configure).toHaveBeenCalledTimes(2);
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(0);
    });

    it('keeps settings it was not asked to change', async () => {
      const speed = 1.5;
      const { field, wasm } = await setup();

      field.update({ speed });

      expect(wasm.configure).toHaveBeenNthCalledWith(
        2,
        ...configuredWith({ speed }),
      );
    });

    /* A caller spreading optional props — `{ opacity }` where opacity is
       undefined — means "leave it alone", not "clear it". */
    it('ignores values given as undefined', async () => {
      const speed = 1.5;
      const { field, wasm } = await setup();

      field.update({ opacity: undefined, speed });

      expect(wasm.configure).toHaveBeenNthCalledWith(
        2,
        ...configuredWith({ speed }),
      );
    });

    /* Count decides how many particles exist, so it is the one setting that
       cannot be picked up on the next tick. */
    it('respawns when the count changes', async () => {
      const { field, wasm } = await setup();

      field.update({ count: 200 });

      expect(wasm.resize).toHaveBeenCalledTimes(2);
    });

    it('does not respawn for anything else', async () => {
      const { field, wasm } = await setup();

      field.update({ speed: 1.5, size: 3, opacity: 0.8 });

      expect(wasm.resize).toHaveBeenCalledTimes(1);
    });

    it('resolves a new colour', async () => {
      const { field, context } = await setup();

      field.update({ color: '#f9fafb' });
      frame();

      expect(context.fillStyle).toBe('rgb(249, 250, 251)');
    });

    /* Otherwise a change made while the field is halted would not appear
       until something else forced a frame. */
    it('redraws immediately when the loop is not running', async () => {
      const count = 2;
      const { field, context } = await setup({
        prefersReducedMotion: true,
        wasm: createWasm({ count }),
      });

      expect(context.arc).toHaveBeenCalledTimes(count);

      field.update({ size: 3 });

      expect(context.arc).toHaveBeenCalledTimes(count * 2);
    });

    it('leaves the running loop to draw its own next frame', async () => {
      const { field, context } = await setup({
        wasm: createWasm({ count: 2 }),
      });

      field.update({ size: 3 });

      expect(context.arc).toHaveBeenCalledTimes(0);
    });

    /* respectReducedMotion is settled when the field is created; changing it
       later would mean re-subscribing, which is not worth the surface area. */
    it('ignores respectReducedMotion', async () => {
      const { field } = await setup({ prefersReducedMotion: true });

      field.update({ respectReducedMotion: false });

      expect(requestAnimationFrame).toHaveBeenCalledTimes(0);
    });

    describe('where there is no 2D context', () => {
      it('is safe to call', async () => {
        const { field } = await setup({ hasContext: false });

        expect(() => field.update({ speed: 1 })).not.toThrow();
      });

      it('is safe to pause and resume', async () => {
        const { field } = await setup({ hasContext: false });

        expect(() => {
          field.pause();
          field.resume();
        }).not.toThrow();
      });
    });
  });

  describe('destroy', () => {
    it('stops the loop', async () => {
      const { field } = await setup();

      field.destroy();

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('stops listening to the window', async () => {
      const { field, wasm } = await setup();

      field.destroy();
      window.dispatchEvent(new Event('resize'));

      expect(wasm.resize).toHaveBeenCalledTimes(1);
    });

    it('stops following the pointer and touch', async () => {
      const { field, wasm } = await setup();

      field.destroy();
      pointer('pointermove');
      pointer('pointerdown');
      touchMove();
      frame();

      expect(wasm.tick).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        parked,
        parked,
      );
    });
  });

  /* No 2D context is not worth surfacing: the field is decoration and the
     page is correct without it. */
  describe('where there is no 2D context', () => {
    it('does not start a loop', async () => {
      await setup({ hasContext: false });

      expect(requestAnimationFrame).toHaveBeenCalledTimes(0);
    });

    it('returns a field that is safe to destroy', async () => {
      const { field } = await setup({ hasContext: false });

      expect(() => field.destroy()).not.toThrow();
    });
  });
});
