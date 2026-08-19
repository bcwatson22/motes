import type { Mock } from 'vitest';

import { createField, defaultOpacity, options } from './index';

/* A stand-in for the compiled module. The simulation itself is tested in Rust
   with cargo; what matters here is that this half drives it correctly and
   draws what it reports. */
const stride = 6;

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
    view[i * stride] = 10 + i;
    view[i * stride + 1] = 20 + i;
    view[i * stride + 4] = radii[i] ?? options.size;
    view[i * stride + 5] = alphas[i] ?? defaultOpacity;
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
  color = '#245385',
  opacity,
  prefersReducedMotion = false,
  respectReducedMotion,
  hasContext = true,
  ratio = 1,
  clientWidth = 1280,
  clientHeight = 800,
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

  Object.defineProperty(canvas, 'clientWidth', { value: clientWidth });
  Object.defineProperty(canvas, 'clientHeight', { value: clientHeight });
  vi.spyOn(canvas, 'getContext').mockReturnValue(
    hasContext ? (context as unknown as CanvasRenderingContext2D) : null,
  );

  const field = await createField(canvas, {
    color,
    opacity,
    respectReducedMotion,
  });

  return { field, wasm, context, canvas };
};

/* Runs the frame the loop has queued, and returns the next one. */
const advance = (at: number): void => {
  const queued = (requestAnimationFrame as Mock).mock.calls.at(-1)?.[0];

  queued?.(at);
};

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
  it('instantiates the inlined module', async () => {
    await setup();

    expect(WebAssembly.instantiate).toHaveBeenCalledTimes(1);
  });

  it('decodes the module to bytes before instantiating', async () => {
    await setup();

    const [bytes] = (WebAssembly.instantiate as unknown as Mock).mock.calls[0];

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect((bytes as Uint8Array).length).toBeGreaterThan(0);
  });

  it('hands the simulation the parity constants', async () => {
    const { wasm } = await setup();

    expect(wasm.configure).toHaveBeenNthCalledWith(
      1,
      options.count,
      options.speed,
      options.size,
      options.bubbleSize,
      defaultOpacity,
      options.bubbleDistance,
    );
  });

  it('hands the simulation the opacity it was given', async () => {
    const { wasm } = await setup({ opacity: 0.55 });

    expect((wasm.configure as Mock).mock.calls[0][4]).toBe(0.55);
  });

  it('sizes the simulation in CSS pixels', async () => {
    const { wasm } = await setup({ ratio: 2 });

    expect(wasm.resize).toHaveBeenNthCalledWith(1, 1280, 800);
  });

  /* detectRetina: the backing store is scaled up and the context scaled back
     down, so a 2x display draws sharp rather than upscaling a blurry buffer. */
  it('scales the backing store by the device pixel ratio', async () => {
    const { canvas, context } = await setup({ ratio: 2 });

    expect(canvas.width).toBe(2560);
    expect(canvas.height).toBe(1600);
    expect(context.setTransform).toHaveBeenNthCalledWith(1, 2, 0, 0, 2, 0, 0);
  });

  it('falls back to a ratio of 1 where there is none', async () => {
    const { canvas } = await setup({ ratio: 0 });

    expect(canvas.width).toBe(1280);
  });

  it('starts the loop', async () => {
    await setup();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  describe('each frame', () => {
    it('advances the simulation by the elapsed time', async () => {
      const { wasm } = await setup();

      vi.spyOn(performance, 'now').mockReturnValue(1000);
      advance(1016);

      expect(wasm.tick).toHaveBeenCalledTimes(1);
      expect((wasm.tick as Mock).mock.calls[0][0]).toBeLessThanOrEqual(50);
    });

    /* A backgrounded tab returns a delta of minutes. Advancing by it would
       teleport the whole field on the frame the tab is restored. */
    it('clamps a frame that took too long', async () => {
      const { wasm } = await setup();

      advance(performance.now() + 60_000);

      expect((wasm.tick as Mock).mock.calls[0][0]).toBe(50);
    });

    it('draws one arc per particle', async () => {
      const { context } = await setup({ wasm: createWasm({ count: 3 }) });

      advance(performance.now() + 16);

      expect(context.arc).toHaveBeenCalledTimes(3);
    });

    it('clears the canvas before drawing', async () => {
      const { context } = await setup();

      advance(performance.now() + 16);

      expect(context.clearRect).toHaveBeenNthCalledWith(1, 0, 0, 1280, 800);
    });

    /* Canvas cannot read `var(--brand-blue)`, so the value is set on the
       element and read back resolved — which is why this is rgb rather than
       the hex it was handed. */
    it('draws in the colour it was given, resolved', async () => {
      const { context } = await setup();

      advance(performance.now() + 16);

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

      const { context } = await setup({ color: '#245385' });

      advance(performance.now() + 16);

      expect(context.fillStyle).toBe('#245385');
    });

    /* The point of the split: the radius arrives interpolated, so this loop
       reads it rather than recomputing it.

       3.5 rather than a value like 3.1 because the buffer is Float32Array and
       3.1 reads back as 3.0999999046325684 — exactly representable values keep
       the assertion about the behaviour rather than about float precision. */
    it('draws each particle where and how the simulation says', async () => {
      const { context } = await setup({
        wasm: createWasm({ count: 1, radii: [3.5] }),
      });

      advance(performance.now() + 16);

      expect(context.arc).toHaveBeenNthCalledWith(
        1,
        10,
        20,
        3.5,
        0,
        Math.PI * 2,
      );
    });

    it('queues the next frame', async () => {
      await setup();

      advance(performance.now() + 16);

      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    });
  });

  /* How opacity is arrived at is the simulation's business and is asserted in
     the crate. What matters here is that whatever it wrote reaches the canvas
     unaltered, and that the alpha is reset afterwards so the next thing drawn
     on this context is not silently transparent. */
  describe('alpha', () => {
    it('draws each particle at the alpha the simulation wrote', async () => {
      const alphas: number[] = [];
      const { context } = await setup({
        wasm: createWasm({ count: 2, alphas: [0.5, 0.75] }),
      });

      (context.fill as Mock).mockImplementation(() => {
        alphas.push(context.globalAlpha);
      });

      advance(performance.now() + 16);

      expect(alphas).toEqual([0.5, 0.75]);
    });

    it('restores full alpha when the frame is done', async () => {
      const { context } = await setup({
        wasm: createWasm({ count: 1, alphas: [0.5] }),
      });

      advance(performance.now() + 16);

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
      const { context } = await setup({
        prefersReducedMotion: true,
        wasm: createWasm({ count: 3 }),
      });

      expect(context.arc).toHaveBeenCalledTimes(3);
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

      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 400, clientY: 300 }),
      );
      advance(performance.now() + 16);

      expect((wasm.tick as Mock).mock.calls[0].slice(1)).toEqual([400, 300]);
    });

    /* Parked far enough away that nothing is ever within the bubble radius,
       rather than tracked to an edge where it would still pull particles. */
    it('forgets it when it leaves the window', async () => {
      const { wasm } = await setup();

      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 400, clientY: 300 }),
      );
      window.dispatchEvent(new PointerEvent('pointerleave'));
      advance(performance.now() + 16);

      const [, x, y] = (wasm.tick as Mock).mock.calls[0];

      expect(x).toBeLessThan(-1000);
      expect(y).toBeLessThan(-1000);
    });
  });

  describe('on resize', () => {
    it('reflows the simulation', async () => {
      const { wasm } = await setup();

      window.dispatchEvent(new Event('resize'));

      expect(wasm.resize).toHaveBeenCalledTimes(2);
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
