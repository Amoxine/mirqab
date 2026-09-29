'use client';

import * as React from 'react';
import { cn } from '../lib/utils';
import { WORLD_MAP } from './world-map-data';

const { cols, rows, lon0, lat1, step, k, data } = WORLD_MAP;
const LON_SPAN = (cols * step) / k;
const LAT_SPAN = rows * step;

/** Position of a coordinate as fractions (0-1) of the map's width and height. */
export function projectToMap(lat: number, lon: number): [x: number, y: number] {
  return [(lon - lon0) / LON_SPAN, (lat1 - lat) / LAT_SPAN];
}

/** Whether the map's crop (lon -92..31, lat 14..64) contains the coordinate. */
export function isOnMap(lat: number, lon: number): boolean {
  const [x, y] = projectToMap(lat, lon);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

const isLand = (row: number, col: number) =>
  (parseInt(data[row * (cols / 4) + (col >> 2)] ?? '0', 16) >> (3 - (col & 3))) & 1;

export interface WorldMapNode {
  id: string;
  /** Main line of the pin's label card. */
  title: string;
  /** Small mono line above the title (an airport / region code). */
  code?: string;
  /** Small mono line under the title. */
  detail?: string;
  lat: number;
  lon: number;
  /** A down node is drawn in the destructive colour and does not pulse. */
  up: boolean;
  /** Where the label card sits relative to the pin; `start` anchors it to the pin's start edge. */
  placement?: 'above' | 'below' | 'start';
}

/** `rgba(r,g,b,a)` for a colour triple. */
const rgba = ([r, g, b]: [number, number, number], a: number) =>
  `rgba(${String(r)},${String(g)},${String(b)},${String(a)})`;

/** Any CSS colour → [r, g, b], via a canvas (which normalises what it is given to `#rrggbb`). */
function toRgb(
  ctx: CanvasRenderingContext2D,
  css: string,
  fallback: string,
): [number, number, number] {
  ctx.fillStyle = fallback;
  ctx.fillStyle = css || fallback;
  const resolved: unknown = ctx.fillStyle; // normalised to `#rrggbb` for opaque colours
  const n = parseInt(typeof resolved === 'string' ? resolved.slice(1) : '0', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawMap(canvas: HTMLCanvasElement, nodes: WorldMapNode[]) {
  const box = canvas.getBoundingClientRect();
  const ctx = canvas.getContext('2d');
  if (!box.width || !ctx) return;
  const W = box.width;
  const H = box.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const css = getComputedStyle(canvas);
  const muted = css.getPropertyValue('--color-muted-foreground').trim() || '#475569';
  const dot = css.getPropertyValue('--color-grid-dot').trim() || '#c4ceda';
  const rgb = toRgb(ctx, css.getPropertyValue('--color-primary').trim(), '#087482');
  const glow = document.documentElement.classList.contains('dark') ? 0.26 : 0.1;

  // Graticule: 10° parallels, 15° meridians.
  ctx.strokeStyle = muted;
  ctx.globalAlpha = 0.13;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let lat = 20; lat <= 60; lat += 10) {
    const y = Math.round(projectToMap(lat, 0)[1] * H) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  for (let lon = -90; lon <= 30; lon += 15) {
    const x = Math.round(projectToMap(0, lon)[0] * W) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Land, one dot per cell.
  const cw = W / cols;
  const ch = H / rows;
  const r = Math.max(0.7, Math.min(cw, ch) * 0.34);
  ctx.fillStyle = dot;
  ctx.beginPath();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!isLand(row, col)) continue;
      const x = (col + 0.5) * cw;
      const y = (row + 0.5) * ch;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();

  // Tint the land around each healthy node, then a soft halo behind it.
  const spots = nodes
    .filter((n) => n.up)
    .map((n) => {
      const [fx, fy] = projectToMap(n.lat, n.lon);
      return { x: fx * W, y: fy * H, R: W * 0.11 };
    });
  ctx.globalCompositeOperation = 'source-atop';
  for (const { x, y, R } of spots) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, rgba(rgb, 1));
    g.addColorStop(0.45, rgba(rgb, 0.55));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - R, y - R, R * 2, R * 2);
  }
  ctx.globalCompositeOperation = 'destination-over';
  for (const { x, y, R } of spots) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, R * 1.25);
    g.addColorStop(0, rgba(rgb, glow));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - R * 1.3, y - R * 1.3, R * 2.6, R * 2.6);
  }
  ctx.globalCompositeOperation = 'source-over';
}

interface WorldMapProps {
  nodes: WorldMapNode[];
  label: string;
  className?: string;
  /**
   * Fill the parent's box (which needs a definite size) instead of keeping the map's own aspect
   * ratio: the map is scaled up until it covers the box, cropped, and centred on the nodes, so the
   * card around it has no empty bands. Without it the map is as wide as its parent and as tall as
   * its ratio allows.
   */
  cover?: boolean;
}

/** Height of the map over its width: the reciprocal of its 128:67 aspect ratio. */
const MAP_RATIO = 128 / 67;

/**
 * A dot-matrix map with a pin and label card per node, at its real coordinates. The geometry is
 * always left-to-right; `aria-label` should describe the nodes because the pins are decorative to
 * assistive tech (list them as text next to the map).
 */
export function WorldMap({ cover = false, ...props }: WorldMapProps) {
  if (!cover) return <MapSurface {...props} />;

  const spots = props.nodes
    .filter((n) => isOnMap(n.lat, n.lon))
    .map((n) => projectToMap(n.lat, n.lon));
  const cx = spots.length ? spots.reduce((s, [x]) => s + x, 0) / spots.length : 0.5;
  const cy = spots.length ? spots.reduce((s, [, y]) => s + y, 0) / spots.length : 0.5;
  // The map is at least as wide as the box and at least as tall as it (`--w` is its width);
  // it is then slid so the nodes' centre sits mid-box, but never far enough to expose a blank edge.
  const style = {
    '--w': `max(100cqw, calc(100cqh * ${String(MAP_RATIO)}))`,
    width: 'var(--w)',
    left: `clamp(calc(100cqw - var(--w)), calc(50cqw - ${String(cx)} * var(--w)), 0px)`,
    top: `clamp(calc(100cqh - var(--w) / ${String(MAP_RATIO)}), calc(50cqh - ${String(cy)} * var(--w) / ${String(MAP_RATIO)}), 0px)`,
  } as React.CSSProperties;

  return (
    <div className="relative size-full overflow-hidden [container-type:size]">
      <MapSurface {...props} className={cn('absolute max-w-none', props.className)} style={style} />
    </div>
  );
}

function MapSurface({
  nodes,
  label,
  className,
  style,
}: Omit<WorldMapProps, 'cover'> & { style?: React.CSSProperties }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const placed = nodes.filter((n) => isOnMap(n.lat, n.lon));

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () => {
      drawMap(canvas, placed);
    };
    paint();
    // Redraw on resize and when the theme class flips (the dots and glow are theme colours).
    const resize = new ResizeObserver(paint);
    resize.observe(canvas);
    const theme = new MutationObserver(paint);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      resize.disconnect();
      theme.disconnect();
    };
    // `placed` is rebuilt every render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(placed.map((n) => [n.id, n.lat, n.lon, n.up]))]);

  return (
    <div
      dir="ltr"
      role="img"
      aria-label={label}
      className={cn('relative aspect-[128/67] w-full', className)}
      style={style}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 size-full [mask-image:linear-gradient(90deg,transparent,#000_9%,#000_91%,transparent)]"
      />
      <div className="absolute inset-0" aria-hidden="true">
        {placed.map((node, i) => {
          const [fx, fy] = projectToMap(node.lat, node.lon);
          const placement = node.placement ?? 'above';
          return (
            <div
              key={node.id}
              className="absolute size-0"
              style={{ left: `${String(fx * 100)}%`, top: `${String(fy * 100)}%` }}
            >
              <span
                className={cn(
                  'bg-card/85 absolute w-max max-w-44 rounded-xl border px-2.5 py-1.5 text-start shadow-md backdrop-blur-md',
                  placement === 'below' ? 'top-5' : 'bottom-5',
                  placement === 'start' ? 'left-0 -translate-x-4' : 'left-0 -translate-x-1/2',
                )}
                dir="auto"
              >
                {node.code && (
                  <span
                    className={cn(
                      'block truncate font-mono text-[0.66rem]',
                      node.up ? 'text-primary' : 'text-destructive',
                    )}
                  >
                    {node.code}
                  </span>
                )}
                <strong className="block truncate text-[0.82rem] font-medium leading-tight">
                  {node.title}
                </strong>
                {node.detail && (
                  <span className="text-muted-foreground block truncate font-mono text-[0.66rem]">
                    {node.detail}
                  </span>
                )}
              </span>
              <span className="absolute -left-[11px] -top-[11px] block size-[22px]">
                {node.up && (
                  <span
                    className="ui-pulse-ring border-primary absolute inset-0 rounded-full border-[1.5px]"
                    style={{ animationDelay: `${String(i * 0.9)}s` }}
                  />
                )}
                <svg viewBox="0 0 24 24" className="relative block size-[22px] overflow-visible">
                  <path
                    d="M12 2.2 20.6 7.1v9.8L12 21.8 3.4 16.9V7.1Z"
                    fill={node.up ? 'var(--color-primary)' : 'var(--color-destructive)'}
                    stroke="var(--color-background)"
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                  />
                  <circle cx={12} cy={12} r={3} fill="var(--color-background)" />
                </svg>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
