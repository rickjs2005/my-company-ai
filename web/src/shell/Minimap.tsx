// Minimapa: desenha getMinimap() da cena num canvas pequeno; clique = lookAt no ponto.
import { useEffect, useRef } from 'react';
import type { OfficeScene } from '../scene/types';

export interface MinimapProps {
  scene: OfficeScene | null;
  width?: number;
  height?: number;
  onLookAt(pos: { x: number; y: number }): void;
}

/** Fração da planta visível (em cada eixo) a partir da qual o minimapa se esconde. */
const MOSTLY_VISIBLE = 0.9;

export function Minimap({ scene, width = 180, height = 110, onLookAt }: MinimapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene); sceneRef.current = scene;

  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    let raf = 0; let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 200) return; // 5x por segundo é suficiente
      last = t;
      const s = sceneRef.current; if (!s) return;
      let m; try { m = s.getMinimap(); } catch { return; }
      if (!m || !m.world.w || !m.world.h) return;
      // Com quase a planta inteira à vista, o minimapa não ajuda e só cobre salas: some até a câmera aproximar.
      const coverX = (Math.min(m.view.x + m.view.w, m.world.w) - Math.max(m.view.x, 0)) / m.world.w;
      const coverY = (Math.min(m.view.y + m.view.h, m.world.h) - Math.max(m.view.y, 0)) / m.world.h;
      const hide = coverX >= MOSTLY_VISIBLE && coverY >= MOSTLY_VISIBLE;
      if (canvas.style.display !== (hide ? 'none' : '')) canvas.style.display = hide ? 'none' : '';
      if (hide) return;
      const sx = width / m.world.w, sy = height / m.world.h, k = Math.min(sx, sy);
      const ox = (width - m.world.w * k) / 2, oy = (height - m.world.h * k) / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(18,16,20,0.92)'; ctx.fillRect(0, 0, width, height);
      for (const r of m.rooms) {
        ctx.fillStyle = r.color; ctx.globalAlpha = 0.28; ctx.fillRect(ox + r.x * k, oy + r.y * k, r.w * k, r.h * k);
        ctx.globalAlpha = 0.9; ctx.strokeStyle = r.color; ctx.lineWidth = 1; ctx.strokeRect(ox + r.x * k + 0.5, oy + r.y * k + 0.5, r.w * k - 1, r.h * k - 1);
      }
      ctx.globalAlpha = 1;
      for (const w of m.workers) { ctx.fillStyle = w.color; ctx.fillRect(ox + w.x * k - 1.5, oy + w.y * k - 1.5, 3, 3); }
      if (m.player) { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(ox + m.player.x * k, oy + m.player.y * k, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#f0a830'; ctx.lineWidth = 1.2; ctx.stroke(); }
      ctx.strokeStyle = 'rgba(240,168,48,0.9)'; ctx.lineWidth = 1; ctx.strokeRect(ox + m.view.x * k + 0.5, oy + m.view.y * k + 0.5, Math.max(2, m.view.w * k - 1), Math.max(2, m.view.h * k - 1));
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = sceneRef.current; if (!s) return;
    let m; try { m = s.getMinimap(); } catch { return; }
    if (!m.world.w || !m.world.h) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const k = Math.min(width / m.world.w, height / m.world.h);
    const ox = (width - m.world.w * k) / 2, oy = (height - m.world.h * k) / 2;
    onLookAt({ x: (e.clientX - rect.left - ox) / k, y: (e.clientY - rect.top - oy) / k });
  };

  return <canvas ref={ref} className="hq-minimap" style={{ width, height }} onClick={onClick} role="img" aria-label="Minimapa do escritório (clique para olhar um ponto)" title="Minimapa: clique para mover a câmera" />;
}
