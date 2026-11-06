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
      tiempo: 0, // ms grabando, sin contar pausas
      abierto: true,
    };
    this.inicioSegmento = ahora;
    this.altRef = null;
    this.estado = 'grabando';
    this.#guardar();
    this.#emitir();
  }

  // Tiempo grabado hasta ahora (reloj real, aunque estés quieto y no lleguen puntos).
  tiempo() {
    if (!this.track) return 0;
    return (this.track.tiempo || 0) + (this.estado === 'grabando' ? Date.now() - this.inicioSegmento : 0);
  }

  #cerrarSegmento() {
    this.track.tiempo = this.tiempo();
    this.inicioSegmento = Date.now();
  }

  pausar() {
    if (this.estado !== 'grabando') return;
    this.#cerrarSegmento();
    this.estado = 'pausado';
    this.#guardar();
    this.#emitir();
  }

  reanudar() {
    if (this.estado !== 'pausado') return;
    if (this.track.segmentos.at(-1).length) this.track.segmentos.push([]);
    this.inicioSegmento = Date.now();
    this.altRef = null;
    this.estado = 'grabando';
    this.#emitir();
  }

  async terminar() {
    const t = this.track;
    if (t && this.estado === 'grabando') this.#cerrarSegmento();
    this.track = null;
    this.estado = 'detenido';
    if (!t) return null;
    // Se guardan todos los tracks, aunque sean muy cortos o no tengan puntos.
    t.segmentos = t.segmentos.filter((s) => s.length);
    if (!t.segmentos.length) t.segmentos = [[]];
    t.fin = Date.now();
    t.abierto = false;
    await db.guardar('tracks', t);
    this.#emitir();
    return t;
  }

  agregar(posicion) {
    if (this.estado !== 'grabando') return;
    const c = posicion.coords;
    const seg = this.track.segmentos.at(-1);
    const ultimo = seg.at(-1);
    // El primer punto se acepta con menos precisión (bajo techo o recién encendido el GPS),
    // para que incluso un track muy corto quede con su lugar de inicio.
    if (c.accuracy > (ultimo ? PRECISION_MAXIMA : 100)) return;
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
  if (t.tiempo) return t.tiempo;
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
