// «¿Qué cerro es ese?»: la cámara muestra el horizonte y encima los nombres y alturas de las cumbres,
// calculados sin internet con el GPS, la brújula, la inclinación del iPhone y el relieve guardado.
import * as geo from './geo.js';

const FOV_H = 50; // grados visibles a lo ancho con el iPhone vertical (cámara principal, imagen recortada)
const RADIO = 40000; // m
const CURVATURA = 0.87 / (2 * 6371000); // curvatura terrestre con refracción (m por m²)

let ctx = null;
const st = { activo: false, flujo: null, cumbres: [], desde: null, rumbo: null, inclinacion: 0, raf: 0, calculando: false };

export function iniciarCerros(contexto) { ctx = contexto; }

const $ = (s) => document.querySelector(s);

// Ángulo de elevación (grados) desde el observador a un punto a «d» metros y «h» metros de altura.
const elevacion = (h, d, h0) => (Math.atan2(h - h0 - CURVATURA * d * d, d) * 180) / Math.PI;

// Cumbres cercanas y si se ven: se recorre la línea de vista sobre el relieve.
async function calcular(lon, lat, h0) {
  st.calculando = true;
  const lista = await ctx.nav.cumbres([lon, lat], RADIO).catch(() => []);
  const out = [];
  for (const c of lista) {
    const d = geo.distancia(lon, lat, c.lon, c.lat);
    if (d < 150) continue;
    const ele = c.ele ?? (await ctx.relieve.altitud(c.lon, c.lat)) ?? null;
    if (ele == null) continue;
    const ang = elevacion(ele, d, h0);
    // Línea de vista: si algún punto intermedio del terreno queda por encima, la cumbre está tapada.
    let visible = true;
    if (ctx.relieve.disponible()) {
      const pasos = Math.min(60, Math.max(12, Math.round(d / 300)));
      for (let i = 2; i < pasos - 1; i++) {
        const k = i / pasos;
        const h = await ctx.relieve.altitud(lon + (c.lon - lon) * k, lat + (c.lat - lat) * k);
        if (h != null && elevacion(h, d * k, h0) > ang + 0.25) { visible = false; break; }
      }
    }
    out.push({ ...c, ele, d, azimut: geo.azimut(lon, lat, c.lon, c.lat), angulo: ang, visible });
  }
  st.cumbres = out.sort((a, b) => a.d - b.d);
  st.desde = [lon, lat];
  st.calculando = false;
}

function orientacion(e) {
  // Inclinación: con el iPhone vertical (beta ≈ 90°) se mira al horizonte.
  if (e.beta != null) st.inclinacion = st.inclinacion * 0.8 + (e.beta - 90) * 0.2;
}

function dibujar() {
  if (!st.activo) return;
  st.raf = requestAnimationFrame(dibujar);
  const capa = $('#cerros-etiquetas');
  const rumbo = ctx.brujula.rumbo;
  if (rumbo == null) { capa.innerHTML = ''; $('#cerros-estado').textContent = 'Mueve el iPhone en forma de 8 para calibrar la brújula'; return; }
  const w = innerWidth;
  const hgt = innerHeight;
  const fovV = FOV_H * (hgt / w);
  const visibles = st.cumbres.filter((c) => c.visible);
  const html = [];
  const ocupadas = [];
  for (const c of visibles) {
    let dif = c.azimut - rumbo;
    if (dif > 180) dif -= 360;
    if (dif < -180) dif += 360;
    if (Math.abs(dif) > FOV_H / 2 + 3) continue;
    const x = w / 2 + (dif / FOV_H) * w;
    const y = hgt / 2 - ((c.angulo - st.inclinacion) / fovV) * hgt;
    // Evita que las etiquetas se monten: las más lejanas suben un poco.
    let alto = 0;
    while (ocupadas.some((o) => Math.abs(o.x - x) < 120 && Math.abs(o.alto - alto) < 46)) alto += 46;
    ocupadas.push({ x, alto });
    html.push(`<div class="cerro" style="left:${x.toFixed(0)}px;top:${(y - 70 - alto).toFixed(0)}px">
      <div class="cerro-nombre">${ctx.esc(c.nombre)}</div><div class="cerro-dato">${Math.round(c.ele).toLocaleString('es-CL')} m · ${geo.fmtDistancia(c.d)}</div>
      <div class="cerro-linea" style="height:${(54 + alto).toFixed(0)}px"></div></div>`);
  }
  capa.innerHTML = html.join('');
  $('#cerros-estado').textContent = st.calculando ? 'Calculando qué cumbres se ven…'
    : visibles.length ? `${visibles.length} cumbres visibles a menos de 40 km · rumbo ${Math.round(rumbo)}° ${geo.cardinal(rumbo)}`
      : 'No hay cumbres con nombre a la vista desde aquí';
}

export async function abrirCerros() {
  // iOS solo da permiso de brújula y cámara si se piden justo al tocar: van primero.
  if (!(await ctx.brujula.activar().catch(() => false))) {
    return ctx.avisar('Rumbo necesita la brújula: permite «Movimiento y orientación» cuando lo pida.', { duracion: 7000 });
  }
  let flujo;
  try {
    flujo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (_) {
    return ctx.avisar('No pude abrir la cámara. Revisa en Ajustes → Privacidad → Cámara que Rumbo (o Safari) tenga permiso.', { duracion: 8000 });
  }
  const p = ctx.gps.ultima;
  const parar = (texto) => { flujo.getTracks().forEach((t) => t.stop()); ctx.avisar(texto, { duracion: 7000 }); };
  if (!p) return parar('Necesito tu ubicación GPS para saber qué cerros tienes alrededor.');
  await ctx.nav.cumbres([p.coords.longitude, p.coords.latitude], 1).catch(() => []); // carga la red de la región
  if (!ctx.nav.tieneRed()) return parar('Para nombrar los cerros necesitas las rutas sin conexión de la región (Mapas → Regiones).');
  st.flujo = flujo;
  st.activo = true;
  ctx.cerrarHoja();
  const v = $('#cerros-video');
  v.srcObject = flujo;
  v.play().catch(() => {});
  $('#cerros').hidden = false;
  ctx.pantalla.pedir('cerros');
  window.addEventListener('deviceorientation', orientacion);
  const c = p.coords;
  const h0 = ((await ctx.relieve.altitud(c.longitude, c.latitude)) ?? c.altitude ?? 0) + 1.6;
  calcular(c.longitude, c.latitude, h0);
  dibujar();
}

export function cerrarCerros() {
  st.activo = false;
  cancelAnimationFrame(st.raf);
  window.removeEventListener('deviceorientation', orientacion);
  st.flujo?.getTracks().forEach((t) => t.stop());
  st.flujo = null;
  $('#cerros').hidden = true;
  $('#cerros-etiquetas').innerHTML = '';
  ctx.pantalla.soltar('cerros');
}
