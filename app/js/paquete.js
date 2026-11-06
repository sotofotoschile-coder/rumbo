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
  alProgreso?.('Relieve…');
  for (const t of ['relieve', 'curvas']) {
    for (const r of await mapas.listarDatos(t)) {
      const f = await mapas.archivoDe(r);
      items.push({ tipo: 'mapa', meta: r, offset: agregar(f), size: f.size });
    }
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
  // Las fotos de los lugares viajan como datos binarios; en la lista solo queda su posición.
  const lugares = (await db.todos('lugares')).map((l) => {
    if (!l.foto) return l;
    const { foto, ...resto } = l;
    return { ...resto, fotoRef: [agregar(foto), foto.size] };
  });
  items.push({ tipo: 'lugares', datos: lugares });
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
    // Las imágenes van seguidas en el paquete: se leen en bloques de ~8 MB y cada una se guarda
    // como copia en memoria. Guardar trozos que apuntan al archivo elegido es lentísimo en Safari
    // (horas para 25.000 imágenes).
    const total = s.indice.length;
    alProgreso?.('Imágenes satelitales', 0, total);
    let i = 0;
    while (i < total) {
      const ini = s.indice[i][1];
      let j = i + 1;
      while (j < total && s.indice[j][1] + s.indice[j][2] - ini <= 8e6 && j - i < 600) j++;
      const fin = s.indice[j - 1][1] + s.indice[j - 1][2];
      const bloque = new Uint8Array(await trozo(ini, fin - ini).arrayBuffer());
      const lote = [];
      for (let k = i; k < j; k++) {
        const [id, o, n] = s.indice[k];
        lote.push({ id, blob: new Blob([bloque.slice(o - ini, o - ini + n)], { type: 'image/jpeg' }) });
      }
      await db.guardarVarios('sat', lote);
      hecho.teselas += lote.length;
      i = j;
      alProgreso?.('Imágenes satelitales', hecho.teselas, total);
    }
    await db.guardarVarios('zonas', s.zonas);
  }
  const lugares = items.find((i) => i.tipo === 'lugares')?.datos || [];
  for (const l of lugares) {
    if (l.fotoRef) {
      const [o, n] = l.fotoRef;
      l.foto = new Blob([await trozo(o, n).arrayBuffer()], { type: 'image/jpeg' });
      delete l.fotoRef;
    }
  }
  if (lugares.length) { await db.guardarVarios('lugares', lugares); hecho.lugares = lugares.length; }
  const tracks = items.find((i) => i.tipo === 'tracks')?.datos || [];
  if (tracks.length) { await db.guardarVarios('tracks', tracks); hecho.tracks = tracks.length; }
  const conf = items.find((i) => i.tipo === 'ajustes')?.datos || {};
  for (const k of ['capa', 'etiquetas', 'tema', 'perfil']) if (conf[k] !== undefined) await ajustes.escribir(k, conf[k]);
  if (conf.claveEsri) { await ajustes.escribir('claveEsri', conf.claveEsri); hecho.clave = true; }
  return hecho;
}
