// Folha de personagens (só desenvolvimento): os oito estilos de cabelo de frente, para conferir rosto, cabelo e
// proporções sem o escritório em volta. Aberta por piloto.html?sheet=1.
import * as THREE from 'three';
import { Character, lookFor, type Activity, type HairStyle } from './character';

export function runSheet(canvas: HTMLCanvasElement, activity: Activity = 'stand'): void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#fff5fa', '#e9cdb6', 1.35));
  const sun = new THREE.DirectionalLight('#fff0d6', 2.3); sun.position.set(-4, 8, 10); scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), new THREE.MeshToonMaterial({ color: '#e6cba6' }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const styles: HairStyle[] = ['short', 'bob', 'long', 'ponytail', 'bun', 'curly', 'quiff', 'wavy'];
  const chars = styles.map((st, i) => {
    const c = new Character(`folha-${i}`, lookFor(`folha-${i}`, { skin: i % 6, hair: i, shirt: i }, i === 1 ? 'edição de vídeo' : i === 2 ? 'revisão' : 'criação', { hairStyle: st }));
    c.place((i - 3.5) * 0.9, 0, 0);
    c.activity = activity;
    scene.add(c.root);
    return c;
  });
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 100);
  const resize = () => {
    const w = canvas.parentElement!.clientWidth, h = canvas.parentElement!.clientHeight;
    renderer.setSize(w, h, false); canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  resize();
  camera.position.set(1.2, 1.9, 9.5); camera.lookAt(0, 1.05, 0);
  let last = performance.now(); let t = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    for (const c of chars) c.update(dt, t);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener('resize', resize);
  (window as unknown as { sheet: { chars: Character[]; camera: THREE.PerspectiveCamera } }).sheet = { chars, camera };
}
