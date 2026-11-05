// Grabación de recorridos GPS y exportación GPX.
import { db, nuevoId } from './db.js';
import { distancia } from './geo.js';

const PRECISION_MAXIMA = 40; // metros: ignorar posiciones peores
const UMBRAL_DESNIVEL = 5; // metros: filtra el ruido de la altitud GPS

export class Grabador extends EventTarget {
  constructor() {
    super();
    this.track = null;
    this.estado = 'detenido'; // detenido | grabando | pausado
    this.sinGuardar = 0;
    this.altRef = null;
  }

  // Si la app se cerró grabando, el track queda abierto y se retoma en pausa.
  async restaurar() {
    const abierto = (await db.todos('tracks')).find((t) => t.abierto);
    if (abierto) {
      this.track = abierto;
      this.estado = 'pausado';
      this.#emitir();
    }
  }

  iniciar() {
    const ahora = Date.now();
    this.track = {
      id: nuevoId(),
      nombre: `Track ${new Date(ahora).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' })}`,
      inicio: ahora,
      fin: ahora,
      segmentos: [[]],
      distancia: 0,
      subida: 0,
      bajada: 0,
      abierto: true,
    };
    this.altRef = null;
    this.estado = 'grabando';
    this.#guardar();
    this.#emitir();
  }

  pausar() {
    if (this.estado !== 'grabando') return;
    this.estado = 'pausado';
    this.#guardar();
    this.#emitir();
  }

  reanudar() {
    if (this.estado !== 'pausado') return;
    if (this.track.segmentos.at(-1).length) this.track.segmentos.push([]);
    this.altRef = null;
    this.estado = 'grabando';
    this.#emitir();
  }

  async terminar() {
    const t = this.track;
    this.track = null;
    this.estado = 'detenido';
    if (!t) return null;
    t.segmentos = t.segmentos.filter((s) => s.length);
    const puntos = t.segmentos.reduce((n, s) => n + s.length, 0);
    if (puntos < 2) {
      await db.borrar('tracks', t.id);
      this.#emitir();
      return null;
    }
    t.abierto = false;
    await db.guardar('tracks', t);
    this.#emitir();
    return t;
  }

  agregar(posicion) {
    if (this.estado !== 'grabando') return;
    const c = posicion.coords;
    if (c.accuracy > PRECISION_MAXIMA) return;
    const seg = this.track.segmentos.at(-1);
    const ultimo = seg.at(-1);
    const p = [
      Math.round(c.longitude * 1e6) / 1e6,
      Math.round(c.latitude * 1e6) / 1e6,
      c.altitude == null ? null : Math.round(c.altitude * 10) / 10,
      posicion.timestamp,
    ];
    if (ultimo) {
      const d = distancia(ultimo[0], ultimo[1], p[0], p[1]);
      if (d < Math.max(4, c.accuracy * 0.5)) return; // quieto o ruido
      this.track.distancia += d;
    }
    if (p[2] != null) {
      if (this.altRef == null) this.altRef = p[2];
      const dz = p[2] - this.altRef;
      if (Math.abs(dz) >= UMBRAL_DESNIVEL) {
        if (dz > 0) this.track.subida += dz;
        else this.track.bajada -= dz;
        this.altRef = p[2];
      }
    }
    seg.push(p);
    this.track.fin = p[3];
    if (++this.sinGuardar >= 10) this.#guardar();
    this.dispatchEvent(new Event('punto'));
  }

  #guardar() {
    this.sinGuardar = 0;
    if (this.track) db.guardar('tracks', this.track).catch(() => {});
  }

  #emitir() {
    this.dispatchEvent(new Event('cambio'));
  }
}

// Tiempo en movimiento (sin contar pausas).
export function duracion(t) {
  return t.segmentos.reduce((ms, s) => ms + (s.length > 1 ? s.at(-1)[3] - s[0][3] : 0), 0);
}

export function lineas(t) {
  return t ? t.segmentos.filter((s) => s.length > 1).map((s) => s.map((p) => [p[0], p[1]])) : [];
}

// Perfil de elevación: [[distancia acumulada m, altitud m], ...]
export function perfil(t) {
  const out = [];
  let acum = 0;
  for (const s of t.segmentos) {
    for (let i = 0; i < s.length; i++) {
      if (i > 0) acum += distancia(s[i - 1][0], s[i - 1][1], s[i][0], s[i][1]);
      if (s[i][2] != null) out.push([acum, s[i][2]]);
    }
  }
  return out;
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const CABECERA = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Rumbo" xmlns="http://www.topografix.com/GPX/1/1">';

export function trackAGpx(t) {
  const segs = t.segmentos
    .filter((s) => s.length)
    .map((s) => `<trkseg>\n${s.map((p) => `<trkpt lat="${p[1]}" lon="${p[0]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}<time>${new Date(p[3]).toISOString()}</time></trkpt>`).join('\n')}\n</trkseg>`)
    .join('\n');
  return `${CABECERA}\n<trk><name>${esc(t.nombre)}</name>\n${segs}\n</trk>\n</gpx>\n`;
}

export function lugaresAGpx(lugares) {
  const wpts = lugares
    .map((l) => `<wpt lat="${l.lat}" lon="${l.lon}">${l.ele != null ? `<ele>${l.ele}</ele>` : ''}<time>${new Date(l.creado).toISOString()}</time><name>${esc(l.nombre)}</name></wpt>`)
    .join('\n');
  return `${CABECERA}\n${wpts}\n</gpx>\n`;
}

export async function compartirArchivo(nombre, texto, tipo = 'application/gpx+xml') {
  const f = new File([texto], nombre, { type: tipo });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try {
      await navigator.share({ files: [f], title: nombre });
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f);
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
