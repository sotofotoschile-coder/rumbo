// Worker: motor de rutas sin conexión.
// Lee la red .rutas (generada por herramientas/generar_rutas.py) y calcula la ruta más rápida
// con A* para auto o a pie, junto con las indicaciones de cada maniobra en español.

let R = null; // la red cargada

self.onmessage = async (e) => {
  const { tipo, id } = e.data;
  try {
    if (tipo === 'cargar') {
      R = await cargar(e.data.archivo);
      self.postMessage({ id, ok: true, info: { nombre: R.cab.nombre, region: R.cab.region, limites: R.cab.limites, nodos: R.N } });
    } else if (tipo === 'ruta') {
      if (!R) throw new Error('No hay rutas sin conexión instaladas.');
      self.postMessage({ id, ok: true, ruta: calcular(e.data) });
    } else if (tipo === 'buscar') {
      self.postMessage({ id, ok: true, resultados: R ? buscar(e.data.texto, e.data.cerca) : [] });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};

// ---------- Carga ----------
async function cargar(archivo) {
  const buf = await archivo.arrayBuffer();
  const magia = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (magia !== 'RUMBORUT') throw new Error('El archivo no es una red de rutas de Rumbo.');
  const dv = new DataView(buf);
  const largoCab = dv.getUint32(12, true);
  const cab = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, largoCab)));
  const base = 16 + largoCab;
  const sec = (nombre, Tipo) => {
    const [off, len] = cab.secciones[nombre];
    return new Tipo(buf, base + off, len / Tipo.BYTES_PER_ELEMENT);
  };
  const r = {
    cab,
    N: cab.nodos,
    E: cab.aristas,
    nodos: sec('nodos', Int32Array),
    adjOff: sec('adjOff', Uint32Array),
    adjTo: sec('adjTo', Uint32Array),
    adjArista: sec('adjArista', Uint32Array),
    adjFlags: sec('adjFlags', Uint8Array),
    aA: sec('aristaA', Uint32Array),
    aB: sec('aristaB', Uint32Array),
    aLargo: sec('aristaLargo', Float32Array),
    aVel: sec('aristaVel', Uint8Array),
    aClase: sec('aristaClase', Uint8Array),
    aFlags: sec('aristaFlags', Uint8Array),
    aNombre: sec('aristaNombre', Uint32Array),
    gOff: sec('geomOff', Uint32Array),
    geom: sec('geom', Int32Array),
    // Opcionales (redes generadas desde nov. 2026): límite de velocidad por tramo.
    aMax: cab.secciones.aristaMax ? sec('aristaMax', Uint8Array) : null,
  };
  // Índice de búsqueda: [nombre, tipo, lon, lat, extra] → se agrega el nombre normalizado.
  r.lugares = (cab.lugares || []).map((l) => ({ nombre: l[0], tipo: l[1], lon: l[2], lat: l[3], extra: l[4] || '', clave: normalizar(l[0]) }));
  // Qué perfiles pueden usar cada tramo (en algún sentido): 1 auto, 2 a pie.
  r.aPermite = new Uint8Array(r.E);
  for (let h = 0; h < r.adjTo.length; h++) r.aPermite[r.adjArista[h]] |= r.adjFlags[h];
  construirIndice(r);
  return r;
}

const lonN = (n) => R.nodos[2 * n] / 1e6;
const latN = (n) => R.nodos[2 * n + 1] / 1e6;

// Puntos de un tramo desde A hasta B: [[lon, lat], ...]
function puntos(e, r = R) {
  const out = [[r.nodos[2 * r.aA[e]] / 1e6, r.nodos[2 * r.aA[e] + 1] / 1e6]];
  for (let i = r.gOff[e]; i < r.gOff[e + 1]; i++) out.push([r.geom[2 * i] / 1e6, r.geom[2 * i + 1] / 1e6]);
  out.push([r.nodos[2 * r.aB[e]] / 1e6, r.nodos[2 * r.aB[e] + 1] / 1e6]);
  return out;
}

// ---------- Búsqueda por nombre (sin internet) ----------
function normalizar(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Importancia por tipo: pueblos y servicios antes que calles.
const PESO = { ciudad: 0, pueblo: 1, localidad: 3, aeropuerto: 1, ferry: 2, salud: 2, bencinera: 2, carabineros: 2, bomberos: 3,
  refugio: 2, camping: 2, parque: 2, glaciar: 2, cumbre: 2, lago: 3, mirador: 3, alojamiento: 4, museo: 4, atraccion: 4,
  supermercado: 4, farmacia: 3, estancia: 4, barrio: 5, isla: 3, bahia: 4, cabo: 4, rio: 4, restaurante: 6, banco: 6,
  informacion: 6, calle: 5 };
// Palabras que buscan una categoría aunque no estén en el nombre ("bencinera" encuentra Copec, Shell…).
const SINONIMOS = {
  bencinera: ['bencinera', 'bencina', 'gasolinera', 'combustible', 'servicentro', 'copec', 'shell', 'petrobras', 'enex'],
  salud: ['hospital', 'clinica', 'posta', 'salud', 'cesfam', 'medico', 'urgencia'], farmacia: ['farmacia'],
  carabineros: ['carabineros', 'policia', 'comisaria', 'reten'], bomberos: ['bomberos'], refugio: ['refugio'],
  camping: ['camping', 'acampar', 'campamento'], alojamiento: ['hotel', 'hostal', 'hospedaje', 'alojamiento', 'cabana', 'cabanas'],
  mirador: ['mirador'], cumbre: ['cerro', 'cumbre', 'monte', 'volcan'], aeropuerto: ['aeropuerto', 'aerodromo'],
  ferry: ['ferry', 'transbordador', 'barcaza'], supermercado: ['supermercado', 'almacen'], banco: ['banco', 'cajero'],
  restaurante: ['restaurante', 'restaurant', 'cafe', 'comida'], glaciar: ['glaciar', 'ventisquero'], lago: ['lago', 'laguna'],
};
const TIPO_DE = {};
for (const [tipo, lista] of Object.entries(SINONIMOS)) for (const p of lista) TIPO_DE[p] = tipo;

function buscar(texto, cerca) {
  const q = normalizar(texto);
  if (q.length < 2) return [];
  const palabras = q.split(' ');
  const res = [];
  for (const l of R.lugares) {
    if (!palabras.every((p) => l.clave.includes(p) || TIPO_DE[p] === l.tipo)) continue;
    let puntaje = PESO[l.tipo] ?? 5;
    if (l.clave === q) puntaje -= 4;
    else if (l.clave.startsWith(q) || l.clave.split(' ').some((w) => w.startsWith(palabras[0]))) puntaje -= 2;
    let dist = null;
    if (cerca) { dist = metros(cerca, [l.lon, l.lat]); puntaje += Math.min(4, dist / 25000); }
    res.push({ nombre: l.nombre, tipo: l.tipo, lon: l.lon, lat: l.lat, extra: l.extra, dist, puntaje });
  }
  res.sort((a, b) => a.puntaje - b.puntaje);
  // Una sola calle con el mismo nombre en resultados cercanos.
  const vistos = new Set();
  return res.filter((r) => { const k = `${r.nombre}|${r.tipo}|${Math.round(r.lon * 20)}|${Math.round(r.lat * 20)}`; if (vistos.has(k)) return false; vistos.add(k); return true; }).slice(0, 30);
}

// ---------- Índice espacial (para encontrar el camino más cercano a un punto) ----------
const CELDA = 0.01; // grados (~1,1 km de norte a sur, ~0,7 km de este a oeste en Magallanes)
const clave = (ix, iy) => ix * 100000 + iy;
function construirIndice(r) {
  r.celdas = new Map();
  for (let e = 0; e < r.E; e++) {
    const p = puntos(e, r);
    let ultima = -1;
    for (let i = 0; i < p.length - 1; i++) {
      const x0 = Math.floor(Math.min(p[i][0], p[i + 1][0]) / CELDA), x1 = Math.floor(Math.max(p[i][0], p[i + 1][0]) / CELDA);
      const y0 = Math.floor(Math.min(p[i][1], p[i + 1][1]) / CELDA), y1 = Math.floor(Math.max(p[i][1], p[i + 1][1]) / CELDA);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = clave(x, y);
        let lista = r.celdas.get(k);
        if (!lista) { lista = []; r.celdas.set(k, lista); }
        if (lista[lista.length - 1] !== e || k !== ultima) lista.push(e);
        ultima = k;
      }
    }
  }
}

// Distancia en metros (aproximación local, suficiente para distancias cortas).
function metros(a, b) {
  const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
}

// Encuentra el tramo usable más cercano y el punto exacto sobre él.
function ajustar(lon, lat, bit) {
  const cx = Math.floor(lon / CELDA), cy = Math.floor(lat / CELDA);
  const kx = 111320 * Math.cos(lat * Math.PI / 180);
  let mejor = null;
  for (let anillo = 0; anillo <= 8; anillo++) {
    for (let x = cx - anillo; x <= cx + anillo; x++) for (let y = cy - anillo; y <= cy + anillo; y++) {
      if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== anillo) continue;
      const lista = R.celdas.get(clave(x, y));
      if (!lista) continue;
      for (const e of lista) {
        if (!(R.aPermite[e] & bit)) continue;
        const p = puntos(e);
        let acum = 0;
        for (let i = 0; i < p.length - 1; i++) {
          const ax = (p[i][0] - lon) * kx, ay = (p[i][1] - lat) * 110540;
          const bx = (p[i + 1][0] - lon) * kx, by = (p[i + 1][1] - lat) * 110540;
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          const largoSeg = Math.sqrt(l2);
          if (!mejor || d < mejor.dist) {
            mejor = { e, dist: d, desdeA: acum + t * largoSeg, punto: [p[i][0] + t * (p[i + 1][0] - p[i][0]), p[i][1] + t * (p[i + 1][1] - p[i][1])] };
          }
          acum += largoSeg;
        }
      }
    }
    // Ya no puede aparecer algo más cerca que lo encontrado.
    if (mejor && mejor.dist < anillo * CELDA * 0.6 * 111320 * 0.6) break;
  }
  if (!mejor) return null;
  // Escala la posición al largo oficial del tramo (las medidas locales difieren levemente).
  const largoGeom = puntos(mejor.e).reduce((s, q, i, arr) => (i ? s + metros(arr[i - 1], q) : 0), 0) || 1;
  mejor.desdeA = (mejor.desdeA / largoGeom) * R.aLargo[mejor.e];
  return mejor;
}

// ---------- Costos ----------
const VEL_PIE = 4.5 / 3.6; // m/s
function velocidad(e, perfil) {
  if (perfil === 'pie') return R.aFlags[e] & 2 ? 15 / 3.6 : VEL_PIE;
  return Math.max(5, R.aVel[e]) / 3.6;
}
const segundos = (e, metrosRecorridos, perfil) => metrosRecorridos / velocidad(e, perfil);
// ¿Se puede recorrer el tramo e desde el nodo "desde"?
function puedeDesde(e, desde, bit) {
  for (let h = R.adjOff[desde]; h < R.adjOff[desde + 1]; h++) if (R.adjArista[h] === e) return (R.adjFlags[h] & bit) !== 0;
  return false;
}

// ---------- A* ----------
class Monticulo {
  constructor() { this.n = []; this.f = []; }
  get size() { return this.n.length; }
  push(n, f) {
    const a = this.n, b = this.f;
    let i = a.length;
    a.push(n); b.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (b[p] <= f) break;
      a[i] = a[p]; b[i] = b[p]; i = p;
    }
    a[i] = n; b[i] = f;
  }
  pop() {
    const a = this.n, b = this.f;
    const top = a[0], topF = b[0];
    const ln = a.pop(), lf = b.pop();
    if (a.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && b[c + 1] < b[c]) c++;
        if (b[c] >= lf) break;
        a[i] = a[c]; b[i] = b[c]; i = c;
      }
      a[i] = ln; b[i] = lf;
    }
    return [top, topF];
  }
}

function calcular({ desde, hasta, perfil }) {
  const bit = perfil === 'pie' ? 2 : 1;
  const vmax = perfil === 'pie' ? 15 / 3.6 : 110 / 3.6;
  const s = ajustar(desde[0], desde[1], bit);
  const t = ajustar(hasta[0], hasta[1], bit);
  if (!s) throw new Error('No encontré un camino cerca del punto de partida.');
  if (!t) throw new Error('No encontré un camino cerca del destino.');
  if (s.dist > 3000) throw new Error('El punto de partida está a más de 3 km de cualquier camino.');
  if (t.dist > 3000) throw new Error('El destino está a más de 3 km de cualquier camino.');

  const g = new Float64Array(R.N).fill(Infinity);
  const previo = new Int32Array(R.N).fill(-1); // media arista por la que se llegó
  const cerrado = new Uint8Array(R.N);
  const heap = new Monticulo();
  const meta = [t.punto[0], t.punto[1]];
  const h = (n) => metros([lonN(n), latN(n)], meta) / vmax;

  // Desde el punto de partida se puede ir hacia A o hacia B del tramo (si el sentido lo permite).
  const se = s.e, sA = R.aA[se], sB = R.aB[se], sLargo = R.aLargo[se];
  if (puedeDesde(se, sB, bit)) { g[sA] = segundos(se, s.desdeA, perfil); heap.push(sA, g[sA] + h(sA)); }
  if (puedeDesde(se, sA, bit)) { const c = segundos(se, sLargo - s.desdeA, perfil); if (c < g[sB]) { g[sB] = c; heap.push(sB, c + h(sB)); } }

  const te = t.e, tA = R.aA[te], tB = R.aB[te], tLargo = R.aLargo[te];
  let mejor = Infinity, finNodo = -1, directo = false;
  // Partida y destino en el mismo tramo.
  if (se === te) {
    const adelante = t.desdeA >= s.desdeA;
    if (adelante ? puedeDesde(se, sA, bit) : puedeDesde(se, sB, bit)) {
      mejor = segundos(se, Math.abs(t.desdeA - s.desdeA), perfil);
      directo = true;
    }
  }
  while (heap.size) {
    const [u, f] = heap.pop();
    if (f >= mejor) break;
    if (cerrado[u]) continue;
    cerrado[u] = 1;
    // ¿Llegamos a un extremo del tramo destino?
    if (u === tA && puedeDesde(te, tA, bit)) {
      const c = g[u] + segundos(te, t.desdeA, perfil);
      if (c < mejor) { mejor = c; finNodo = u; directo = false; }
    }
    if (u === tB && puedeDesde(te, tB, bit)) {
      const c = g[u] + segundos(te, tLargo - t.desdeA, perfil);
      if (c < mejor) { mejor = c; finNodo = u; directo = false; }
    }
    for (let k = R.adjOff[u]; k < R.adjOff[u + 1]; k++) {
      if (!(R.adjFlags[k] & bit)) continue;
      const v = R.adjTo[k];
      if (cerrado[v]) continue;
      const e = R.adjArista[k];
      const c = g[u] + segundos(e, R.aLargo[e], perfil);
      if (c < g[v]) { g[v] = c; previo[v] = k; heap.push(v, c + h(v)); }
    }
  }
  if (mejor === Infinity) throw new Error('No hay un camino que una esos dos puntos con este medio de transporte.');

  // Reconstruye la secuencia de tramos recorridos.
  const recorrido = []; // { e, desde: m desde A, hasta: m desde A }
  if (directo) {
    recorrido.push({ e: se, ini: s.desdeA, fin: t.desdeA });
  } else {
    const medio = [];
    let n = finNodo;
    while (previo[n] !== -1) {
      const k = previo[n];
      const e = R.adjArista[k];
      const origen = R.aA[e] === n ? R.aB[e] : R.aA[e];
      medio.push({ e, ini: R.aA[e] === origen ? 0 : R.aLargo[e], fin: R.aA[e] === origen ? R.aLargo[e] : 0 });
      n = origen;
    }
    medio.reverse();
    // Primer tramo parcial: del punto de partida al nodo n (A o B del tramo inicial).
    recorrido.push({ e: se, ini: s.desdeA, fin: n === sA ? 0 : sLargo });
    recorrido.push(...medio);
    recorrido.push({ e: te, ini: finNodo === tA ? 0 : tLargo, fin: t.desdeA });
  }
  return armarResultado(recorrido.filter((r) => Math.abs(r.fin - r.ini) > 0.5 || recorrido.length === 1), mejor, perfil, s, t);
}

// Puntos de un tramo entre dos distancias medidas desde A (en el sentido ini → fin).
function trozo(e, ini, fin) {
  const p = puntos(e);
  const acum = [0];
  for (let i = 1; i < p.length; i++) acum.push(acum[i - 1] + metros(p[i - 1], p[i]));
  const total = acum[acum.length - 1] || 1;
  const escala = R.aLargo[e] / total;
  const en = (d) => {
    const x = d / escala;
    for (let i = 1; i < p.length; i++) {
      if (acum[i] >= x) {
        const k = (x - acum[i - 1]) / ((acum[i] - acum[i - 1]) || 1);
        return [p[i - 1][0] + k * (p[i][0] - p[i - 1][0]), p[i - 1][1] + k * (p[i][1] - p[i - 1][1])];
      }
    }
    return p[p.length - 1];
  };
  const out = [en(ini)];
  if (ini <= fin) { for (let i = 1; i < p.length - 1; i++) if (acum[i] * escala > ini && acum[i] * escala < fin) out.push(p[i]); }
  else { for (let i = p.length - 2; i >= 1; i--) if (acum[i] * escala < ini && acum[i] * escala > fin) out.push(p[i]); }
  out.push(en(fin));
  return out;
}

// ---------- Indicaciones ----------
const rumbo = (a, b) => {
  const y = Math.sin((b[0] - a[0]) * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180);
  const x = Math.cos(a[1] * Math.PI / 180) * Math.sin(b[1] * Math.PI / 180) - Math.sin(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.cos((b[0] - a[0]) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};
const nombre = (e) => R.cab.nombres[R.aNombre[e]] || '';
const ordinal = (n) => `${n}.ª`;
// Rumbo representativo al salir/llegar de un punto (mira ~20 m para evitar ruido de la geometría).
function rumboSalida(coords, i) {
  let j = i + 1;
  while (j < coords.length - 1 && metros(coords[i], coords[j]) < 20) j++;
  return rumbo(coords[i], coords[Math.min(j, coords.length - 1)]);
}
function rumboLlegada(coords, i) {
  let j = i - 1;
  while (j > 0 && metros(coords[j], coords[i]) < 20) j--;
  return rumbo(coords[Math.max(j, 0)], coords[i]);
}
// Cantidad de caminos que salen de un nodo para este perfil.
function grado(n, bit) {
  let c = 0;
  for (let k = R.adjOff[n]; k < R.adjOff[n + 1]; k++) if (R.adjFlags[k] & bit) c++;
  return c;
}

function armarResultado(recorrido, segundosTotales, perfil, s, t) {
  const bit = perfil === 'pie' ? 2 : 1;
  const coords = [];
  const tramos = []; // { e, idxIni, nodoFin }
  for (const r of recorrido) {
    const pts = trozo(r.e, r.ini, r.fin);
    const idxIni = coords.length ? coords.length - 1 : 0;
    if (coords.length) pts.shift();
    coords.push(...pts);
    const nodoFin = r.fin === 0 ? R.aA[r.e] : r.fin === R.aLargo[r.e] ? R.aB[r.e] : -1;
    tramos.push({ e: r.e, idxIni, idxFin: coords.length - 1, nodoFin });
  }
  const acum = [0];
  for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + metros(coords[i - 1], coords[i]));

  const pasos = [];
  const primero = tramos[0];
  pasos.push({ tipo: 'salida', idx: 0, nombre: nombre(primero.e), texto: nombre(primero.e) ? `Sal por ${nombre(primero.e)}` : 'Comienza el recorrido' });
  for (let i = 1; i < tramos.length; i++) {
    const prev = tramos[i - 1], act = tramos[i];
    const idx = act.idxIni;
    const ePrev = prev.e, eAct = act.e;
    const rotPrev = R.aFlags[ePrev] & 1, rotAct = R.aFlags[eAct] & 1;
    const ferryPrev = R.aFlags[ePrev] & 2, ferryAct = R.aFlags[eAct] & 2;
    const nom = nombre(eAct);
    if (ferryAct && !ferryPrev) { pasos.push({ tipo: 'ferry', idx, nombre: nom, texto: `Toma el transbordador${nom ? ` (${nom})` : ''}` }); continue; }
    if (ferryPrev && !ferryAct) { pasos.push({ tipo: 'recto', idx, nombre: nom, texto: `Desembarca y continúa${nom ? ` por ${nom}` : ''}` }); continue; }
    if (rotAct && !rotPrev) {
      // Cuenta las salidas de la rotonda hasta la que hay que tomar.
      let salidas = 0, j = i;
      while (j < tramos.length && (R.aFlags[tramos[j].e] & 1)) {
        const n = tramos[j].nodoFin;
        if (n >= 0) {
          for (let k = R.adjOff[n]; k < R.adjOff[n + 1]; k++) {
            if ((R.adjFlags[k] & bit) && !(R.aFlags[R.adjArista[k]] & 1)) { salidas++; break; }
          }
        }
        j++;
      }
      const salidaNom = j < tramos.length ? nombre(tramos[j].e) : '';
      pasos.push({ tipo: 'rotonda', idx, salida: Math.max(1, salidas), nombre: salidaNom,
        texto: `En la rotonda, toma la ${ordinal(Math.max(1, salidas))} salida${salidaNom ? ` hacia ${salidaNom}` : ''}` });
      continue;
    }
    if (rotAct || rotPrev) continue;
    const nodo = prev.nodoFin;
    if (nodo < 0 || grado(nodo, bit) <= 2) {
      if (nom && nom !== nombre(ePrev) && grado(nodo, bit) > 2) pasos.push({ tipo: 'recto', idx, nombre: nom, texto: `Continúa por ${nom}` });
      continue;
    }
    let giro = rumboSalida(coords, idx) - rumboLlegada(coords, idx);
    giro = ((giro + 540) % 360) - 180; // −180..180, positivo = derecha
    const a = Math.abs(giro);
    const lado = giro > 0 ? 'derecha' : 'izquierda';
    let tipo, verbo;
    if (a < 22) {
      if (!nom || nom === nombre(ePrev)) continue;
      tipo = 'recto'; verbo = 'Continúa';
    } else if (a < 55) { tipo = `leve-${lado}`; verbo = `Mantente a la ${lado}`; }
    else if (a < 140) { tipo = lado; verbo = `Gira a la ${lado}`; }
    else { tipo = `cerrada-${lado}`; verbo = `Gira bruscamente a la ${lado}`; }
    pasos.push({ tipo, idx, nombre: nom, texto: nom ? `${verbo} ${tipo === 'recto' ? 'por' : 'en'} ${nom}` : verbo });
  }
  pasos.push({ tipo: 'llegada', idx: coords.length - 1, nombre: '', texto: 'Llegaste a tu destino' });
  for (const p of pasos) p.distancia = acum[p.idx];
  // Une indicaciones iguales muy seguidas (p. ej. una calle partida en dos tramos cortos).
  const unidos = pasos.filter((p, i) => i === 0 || p.tipo === 'llegada' ||
    !(p.texto === pasos[i - 1].texto && p.distancia - pasos[i - 1].distancia < 60));
  pasos.length = 0;
  pasos.push(...unidos);
  // Tramos con sus características: [índice inicial, índice final, flags (4 = ripio), límite km/h o 0].
  const infoTramos = [];
  for (const t of tramos) {
    const flags = R.aFlags[t.e];
    const max = R.aMax ? R.aMax[t.e] : 0;
    const ult = infoTramos[infoTramos.length - 1];
    if (ult && ult[2] === flags && ult[3] === max && ult[1] === t.idxIni) ult[1] = t.idxFin;
    else infoTramos.push([t.idxIni, t.idxFin, flags, max]);
  }
  return {
    coords,
    acum,
    tramos: infoTramos,
    distancia: acum[acum.length - 1],
    duracion: segundosTotales,
    pasos,
    perfil,
    desdeAjuste: s.dist,
    hastaAjuste: t.dist,
  };
}
