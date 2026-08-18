import type { Mock } from 'vitest';

import {
  bubbleOpacityFor,
  createField,
  defaultOpacity,
  options,
} from './index';

/* A stand-in for the compiled module. The simulation itself is tested in Rust
   with cargo; what matters here is that this half drives it correctly and
   draws what it reports. */
const stride = 5;

type WasmOptions = {
  count?: number;
  /* Bubble progress per particle, 0 at rest and 1 fully bubbled. */
  bubbles?: number[];
};

const createWasm = ({ count = 2, bubbles = [] }: WasmOptions = {}) => {
  const buffer = new ArrayBuffer(count * stride * 4);
  const view = new Float32Array(buffer);

  for (let i = 0; i < count; i++) {
    view[i * stride] = 10 + i;
    view[i * stride + 1] = 20 + i;
    view[i * stride + 4] = bubbles[i] ?? 0;
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
  /* Whether the canvas yields a 2D context at all. A flag rather than a
     nullable context, so `context` below is never null and the assertions do
     not have to chain through it. */
  hasContext?: boolean;
  ratio?: number;
  clientWidth?: number;
  clientHeight?: number;
};

const setup = async ({
  wasm = createWasm(),
  color = '#245385',
  opacity,
  hasContext = true,
  ratio = 1,
  clientWidth = 1280,
  clientHeight = 800,
}: Options = {}) => {
  const context = createContext();
  vi.stubGlobal('devicePixelRatio', ratio);
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

  const field = await createField(canvas, { color, opacity });

  return { field, wasm, context, canvas };
};

/* Runs the frame the loop has queued, and returns the next one. */
const advance = (at: number): void => {
  const queued = (requestAnimationFrame as Mock).mock.calls.at(-1)?.[0];

  queued?.(at);
};

describe('createField', () => {
  beforeEach(() => {
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
      options.bubbleDistance,
    );
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

    it('draws each particle where the simulation put it', async () => {
      const { context } = await setup({ wasm: createWasm({ count: 1 }) });

      advance(performance.now() + 16);

      expect(context.arc).toHaveBeenNthCalledWith(
        1,
        10,
        20,
        options.size,
        0,
        Math.PI * 2,
      );
    });

    /* The bubble is one number per particle; size and opacity are interpolated
       across it here rather than in the simulation. */
    it('grows a fully bubbled particle to the bubble size', async () => {
      const { context } = await setup({
        wasm: createWasm({ count: 1, bubbles: [1] }),
      });

      advance(performance.now() + 16);

      expect((context.arc as Mock).mock.calls[0][2]).toBe(options.bubbleSize);
    });

    it('interpolates size across a partial bubble', async () => {
      const { context } = await setup({
        wasm: createWasm({ count: 1, bubbles: [0.5] }),
      });

      advance(performance.now() + 16);

      expect((context.arc as Mock).mock.calls[0][2]).toBeCloseTo(
        options.size + (options.bubbleSize - options.size) * 0.5,
      );
    });

    it('queues the next frame', async () => {
      await setup();

      advance(performance.now() + 16);

      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    });
  });

  describe('opacity', () => {
    it('rests at the default when none is given', async () => {
      const { context } = await setup({ wasm: createWasm({ count: 1 }) });

      advance(performance.now() + 16);

      expect(context.globalAlpha).toBe(1);
      expect((context.arc as Mock).mock.calls).toHaveLength(1);
    });

    /* A dark colour at 0.3 over a near-white page composites to something
       close to grey, so a light page needs more of it. */
    it('rests at the opacity it is given', async () => {
      const alphas: number[] = [];
      const { context } = await setup({
        wasm: createWasm({ count: 1 }),
        opacity: 0.55,
      });

      (context.fill as Mock).mockImplementation(() => {
        alphas.push(context.globalAlpha);
      });

      advance(performance.now() + 16);

      expect(alphas).toEqual([0.55]);
    });

    /* Twice the resting opacity, as the original config had at 0.3 and 0.6 —
       derived, so raising one cannot invert the relationship. */
    it('doubles the opacity for a fully bubbled particle', async () => {
      const alphas: number[] = [];
      const { context } = await setup({
        wasm: createWasm({ count: 1, bubbles: [1] }),
        opacity: 0.4,
      });

      (context.fill as Mock).mockImplementation(() => {
        alphas.push(context.globalAlpha);
      });

      advance(performance.now() + 16);

      expect(alphas).toEqual([0.8]);
    });

    it('never exceeds full opacity', () => {
      expect(bubbleOpacityFor(0.7)).toBe(1);
      expect(bubbleOpacityFor(defaultOpacity)).toBeCloseTo(0.6);
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
