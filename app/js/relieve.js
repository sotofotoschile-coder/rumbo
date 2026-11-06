// Relieve sin conexión: altitud de cualquier punto y perfiles de subida y bajada,
// leyendo el modelo de elevación (teselas "terrarium") guardado en el iPhone.
import * as mapas from './mapas.js';

const Z = 11; // nivel de las teselas de elevación (≈ 45 m por píxel en Magallanes)
let pm = null;
const cache = new Map(); // "z/x/y" → Float32Array de 256×256 (o null si no hay tesela)

export const estado = { urlRelieve: null, urlCurvas: null };

const contiene = (lim, p) => lim && p && p[0] >= lim[0] && p[0] <= lim[2] && p[1] >= lim[1] && p[1] <= lim[3];

// Carga el relieve y las curvas de la región que contiene el punto (o los primeros instalados).
export async function cargar(punto = null) {
  const elegir = (lista) => lista.find((r) => contiene(r.limites, punto)) || lista[0];
  const rel = elegir(await mapas.listarDatos('relieve'));
  const cur = elegir(await mapas.listarDatos('curvas'));
  if (rel?.id === estado.idRelieve && cur?.id === estado.idCurvas && (rel || cur)) return true;
  estado.idRelieve = rel?.id;
  estado.idCurvas = cur?.id;
  pm = null;
  estado.urlRelieve = null;
  estado.urlCurvas = null;
  cache.clear();
  if (rel) { const a = await mapas.abrirPmtiles(rel); pm = a.pm; estado.urlRelieve = a.url; }
  if (cur) estado.urlCurvas = (await mapas.abrirPmtiles(cur)).url;
  return !!(rel || cur);
}

export const disponible = () => !!pm;

async function tesela(x, y) {
  const k = `${x}/${y}`;
  if (cache.has(k)) return cache.get(k);
  let alturas = null;
  const r = await pm.getZxy(Z, x, y).catch(() => null);
  if (r?.data) {
    const bmp = await createImageBitmap(new Blob([r.data], { type: 'image/png' }));
    const lienzo = new OffscreenCanvas(256, 256);
    const g = lienzo.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, 256, 256).data;
    alturas = new Float32Array(256 * 256);
    for (let i = 0; i < alturas.length; i++) alturas[i] = px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768;
  }
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(k, alturas);
  return alturas;
}

// Altitud (m) en un punto, o null si no hay relieve instalado para esa zona.
export async function altitud(lon, lat) {
  if (!pm) return null;
  const n = 2 ** Z;
  const r = (lat * Math.PI) / 180;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  const alturas = await tesela(x, y);
  if (!alturas) return null;
  const px = Math.min(255, Math.floor((fx - x) * 256));
  const py = Math.min(255, Math.floor((fy - y) * 256));
  return Math.max(0, alturas[py * 256 + px]);
}

// Perfil a lo largo de una línea: [[distancia acumulada m, altitud m], ...] con ~muestras puntos.
export async function perfil(coords, acum, muestras = 140) {
  if (!pm || coords.length < 2) return null;
  const total = acum[acum.length - 1];
  const paso = total / muestras;
  const out = [];
  let i = 0;
  for (let d = 0; d <= total + 1e-6; d += paso) {
    while (i < acum.length - 2 && acum[i + 1] < d) i++;
    const k = (d - acum[i]) / ((acum[i + 1] - acum[i]) || 1);
    const lon = coords[i][0] + k * (coords[i + 1][0] - coords[i][0]);
    const lat = coords[i][1] + k * (coords[i + 1][1] - coords[i][1]);
    const h = await altitud(lon, lat);
    if (h != null) out.push([d, h]);
  }
  if (out.length < 2) return null;
  // Subida y bajada acumuladas (con un umbral para no sumar ruido del modelo).
  let subida = 0, bajada = 0, ref = out[0][1];
  for (const [, h] of out) {
    if (h - ref >= 3) { subida += h - ref; ref = h; } else if (ref - h >= 3) { bajada += ref - h; ref = h; }
  }
  return { puntos: out, subida, bajada, min: Math.min(...out.map((p) => p[1])), max: Math.max(...out.map((p) => p[1])) };
}

// Dibujo SVG simple del perfil (mismo estilo que el de los tracks).
export function svgPerfil(p, color = '#8B6B4A') {
  if (!p) return '';
  const dMax = p.puntos.at(-1)[0] || 1;
  const rango = Math.max(p.max - p.min, 10);
  const pts = p.puntos.map(([d, a]) => `${((d / dMax) * 300).toFixed(1)},${(78 - ((a - p.min) / rango) * 70).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 300 80" preserveAspectRatio="none" style="width:100%;height:84px;display:block" aria-hidden="true">
    <polygon points="0,80 ${pts} 300,80" fill="${color}" opacity=".2"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
