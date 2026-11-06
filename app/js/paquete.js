// Paquete .rumbo: junta en un solo archivo todo lo descargado en este iPhone (mapas, rutas,
// imágenes satelitales, lugares, tracks y ajustes) para instalarlo en otro iPhone sin internet.
//
// Formato: "RUMBOPKG" · u32 versión · u32 largo de la cabecera · cabecera JSON · datos.
// La cabecera describe cada parte con su posición (offset) y tamaño dentro de los datos.
import { db, ajustes } from './db.js';
import * as mapas from './mapas.js';
import * as sat from './satelite.js';

const MAGIA = 'RUMBOPKG';
const VERSION = 1;

// Crea el archivo del paquete. Los Blob se encadenan sin copiar los datos, así que no usa
// más memoria aunque el paquete pese cientos de MB.
export async function crearPaquete({ incluirClave = false, alProgreso } = {}) {
  const partes = [];
  let offset = 0;
  const agregar = (blob) => { partes.push(blob); const o = offset; offset += blob.size; return o; };
  const items = [];

  alProgreso?.('Mapas…');
  for (const m of await mapas.listar()) {
    const f = await mapas.archivoDe(m);
    items.push({ tipo: 'mapa', meta: m, offset: agregar(f), size: f.size });
  }
  alProgreso?.('Rutas…');
  for (const r of await mapas.listarRutas()) {
    const f = await mapas.archivoDe(r);
    items.push({ tipo: 'rutas', meta: r, offset: agregar(f), size: f.size });
  }
  alProgreso?.('Imágenes satelitales…');
  const teselas = await db.todos('sat');
  const indice = teselas.map((t) => [t.id, agregar(t.blob), t.blob.size]);
  items.push({ tipo: 'satelite', zonas: await sat.listarZonas(), indice });
  alProgreso?.('Lugares y tracks…');
  items.push({ tipo: 'lugares', datos: await db.todos('lugares') });
  items.push({ tipo: 'tracks', datos: (await db.todos('tracks')).filter((t) => !t.abierto) });
  const conf = {
    capa: await ajustes.leer('capa', 'mapa'),
    etiquetas: await ajustes.leer('etiquetas', true),
    tema: await ajustes.leer('tema', 'auto'),
    perfil: await ajustes.leer('perfil', 'auto'),
  };
  if (incluirClave) conf.claveEsri = await ajustes.leer('claveEsri', '');
  items.push({ tipo: 'ajustes', datos: conf });

  const cabecera = new TextEncoder().encode(JSON.stringify({ creado: Date.now(), items }));
  const prefijo = new Uint8Array(16);
  prefijo.set(new TextEncoder().encode(MAGIA), 0);
  new DataView(prefijo.buffer).setUint32(8, VERSION, true);
  new DataView(prefijo.buffer).setUint32(12, cabecera.length, true);
  const fecha = new Date().toISOString().slice(0, 10);
  // Se escribe como un solo archivo en el almacenamiento de la app: con miles de imágenes
  // satelitales sueltas, el menú Compartir de iOS no alcanza a armarlo en memoria.
  const compuesto = new Blob([prefijo, cabecera, ...partes]);
  const enDisco = await mapas.guardarArchivo(compuesto, 'paquete-envio.rumbo',
    (hecho, total) => alProgreso?.('Escribiendo el paquete', hecho, total));
  const archivo = new File([enDisco], `rumbo-${fecha}.rumbo`, { type: 'application/octet-stream' });
  const resumen = {
    mapas: items.filter((i) => i.tipo === 'mapa').length,
    rutas: items.filter((i) => i.tipo === 'rutas').length,
    teselas: indice.length,
    lugares: items.find((i) => i.tipo === 'lugares').datos.length,
    tracks: items.find((i) => i.tipo === 'tracks').datos.length,
    clave: !!conf.claveEsri,
  };
  return { archivo, resumen };
}

export async function esPaquete(archivo) {
  if (archivo.size < 16) return false;
  return new TextDecoder().decode(await archivo.slice(0, 8).arrayBuffer()) === MAGIA;
}

// Instala todo lo que trae el paquete. No borra nada de lo que ya hay en este iPhone.
export async function importarPaquete(archivo, alProgreso) {
  const dv = new DataView(await archivo.slice(8, 16).arrayBuffer());
  if (dv.getUint32(0, true) > VERSION) throw new Error('Este paquete es de una versión más nueva de Rumbo. Actualiza la app primero.');
  const largo = dv.getUint32(4, true);
  const { items } = JSON.parse(new TextDecoder().decode(await archivo.slice(16, 16 + largo).arrayBuffer()));
  const base = 16 + largo;
  const trozo = (o, n, tipo = '') => archivo.slice(base + o, base + o + n, tipo);
  const hecho = { mapas: 0, rutas: 0, teselas: 0, lugares: 0, tracks: 0, clave: false };

  const yaMapas = await mapas.listar();
  for (const it of items.filter((i) => i.tipo === 'mapa')) {
    if (yaMapas.some((m) => m.nombre === it.meta.nombre && m.bytes === it.size)) continue; // ya estaba
    await mapas.instalar(trozo(it.offset, it.size), it.meta.nombre, (h, t) => alProgreso?.(`Mapa ${it.meta.nombre}`, h, t));
    hecho.mapas++;
  }
  for (const it of items.filter((i) => i.tipo === 'rutas')) {
    await mapas.instalar(trozo(it.offset, it.size), it.meta.nombre, (h, t) => alProgreso?.('Rutas sin conexión', h, t));
    hecho.rutas++;
  }
  const s = items.find((i) => i.tipo === 'satelite');
  if (s) {
    const LOTE = 200;
    for (let i = 0; i < s.indice.length; i += LOTE) {
      const lote = s.indice.slice(i, i + LOTE).map(([id, o, n]) => ({ id, blob: trozo(o, n, 'image/jpeg') }));
      await db.guardarVarios('sat', lote);
      hecho.teselas += lote.length;
      alProgreso?.('Imágenes satelitales', hecho.teselas, s.indice.length);
    }
    await db.guardarVarios('zonas', s.zonas);
  }
  const lugares = items.find((i) => i.tipo === 'lugares')?.datos || [];
  if (lugares.length) { await db.guardarVarios('lugares', lugares); hecho.lugares = lugares.length; }
  const tracks = items.find((i) => i.tipo === 'tracks')?.datos || [];
  if (tracks.length) { await db.guardarVarios('tracks', tracks); hecho.tracks = tracks.length; }
  const conf = items.find((i) => i.tipo === 'ajustes')?.datos || {};
  for (const k of ['capa', 'etiquetas', 'tema', 'perfil']) if (conf[k] !== undefined) await ajustes.escribir(k, conf[k]);
  if (conf.claveEsri) { await ajustes.escribir('claveEsri', conf.claveEsri); hecho.clave = true; }
  return hecho;
}
