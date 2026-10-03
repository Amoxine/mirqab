// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Sparkline } from '@open-gateway/ui';

/**
 * A sparkline draws at the width its wrapper has, measured with a ResizeObserver. Its svg is a fixed pixel width,
 * so if it took part in layout it would hold its parents at that width (a grid column of `auto` width is as
 * wide as the card's content): the wrapper could then never get narrower, the observer would never fire, and the
 * page kept the old width after a phone was rotated or a window dragged narrower. jsdom has no layout, so the
 * layout half is asserted as the markup contract it rests on (a wrapper that is the positioning context, an svg
 * that is out of flow); the real layout result is measured in a browser (see the review notes).
 */

let watchers: ((entries: { contentRect: { width: number } }[]) => void)[] = [];
let disconnected = 0;
let measured = 300;

beforeEach(() => {
  watchers = [];
  disconnected = 0;
  measured = 300;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
        watchers.push(callback);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect() {
        disconnected += 1;
      }
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => measured });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

const resize = (width: number) => {
  act(() => {
    for (const watcher of watchers) watcher([{ contentRect: { width } }]);
  });
};
const svgWidth = (container: HTMLElement) => container.querySelector('svg')?.getAttribute('width');

describe('Sparkline', () => {
  it('draws at the width of its wrapper', () => {
    const { container } = render(<Sparkline values={[1, 3, 2, 5]} />);
    expect(svgWidth(container)).toBe('300');
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 300.00 44.00');
  });

  it('follows the wrapper when it gets narrower, and wider again', () => {
    const { container } = render(<Sparkline values={[1, 3, 2, 5]} />);
    resize(120);
    expect(svgWidth(container)).toBe('120');
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 120.00 44.00');
    resize(410);
    expect(svgWidth(container)).toBe('410');
  });

  it('keeps its end point on the line as the width changes', () => {
    const { container } = render(<Sparkline values={[1, 3, 2, 5]} />);
    resize(100);
    expect(Number(container.querySelector('circle')?.getAttribute('cx'))).toBeCloseTo(95, 1);
    resize(200);
    expect(Number(container.querySelector('circle')?.getAttribute('cx'))).toBeCloseTo(195, 1);
  });

  it('keeps its svg out of flow, in a wrapper that has the height, so the svg adds nothing to its parents’ intrinsic width', () => {
    const { container } = render(<Sparkline values={[1, 3, 2, 5]} height={44} />);
    const wrapper = container.firstElementChild as HTMLElement;
    const svg = container.querySelector('svg');
    // The wrapper is the containing block and carries the height itself, since its child no longer holds any.
    expect(wrapper.className.split(' ')).toContain('relative');
    expect(wrapper.style.height).toBe('44px');
    expect(svg?.getAttribute('class')?.split(' ')).toContain('absolute');
  });

  it('keeps a caller’s class on the wrapper, next to what it needs', () => {
    const { container } = render(<Sparkline values={[1, 3]} className="mt-2 w-full" />);
    expect(container.firstElementChild?.className.split(' ')).toEqual(expect.arrayContaining(['mt-2', 'w-full', 'relative']));
  });

  it('draws nothing until it has a width, and nothing for fewer than two values', () => {
    measured = 0;
    const first = render(<Sparkline values={[1, 3, 2]} />);
    expect(first.container.querySelector('svg')).toBeNull();
    resize(250);
    expect(svgWidth(first.container)).toBe('250');
    first.unmount();
    measured = 300;
    const second = render(<Sparkline values={[4]} />);
    expect(second.container.querySelector('svg')).toBeNull();
  });

  it('stops watching when it goes away', () => {
    const { unmount } = render(<Sparkline values={[1, 3]} />);
    unmount();
    expect(disconnected).toBe(1);
  });
});
