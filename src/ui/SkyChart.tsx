/**
 * Local-sky chart: a polar azimuth/elevation plot of a predicted pass.
 *
 * Convention (labelled on the chart): the outer ring is the horizon, the
 * centre is the zenith, azimuth runs clockwise from north at the top. The
 * plotted path is the *predicted* trajectory across the observer's sky; the
 * marker shows the object's calculated position at the shared simulation time
 * and only appears while that time falls inside the pass window.
 */
import { memo, useEffect, useMemo, useRef } from 'react';
import type { SatRec } from 'satellite.js';
import {
  compassPoint,
  lookAnglesAt,
  type ObserverLocation,
  type PredictedPass,
} from '../orbital/observer';

export interface SkyChartProps {
  satrec: SatRec;
  noradId: number;
  observer: ObserverLocation;
  pass: PredictedPass;
  /** Shared simulation time, ms. Drives the marker — nothing else. */
  simTimeMs: number;
  /** Solar altitude at the observer for the day/night backdrop, degrees. */
  sunAltitudeDeg: number;
}

interface PathPoint {
  az: number;
  el: number;
  t: number;
}

function pathForPass(
  satrec: SatRec,
  noradId: number,
  observer: ObserverLocation,
  pass: PredictedPass,
): PathPoint[] {
  const points: PathPoint[] = [];
  // Extend slightly past rise/set so the horizon crossings are visible.
  const start = pass.rise.timeMs - 60_000;
  const end = pass.set.timeMs + 60_000;
  const span = Math.max(60_000, end - start);
  const steps = Math.min(240, Math.max(48, Math.round(span / 15_000)));
  for (let i = 0; i <= steps; i++) {
    const t = start + (span * i) / steps;
    const look = lookAnglesAt(satrec, noradId, observer, t);
    if (look) points.push({ az: look.azimuthDeg, el: look.elevationDeg, t });
  }
  return points;
}

function polar(azDeg: number, elDeg: number, cx: number, cy: number, radius: number): { x: number; y: number } {
  // Elevation 90° -> centre, 0° -> rim; points below the horizon clamp outward.
  const el = Math.max(-10, Math.min(90, elDeg));
  const r = radius * (1 - el / 90);
  const theta = ((azDeg - 90) * Math.PI) / 180; // 0° = north (up), clockwise
  return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) };
}

export const SkyChart = memo(function SkyChart(props: SkyChartProps) {
  const { satrec, noradId, observer, pass, simTimeMs, sunAltitudeDeg } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const path = useMemo(
    () => pathForPass(satrec, noradId, observer, pass),
    [satrec, noradId, observer, pass],
  );

  const marker = useMemo(() => {
    if (simTimeMs < pass.rise.timeMs - 120_000 || simTimeMs > pass.set.timeMs + 120_000) return null;
    return lookAnglesAt(satrec, noradId, observer, simTimeMs);
  }, [satrec, noradId, observer, simTimeMs, pass]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const size = Math.min(560, Math.max(280, wrap.clientWidth));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 34;

    // Backdrop: day/twilight/night tint from the solar altitude.
    const dayMix = Math.max(0, Math.min(1, (sunAltitudeDeg + 12) / 18));
    const bgTop = mixColor([7, 12, 22], [38, 74, 120], dayMix);
    const bgBottom = mixColor([4, 7, 14], [24, 48, 82], dayMix);
    const bg = ctx.createLinearGradient(0, 0, 0, size);
    bg.addColorStop(0, bgTop);
    bg.addColorStop(1, bgBottom);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 26, 0, Math.PI * 2);
    ctx.fill();

    // Elevation rings.
    ctx.lineWidth = 1;
    for (const el of [0, 30, 60]) {
      const rr = radius * (1 - el / 90);
      ctx.strokeStyle = el === 0 ? 'rgba(160, 200, 240, 0.55)' : 'rgba(140, 170, 210, 0.22)';
      ctx.setLineDash(el === 0 ? [] : [3, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Cardinal spokes + labels.
    ctx.fillStyle = 'rgba(205, 222, 242, 0.9)';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cardinals: Array<[string, number]> = [
      ['N', 0],
      ['E', 90],
      ['S', 180],
      ['W', 270],
    ];
    for (const [label, az] of cardinals) {
      const p = polar(az, -6, cx, cy, radius);
      ctx.fillText(label, p.x, p.y);
      ctx.strokeStyle = 'rgba(140, 170, 210, 0.14)';
      const inner = polar(az, 90, cx, cy, radius);
      const outer = polar(az, 0, cx, cy, radius);
      ctx.beginPath();
      ctx.moveTo(inner.x, inner.y);
      ctx.lineTo(outer.x, outer.y);
      ctx.stroke();
    }
    // Zenith + elevation captions.
    ctx.fillStyle = 'rgba(205, 222, 242, 0.55)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('zenith', cx, cy - 8);
    ctx.fillText('horizon', cx, cy + radius + 14);

    // Predicted path.
    if (path.length > 1) {
      // Below-horizon lead-in/out: faint dashed.
      drawPathSegment(ctx, path.filter((p) => p.el < 0), cx, cy, radius, 'rgba(120, 150, 190, 0.35)', true);
      drawPathSegment(ctx, path.filter((p) => p.el >= -0.5), cx, cy, radius, '#7fd3ff', false);
    }

    // Rise / peak / set markers.
    const ends: Array<{ az: number; el: number; label: string; color: string }> = [
      { az: pass.rise.azimuthDeg, el: 0, label: `Rise ${compassPoint(pass.rise.azimuthDeg)}`, color: '#8fd0a8' },
      { az: pass.peak.azimuthDeg, el: pass.peak.elevationDeg, label: `Peak ${pass.peak.elevationDeg.toFixed(0)}°`, color: '#ffd479' },
      { az: pass.set.azimuthDeg, el: 0, label: `Set ${compassPoint(pass.set.azimuthDeg)}`, color: '#e89a8a' },
    ];
    ctx.font = '11px system-ui, sans-serif';
    for (const end of ends) {
      const p = polar(end.az, Math.max(0, end.el), cx, cy, radius);
      ctx.fillStyle = end.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = end.az > 90 && end.az < 270 ? 'right' : 'left';
      ctx.fillText(end.label, p.x + (end.az > 90 && end.az < 270 ? -8 : 8), p.y - 8);
    }
    ctx.textAlign = 'center';

    // Live marker at the shared simulation time.
    if (marker && Number.isFinite(marker.azimuthDeg) && Number.isFinite(marker.elevationDeg)) {
      const aboveHorizon = marker.elevationDeg >= 0;
      const p = polar(marker.azimuthDeg, marker.elevationDeg, cx, cy, radius);
      ctx.fillStyle = aboveHorizon ? '#ffffff' : 'rgba(200, 210, 225, 0.5)';
      ctx.strokeStyle = '#56a5ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (!aboveHorizon) {
        ctx.fillStyle = 'rgba(205, 222, 242, 0.75)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText('below horizon at replay time', cx, cy - radius - 14);
      }
    }
  }, [path, marker, pass, sunAltitudeDeg]);

  const description =
    `Sky chart for the selected pass. Rise ${compassPoint(pass.rise.azimuthDeg)} at ` +
    `${pass.rise.elevationDeg.toFixed(1)} degrees, peak elevation ` +
    `${pass.maxElevationDeg.toFixed(1)} degrees toward ${compassPoint(pass.peak.azimuthDeg)}, ` +
    `set ${compassPoint(pass.set.azimuthDeg)}. North is up, the outer ring is the horizon.`;

  return (
    <div className="sky-chart-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label={description} />
      <p className="sky-chart-caption">
        Predicted path across your sky · marker = calculated position at replay time
      </p>
    </div>
  );
});

function drawPathSegment(
  ctx: CanvasRenderingContext2D,
  points: PathPoint[],
  cx: number,
  cy: number,
  radius: number,
  style: string,
  dashed: boolean,
): void {
  if (points.length < 2) return;
  ctx.strokeStyle = style;
  ctx.lineWidth = dashed ? 1.5 : 2.5;
  ctx.setLineDash(dashed ? [4, 4] : []);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((p, i) => {
    const { x, y } = polar(p.az, p.el, cx, cy, radius);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

function mixColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
