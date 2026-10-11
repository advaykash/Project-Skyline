/**
 * Planetary Kp history chart (canvas bar chart).
 *
 * Shows measured 3-hourly Kp values only — no interpolation, no forecast
 * blending. Bars at or above Kp 5 (storm level) are highlighted and the G-scale
 * boundary is labelled.
 */
import { memo, useEffect, useRef } from 'react';
import type { KpSample } from '../data/spaceweather';

export interface KpChartProps {
  samples: KpSample[];
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

export const KpChart = memo(function KpChart(props: KpChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { samples } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const width = Math.max(300, wrap.clientWidth);
    const height = 260;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const padLeft = 34;
    const padRight = 12;
    const padTop = 16;
    const padBottom = 30;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    const maxKp = 9;
    const y = (kp: number) => padTop + plotH - (kp / maxKp) * plotH;

    // Gridlines + y labels.
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const kp of [0, 3, 5, 7, 9]) {
      ctx.strokeStyle = kp === 5 ? 'rgba(232, 154, 138, 0.6)' : 'rgba(140, 170, 210, 0.18)';
      ctx.setLineDash(kp === 5 ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(padLeft, y(kp));
      ctx.lineTo(width - padRight, y(kp));
      ctx.stroke();
      ctx.fillStyle = kp === 5 ? 'rgba(232, 154, 138, 0.95)' : 'rgba(205, 222, 242, 0.6)';
      ctx.fillText(kp === 5 ? '5 storm' : String(kp), padLeft - 6, y(kp));
    }
    ctx.setLineDash([]);

    // Bars.
    const n = samples.length;
    const slot = plotW / Math.max(1, n);
    const barW = Math.max(2, Math.min(18, slot * 0.62));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastDay = '';
    samples.forEach((sample, i) => {
      const x = padLeft + slot * i + (slot - barW) / 2;
      const storm = sample.kp >= 5;
      ctx.fillStyle = storm ? '#e89a8a' : '#56a5ff';
      ctx.globalAlpha = storm ? 0.95 : 0.8;
      const barTop = y(Math.min(maxKp, sample.kp));
      ctx.fillRect(x, barTop, barW, y(0) - barTop);
      ctx.globalAlpha = 1;
      const day = dayLabel(sample.time);
      if (day !== lastDay) {
        lastDay = day;
        ctx.fillStyle = 'rgba(205, 222, 242, 0.55)';
        ctx.fillText(day, x + barW / 2, y(0) + 6);
      }
    });

    ctx.fillStyle = 'rgba(205, 222, 242, 0.55)';
    ctx.textAlign = 'left';
    ctx.fillText('Kp (3-hourly, UTC days)', padLeft, 4);
  }, [samples]);

  return (
    <div className="kp-chart-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Planetary Kp history chart with ${samples.length} three-hourly measurements.`}
      />
    </div>
  );
});
