// Cálculos y formatos geográficos.
const R = 6371008.8;
const rad = (g) => (g * Math.PI) / 180;
const grad = (r) => (r * 180) / Math.PI;

export function distancia(lon1, lat1, lon2, lat2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function azimut(lon1, lat1, lon2, lat2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (grad(Math.atan2(y, x)) + 360) % 360;
}

const PUNTOS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const cardinal = (g) => PUNTOS[Math.round(((g % 360) + 360) % 360 / 45) % 8];
export const fmtRumbo = (g) => (g == null || Number.isNaN(g) ? '—' : `${Math.round(g) % 360}° ${cardinal(g)}`);

const num = (n, d = 0) => n.toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d });
export function fmtDistancia(m) {
  if (m == null) return '—';
  if (m < 1000) return `${num(Math.round(m))} m`;
  return `${num(m / 1000, m < 10000 ? 2 : 1)} km`;
}
export const fmtAltitud = (m) => (m == null ? '—' : `${num(Math.round(m))} m`);
export const fmtVelocidad = (ms) => (ms == null || ms < 0 ? '—' : `${num(Math.round(ms * 3.6))} km/h`);
export function fmtDuracion(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024 ** 2) return `${num(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${num(b / 1024 ** 2)} MB`;
  return `${num(b / 1024 ** 3, 1)} GB`;
}

function gms(v, pos, neg) {
  const a = Math.abs(v);
  const g = Math.floor(a);
  const m = Math.floor((a - g) * 60);
  const s = ((a - g) * 60 - m) * 60;
  return `${g}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v >= 0 ? pos : neg}`;
}
export const fmtCoordDecimal = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
export const fmtCoordGMS = (lat, lon) => `${gms(lat, 'N', 'S')} ${gms(lon, 'E', 'O')}`;

// Interpreta "-53.16, -70.91", "53.16S 70.91W/O" o "53°09'36"S 70°54'36"O".
export function leerCoordenadas(texto) {
  let t = texto.trim().toUpperCase();
  // Coma decimal ("-53,16 -70,91"): solo si no hay puntos y los números van separados por espacio o ";".
  if (!t.includes('.') && /\d,\d/.test(t) && /[\s;]/.test(t)) t = t.replace(/(\d),(\d)/g, '$1.$2');
  t = t.replace(/[,;]/g, ' ').replace(/\s+/g, ' ');
  const parte = String.raw`(-?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′]?\s*)?(?:(\d+(?:\.\d+)?)\s*["″]?\s*)?([NSEOW])?`;
  const m = new RegExp(`^${parte}\\s*${parte}$`).exec(t);
  if (!m) return null;
  const valor = (g, mi, s, h) => {
    let v = Math.abs(parseFloat(g)) + (mi ? parseFloat(mi) / 60 : 0) + (s ? parseFloat(s) / 3600 : 0);
    if (g.startsWith('-') || h === 'S' || h === 'O' || h === 'W') v = -v;
    return v;
  };
  let a = valor(m[1], m[2], m[3], m[4]);
  let b = valor(m[5], m[6], m[7], m[8]);
  if (m[4] && 'EOW'.includes(m[4])) [a, b] = [b, a];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lon: b };
}

export function circulo(lon, lat, radio, pasos = 48) {
  const coords = [];
  for (let i = 0; i <= pasos; i++) {
    const ang = (i / pasos) * 2 * Math.PI;
    const dx = (radio * Math.cos(ang)) / (R * Math.cos(rad(lat)));
    const dy = (radio * Math.sin(ang)) / R;
    coords.push([lon + grad(dx), lat + grad(dy)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

// ---------- Sol (sin internet) ----------
// Altura del sol sobre el horizonte, en grados.
export function alturaSol(lon, lat, fecha = new Date()) {
  const rad = Math.PI / 180;
  const d = (fecha.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * rad;
  const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const h = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(h)) / rad;
}

const HORIZONTE = -0.833; // borde superior del sol, con refracción

// Próximo cruce del horizonte desde «desde» (subiendo o bajando), dentro de 36 h; null si no hay (verano/invierno polar).
function cruce(lon, lat, desde, subiendo) {
  const paso = 5 * 60000;
  let t = desde.getTime();
  let a = alturaSol(lon, lat, new Date(t)) - HORIZONTE;
  for (let i = 0; i < (36 * 3600000) / paso; i++) {
    const t2 = t + paso;
    const b = alturaSol(lon, lat, new Date(t2)) - HORIZONTE;
    if (subiendo ? a < 0 && b >= 0 : a > 0 && b <= 0) return new Date(t + (paso * a) / (a - b));
    t = t2;
    a = b;
  }
  return null;
}

// Luz del día en un lugar: si es de día, cuándo se pone el sol; si es de noche, cuándo sale.
export function luz(lon, lat, ahora = new Date()) {
  const dia = alturaSol(lon, lat, ahora) > HORIZONTE;
  return { dia, puesta: cruce(lon, lat, ahora, false), salida: cruce(lon, lat, ahora, true) };
}

export const fmtHora = (fecha) => fecha.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// «2 h 10 min» / «45 min»
export function fmtFalta(ms) {
  if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
}
