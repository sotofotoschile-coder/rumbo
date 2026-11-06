// Paquetes de mapa offline (.pmtiles) guardados en el almacenamiento privado de la app.
import { db, nuevoId } from './db.js';
import * as SAT from './satelite.js';

const protocolo = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocolo.tile);

async function carpeta() {
  const raiz = await navigator.storage.getDirectory();
  return raiz.getDirectoryHandle('mapas', { create: true });
}

async function archivo(nombre) {
  const h = await (await carpeta()).getFileHandle(nombre);
  return h.getFile();
}

// Mapas base (sin rutas, relieve ni curvas).
export async function listar() {
  const mapas = (await db.todos('mapas')).filter((m) => !m.tipo || m.tipo === 'mapa');
  return mapas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
export async function listarDatos(tipo) {
  return (await db.todos('mapas')).filter((m) => m.tipo === tipo);
}
// Todo lo instalado (para el paquete que se envía a otro iPhone).
export const listarTodo = () => db.todos('mapas');

// Abre un .pmtiles instalado y devuelve su URL para MapLibre y el lector (para leer teselas a mano).
export async function abrirPmtiles(registro) {
  const f = await archivo(registro.archivo);
  const fuente = new pmtiles.FileSource(f);
  const pm = new pmtiles.PMTiles(fuente);
  protocolo.add(pm);
  return { url: `pmtiles://${fuente.getKey()}`, pm };
}

// Redes de rutas sin conexión (.rutas) instaladas.
export async function listarRutas() {
  return (await db.todos('mapas')).filter((m) => m.tipo === 'rutas');
}

// Archivo guardado de un mapa o red de rutas (para entregarlo al motor de rutas).
export const archivoDe = (registro) => archivo(registro.archivo);

// Devuelve la URL pmtiles:// que entiende MapLibre.
export async function abrirFuente(mapa) {
  const f = await archivo(mapa.archivo);
  const fuente = new pmtiles.FileSource(f);
  protocolo.add(new pmtiles.PMTiles(fuente));
  return `pmtiles://${fuente.getKey()}`;
}

// Copia un archivo grande al almacenamiento de la app y lo devuelve como archivo en disco.
export async function guardarArchivo(origen, nombre, alProgreso) {
  await copiar(origen, nombre, alProgreso);
  return archivo(nombre);
}

function copiar(origen, destino, alProgreso) {
  return new Promise((resolver, rechazar) => {
    const w = new Worker(new URL('./copiador.js', import.meta.url));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.tipo === 'progreso') alProgreso?.(m.hecho, m.total);
      else if (m.tipo === 'listo') { w.terminate(); resolver(m.bytes); }
      else if (m.tipo === 'error') { w.terminate(); rechazar(new Error(m.mensaje)); }
    };
    w.onerror = (e) => { w.terminate(); rechazar(new Error(e.message || 'No se pudo copiar el archivo.')); };
    w.postMessage({ origen, destino });
  });
}

// origen: File (importado desde Archivos) o { url } (descarga).
// Acepta paquetes de mapa (.pmtiles) y redes de rutas (.rutas); se distinguen por su contenido.
// extra: datos del catálogo (región y versión) para saber luego si hay una actualización.
export async function instalar(origen, nombre, alProgreso, extra = {}) {
  const id = nuevoId();
  const nombreArchivo = `${id}.dat`;
  const bytes = await copiar(origen, nombreArchivo, alProgreso);
  const cabeza = new TextDecoder().decode(await (await archivo(nombreArchivo)).slice(0, 8).arrayBuffer());
  if (cabeza === 'RUMBORUT') {
    try {
      const f = await archivo(nombreArchivo);
      const largo = new DataView(await f.slice(12, 16).arrayBuffer()).getUint32(0, true);
      const cab = JSON.parse(new TextDecoder().decode(await f.slice(16, 16 + largo).arrayBuffer()));
      // Una sola red por región: la nueva reemplaza a la anterior.
      for (const viejo of await listarRutas()) if (viejo.region === cab.region) await borrar(viejo);
      const r = { id, tipo: 'rutas', archivo: nombreArchivo, nombre: `Rutas de ${cab.nombre.replace(/^Región de /, '')}`, region: cab.region,
        bytes, instalado: Date.now(), limites: cab.limites, generado: cab.generado, ...extra };
      await db.guardar('mapas', r);
      return r;
    } catch (e) {
      await (await carpeta()).removeEntry(nombreArchivo).catch(() => {});
      throw new Error(`La red de rutas está dañada: ${e.message}.`);
    }
  }
  try {
    const p = new pmtiles.PMTiles(new pmtiles.FileSource(await archivo(nombreArchivo)));
    const h = await p.getHeader();
    let meta = {};
    try { meta = (await p.getMetadata()) || {}; } catch (_) { /* metadatos opcionales */ }
    // Tipo de paquete: mapa base (vectorial), relieve (modelo de elevación) o curvas de nivel (vectorial con capa «curvas»).
    const capas = (meta.vector_layers || []).map((c) => c.id);
    const tipo = h.tileType === 2 && (meta.encoding === 'terrarium' || /relieve/i.test(meta.name || '')) ? 'relieve'
      : h.tileType === 1 && capas.includes('curvas') && capas.length === 1 ? 'curvas'
        : h.tileType === 1 ? 'mapa' : null;
    if (!tipo) throw new Error('no contiene teselas de mapa');
    // Relieve, curvas y mapas de una región del catálogo: la versión nueva reemplaza a la anterior.
    const anteriores = tipo === 'mapa' ? (extra.region ? (await listar()).filter((m) => m.region === extra.region) : []) : await listarDatos(tipo);
    for (const viejo of anteriores) if (tipo === 'mapa' || !extra.region || !viejo.region || viejo.region === extra.region) await borrar(viejo);
    const mapa = {
      id,
      ...(tipo !== 'mapa' ? { tipo } : {}),
      archivo: nombreArchivo,
      nombre: tipo === 'relieve' ? 'Relieve del terreno' : tipo === 'curvas' ? 'Curvas de nivel' : nombre,
      bytes,
      instalado: Date.now(),
      limites: [h.minLon, h.minLat, h.maxLon, h.maxLat],
      centro: [h.centerLon, h.centerLat, h.centerZoom],
      minZoom: h.minZoom,
      maxZoom: h.maxZoom,
      esquema: meta.version || null,
      ...extra,
    };
    await db.guardar('mapas', mapa);
    return mapa;
  } catch (e) {
    await (await carpeta()).removeEntry(nombreArchivo).catch(() => {});
    throw new Error(`El archivo no es un paquete de mapa válido (.pmtiles): ${e.message}.`);
  }
}

export async function borrar(mapa) {
  await (await carpeta()).removeEntry(mapa.archivo).catch(() => {});
  await db.borrar('mapas', mapa.id);
}

// Elimina copias a medio terminar (por ejemplo, si se cerró la app durante una importación).
export async function limpiarHuerfanos() {
  try {
    const conocidos = new Set((await db.todos('mapas')).map((m) => m.archivo));
    const dir = await carpeta();
    for await (const [nombre] of dir.entries()) {
      if (!conocidos.has(nombre)) await dir.removeEntry(nombre).catch(() => {});
    }
  } catch (_) { /* el navegador no permite listar: no es grave */ }
}

export async function espacio() {
  try {
    const e = await navigator.storage.estimate();
    const persistente = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usado: e.usage, cuota: e.quota, persistente };
  } catch (_) {
    return null;
  }
}

export async function pedirPersistencia() {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (_) {
    return false;
  }
}

// capa: 'mapa' | 'satelite' (Sentinel-2 offline) | 'hd' (Esri con internet, sobre Sentinel-2)
export function estilo(urlFuente, tema, { capa = 'mapa', etiquetas = true, claveEsri = '', relieve = {} } = {}) {
  const base = new URL('.', document.baseURI).href;
  const fondo = tema === 'dark' ? '#1c1c1e' : '#eef0e6';
  const satelital = capa === 'satelite' || capa === 'hd';
  const sources = {};
  const layers = [];
  if (urlFuente) {
    sources.protomaps = {
      type: 'vector',
      url: urlFuente,
      attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    };
  }
  if (satelital) {
    sources.satelite = { type: 'raster', tiles: ['satelite://{z}/{x}/{y}'], tileSize: 256, maxzoom: SAT.ZOOM_MAX, attribution: SAT.ATRIBUCION_S2 };
    if (urlFuente) {
      // Debajo va el mapa normal (sin textos): donde no hay imagen satelital
      // (sin internet fuera de las zonas descargadas, o mientras carga) se ve el mapa y no un fondo negro.
      layers.push(...basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'es' })
        .filter((c) => c.type !== 'symbol')
        .map((c) => ({ ...c, id: `base-${c.id}` })));
    } else {
      layers.push({ id: 'fondo', type: 'background', paint: { 'background-color': '#0b1a24' } });
    }
    layers.push({ id: 'satelite', type: 'raster', source: 'satelite' });
    if (capa === 'hd' && claveEsri) {
      sources.hd = { type: 'raster', tiles: [`${SAT.URL_ESRI}?token=${encodeURIComponent(claveEsri)}`], tileSize: 256, maxzoom: 19, attribution: SAT.ATRIBUCION_ESRI };
      layers.push({ id: 'hd', type: 'raster', source: 'hd' });
    }
    if (urlFuente && etiquetas) {
      // Modo híbrido: caminos, senderos, límites y nombres del mapa sobre la imagen.
      const capas = basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'es' })
        .filter((c) => c.type === 'symbol' || c.id.startsWith('roads') || c.id.startsWith('boundaries'));
      layers.push(...textosLegibles(resaltarSenderos(capas, 'satelite'), true));
    }
  } else if (urlFuente) {
    layers.push(...textosLegibles(resaltarSenderos(basemaps.layers('protomaps', basemaps.namedFlavor(tema), { lang: 'es' }), tema), false));
  } else {
    layers.push({ id: 'fondo', type: 'background', paint: { 'background-color': fondo } });
  }
  // Relieve (sombreado) y curvas de nivel: van debajo de caminos y nombres.
  if (relieve.mostrar && (relieve.urlRelieve || relieve.urlCurvas)) {
    const extra = [];
    if (relieve.urlRelieve && !satelital) {
      sources.relieve = { type: 'raster-dem', url: relieve.urlRelieve, encoding: 'terrarium', tileSize: 256,
        attribution: 'Relieve: Terrain Tiles (SRTM y otros)' };
      extra.push({ id: 'relieve', type: 'hillshade', source: 'relieve', paint: {
        'hillshade-exaggeration': tema === 'dark' ? 0.35 : 0.42,
        'hillshade-shadow-color': tema === 'dark' ? '#000000' : '#5b4a3a',
        'hillshade-highlight-color': tema === 'dark' ? '#3a3a3c' : '#ffffff',
        'hillshade-accent-color': tema === 'dark' ? '#111111' : '#7d6b58',
      } });
    }
    if (relieve.urlCurvas) {
      sources.curvas = { type: 'vector', url: relieve.urlCurvas };
      const color = satelital ? 'rgba(255,236,200,0.6)' : tema === 'dark' ? 'rgba(214,184,140,0.45)' : 'rgba(139,99,58,0.5)';
      extra.push({ id: 'curvas', type: 'line', source: 'curvas', 'source-layer': 'curvas', minzoom: 11,
        paint: { 'line-color': color, 'line-width': ['case', ['==', ['get', 'maestra'], 1], 1.3, 0.6] } });
      if (urlFuente) {
        extra.push({ id: 'curvas-etiqueta', type: 'symbol', source: 'curvas', 'source-layer': 'curvas', minzoom: 12.5,
          filter: ['==', ['get', 'maestra'], 1],
          layout: { 'symbol-placement': 'line', 'symbol-spacing': 320, 'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'],
            'text-font': ['Noto Sans Regular'], 'text-size': 11 },
          paint: { 'text-color': satelital ? '#fff3dc' : tema === 'dark' ? '#d6b88c' : '#7a5530',
            'text-halo-color': satelital ? 'rgba(0,0,0,0.75)' : tema === 'dark' ? '#1c1c1e' : '#ffffff', 'text-halo-width': 1.4 } });
      }
    }
    // Antes de los caminos visibles (en satélite, sobre la imagen y bajo el híbrido).
    const i = layers.findIndex((c) => c.id.startsWith('roads'));
    layers.splice(i >= 0 ? i : layers.length, 0, ...extra);
  }
  const conVector = !!urlFuente;
  return {
    version: 8,
    ...(conVector ? { glyphs: `${base}assets/fonts/{fontstack}/{range}.pbf`, sprite: `${base}assets/sprites/v4/${satelital ? 'light' : tema}` } : {}),
    sources,
    layers,
  };
}

// Escala un tamaño de texto. Si depende del zoom ("interpolate"/"step"), escala sus valores de salida,
// porque MapLibre no permite envolver una expresión de zoom en una multiplicación.
function escalar(valor, factor) {
  if (typeof valor === 'number') return Math.round(valor * factor * 10) / 10;
  if (!Array.isArray(valor)) return valor;
  if (valor[0] === 'interpolate') return [...valor.slice(0, 3), ...valor.slice(3).map((v, i) => (i % 2 === 1 ? escalar(v, factor) : v))];
  if (valor[0] === 'step') return [valor[0], valor[1], ...valor.slice(2).map((v, i) => (i % 2 === 0 ? escalar(v, factor) : v))];
  return valor;
}

// Textos más grandes para la pantalla del iPhone y, sobre el satélite, blancos con borde oscuro
// (los colores del mapa claro se pierden sobre la foto).
const FACTOR_TEXTO = 1.15;
const FACTOR_TEXTO_SATELITE = 1.25;
function textosLegibles(capas, sobreSatelite) {
  return capas.map((c) => {
    if (c.type !== 'symbol' || !c.layout?.['text-field']) return c;
    const layout = { ...c.layout, 'text-size': escalar(c.layout['text-size'] ?? 16, sobreSatelite ? FACTOR_TEXTO_SATELITE : FACTOR_TEXTO) };
    // Sobre la foto, la letra regular se ve muy delgada: se usa la versión Medium.
    if (sobreSatelite && Array.isArray(layout['text-font'])) {
      layout['text-font'] = layout['text-font'].map((f) => (f === 'Noto Sans Regular' ? 'Noto Sans Medium' : f));
    }
    const paint = sobreSatelite
      ? { ...c.paint, 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 2.2, 'text-halo-blur': 0.5 }
      : { ...c.paint, 'text-halo-width': Math.max(1.5, typeof c.paint?.['text-halo-width'] === 'number' ? c.paint['text-halo-width'] : 0) };
    return { ...c, layout, paint };
  });
}

// El estilo base dibuja senderos y huellas muy tenues; para trekking los queremos bien visibles.
function resaltarSenderos(capas, tema) {
  const color = { dark: '#d9a877', satelite: '#ffd25a' }[tema] || '#9a5b2e';
  return capas.map((c) => (c.id !== 'roads_other' ? c : {
    ...c,
    minzoom: Math.min(c.minzoom ?? 12, 12),
    paint: {
      'line-color': color,
      'line-dasharray': [2, 1.2],
      'line-opacity': 0.9,
      'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 1, 15, 2.2, 18, 4.5],
    },
  }));
}
