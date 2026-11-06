import { pintarIconos, icono } from './iconos.js';
import { db, ajustes, nuevoId } from './db.js';
import * as geo from './geo.js';
import { Gps, Brujula, PantallaEncendida } from './sensores.js';
import * as mapas from './mapas.js';
import * as sat from './satelite.js';
import { Grabador, duracion, lineas, perfil, trackAGpx, lugaresAGpx, compartirArchivo } from './tracks.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);

const gps = new Gps();
const brujula = new Brujula();
const pantalla = new PantallaEncendida();
const grabador = new Grabador();

const estado = {
  mapaActivo: null,
  urlFuente: null,
  temaPreferido: 'auto', // auto | light | dark
  capa: 'mapa', // mapa | satelite | hd
  etiquetas: true, // caminos y nombres sobre el satélite
  claveEsri: '',
  descargaSat: null, // { control: AbortController, hechas, total, bytes, nombre }
  modo: 'libre', // libre | seguir | rumbo
  lugares: [],
  trackVisto: null,
  primeraPosicion: true,
};

const oscuroSistema = matchMedia('(prefers-color-scheme: dark)');
const temaEfectivo = () => (estado.temaPreferido === 'auto' ? (oscuroSistema.matches ? 'dark' : 'light') : estado.temaPreferido);

// ---------- Mapa ----------
function vistaGuardada() {
  try { return JSON.parse(localStorage.getItem('rumbo:vista')); } catch (_) { return null; }
}
const vista = vistaGuardada();
const mapa = new maplibregl.Map({
  container: 'map',
  style: mapas.estilo(null, temaEfectivo()),
  center: vista?.centro || [-70.91, -53.16],
  zoom: vista?.zoom ?? 6,
  attributionControl: false,
  touchPitch: false,
  maxPitch: 0,
  fadeDuration: 0,
});
mapa.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
// Los créditos quedan plegados en el botón (i) para no tapar el mapa en la pantalla del iPhone.
mapa.on('styledata', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
mapa.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 90 }), 'bottom-left');
mapa.on('error', (e) => { if (!/404|Failed to fetch/.test(String(e?.error?.message))) console.warn(e.error); });
mapa.on('moveend', () => {
  try { localStorage.setItem('rumbo:vista', JSON.stringify({ centro: mapa.getCenter().toArray(), zoom: mapa.getZoom() })); } catch (_) { /* sin almacenamiento */ }
});

const vacia = { type: 'FeatureCollection', features: [] };
function agregarCapasPropias() {
  const fuente = (id) => mapa.getSource(id) || mapa.addSource(id, { type: 'geojson', data: vacia });
  ['precision', 'track-visto', 'track-actual', 'lugares'].forEach(fuente);
  mapa.addLayer({ id: 'precision', type: 'fill', source: 'precision', paint: { 'fill-color': '#2f7df6', 'fill-opacity': 0.12 } });
  mapa.addLayer({ id: 'track-visto', type: 'line', source: 'track-visto', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#8b5cf6', 'line-width': 4, 'line-opacity': 0.85 } });
  mapa.addLayer({ id: 'track-actual', type: 'line', source: 'track-actual', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f08a24', 'line-width': 5 } });
  mapa.addLayer({ id: 'lugares-punto', type: 'circle', source: 'lugares',
    paint: { 'circle-radius': 7, 'circle-color': '#e5484d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
  if (estado.urlFuente) {
    mapa.addLayer({ id: 'lugares-nombre', type: 'symbol', source: 'lugares',
      layout: { 'text-field': ['get', 'nombre'], 'text-font': ['Noto Sans Medium'], 'text-size': 13, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#a8292d', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
  }
  pintarLugares();
  pintarTrackActual();
  pintarTrackVisto();
  const p = gps.ultima;
  if (p) mapa.getSource('precision').setData(geo.circulo(p.coords.longitude, p.coords.latitude, p.coords.accuracy));
}
mapa.on('style.load', agregarCapasPropias);

function aplicarEstilo() {
  const capa = estado.capa === 'hd' && !estado.claveEsri ? 'satelite' : estado.capa;
  mapa.setStyle(mapas.estilo(estado.urlFuente, temaEfectivo(), { capa, etiquetas: estado.etiquetas, claveEsri: estado.claveEsri }), { diff: false });
}
oscuroSistema.addEventListener('change', () => { if (estado.temaPreferido === 'auto') aplicarEstilo(); });

// Sentinel-2 tiene 10 m por píxel: de cerca se ve borroso. Al acercarse mucho se sugiere
// Satélite HD (una vez por sesión, o de nuevo si se vuelve a elegir Satélite).
const ZOOM_AVISO_HD = 15.5;
let avisoHdMostrado = false;
mapa.on('zoomend', () => {
  const sinHd = estado.capa === 'satelite' || (estado.capa === 'hd' && !estado.claveEsri);
  if (!sinHd || avisoHdMostrado || mapa.getZoom() < ZOOM_AVISO_HD) return;
  avisoHdMostrado = true;
  const texto = estado.capa === 'hd'
    ? 'Falta tu clave de ArcGIS: por eso ves Sentinel-2, que de cerca se ve borroso.'
    : 'De cerca Sentinel-2 se ve borroso (10 m por píxel). Para ver casas usa Satélite HD, con internet.';
  avisar(texto, {
    accion: estado.capa === 'hd' ? 'Agregar clave' : 'Usar HD',
    alAccion: () => acciones.capa('hd'),
    duracion: 8000,
  });
});

async function activarMapa(m, { encuadrar = false } = {}) {
  estado.mapaActivo = m;
  estado.urlFuente = m ? await mapas.abrirFuente(m) : null;
  await ajustes.escribir('mapaActivo', m ? m.id : null);
  aplicarEstilo();
  $('#vacio').hidden = !!m;
  if (m && encuadrar) encuadrarMapa(m);
}

function encuadrarMapa(m) {
  const [o, s, e, n] = m.limites;
  mapa.fitBounds([[o, s], [e, n]], { padding: 40, duration: 800 });
}

// ---------- Marcador de posición ----------
const puckEl = document.createElement('div');
puckEl.className = 'puck';
puckEl.innerHTML = '<div class="puck-cono" hidden></div><div class="puck-punto"></div>';
const puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'map' });
let puckEnMapa = false;

function rumboActual() {
  if (brujula.activa && brujula.rumbo != null) return brujula.rumbo;
  const c = gps.ultima?.coords;
  if (c && c.heading != null && !Number.isNaN(c.heading) && c.speed > 1) return c.heading;
  return null;
}

function actualizarRumbo() {
  const r = rumboActual();
  $('#dato-rumbo').textContent = geo.fmtRumbo(r);
  const cono = puckEl.querySelector('.puck-cono');
  cono.hidden = r == null;
  if (r != null) puck.setRotation(r);
  actualizarHojaBrujula();
}

let giroPendiente = false;
brujula.addEventListener('rumbo', () => {
  if (giroPendiente) return;
  giroPendiente = true;
  requestAnimationFrame(() => {
    giroPendiente = false;
    actualizarRumbo();
    const r = rumboActual();
    if (estado.modo === 'rumbo' && r != null && Math.abs(((mapa.getBearing() - r + 540) % 360) - 180) > 1.5) {
      mapa.jumpTo({ bearing: r });
    }
  });
});

gps.addEventListener('posicion', (e) => {
  const p = e.detail;
  const { longitude: lon, latitude: lat, accuracy, altitude, speed } = p.coords;
  puck.setLngLat([lon, lat]);
  if (!puckEnMapa) { puck.addTo(mapa); puckEnMapa = true; }
  puckEl.classList.remove('sin-senal');
  mapa.getSource('precision')?.setData(geo.circulo(lon, lat, accuracy));
  $('#dato-altitud').textContent = geo.fmtAltitud(altitude);
  $('#dato-velocidad').textContent = geo.fmtVelocidad(speed ?? 0);
  actualizarRumbo();
  grabador.agregar(p);
  if (estado.modo !== 'libre') {
    const r = estado.modo === 'rumbo' ? rumboActual() : null;
    mapa.easeTo({
      center: [lon, lat],
      zoom: estado.primeraPosicion ? Math.max(mapa.getZoom(), 15) : mapa.getZoom(),
      bearing: r ?? mapa.getBearing(),
      duration: estado.primeraPosicion ? 900 : 500,
    });
    estado.primeraPosicion = false;
  }
  if (hojaAbierta === 'lugares') refrescarDistanciasLugares();
});

let ultimoAvisoGps = 0;
gps.addEventListener('error', (e) => {
  puckEl.classList.add('sin-senal');
  if (Date.now() - ultimoAvisoGps > 20000 || e.detail.codigo === 1) {
    ultimoAvisoGps = Date.now();
    avisar(e.detail.texto, { duracion: 5000 });
  }
});

// ---------- Modos de seguimiento ----------
function fijarModo(modo) {
  estado.modo = modo;
  const btn = $('#btn-ubicacion');
  btn.classList.toggle('activo', modo !== 'libre');
  $('#icono-ubicacion').innerHTML = icono(modo === 'libre' ? 'ubicacion' : modo);
  btn.setAttribute('aria-label', { libre: 'Mi ubicación', seguir: 'Siguiendo tu posición', rumbo: 'El mapa gira con tu rumbo' }[modo]);
  if (modo === 'libre') pantalla.soltar('seguir');
  else pantalla.pedir('seguir');
  if (modo === 'seguir' && mapa.getBearing() !== 0 && estado.modoAnterior === 'rumbo') mapa.easeTo({ bearing: 0, duration: 400 });
  estado.modoAnterior = modo;
}

// Lleva el mapa a tu última posición conocida (aunque estés quieto y el GPS no envíe datos nuevos).
function centrarEnMiPosicion() {
  gps.iniciar();
  const p = gps.ultima;
  if (!p) {
    estado.primeraPosicion = true;
    avisar('Buscando señal GPS… Al aire libre y en modo avión puede tardar un par de minutos.', { duracion: 6000 });
    return;
  }
  const { longitude: lon, latitude: lat } = p.coords;
  estado.primeraPosicion = false;
  mapa.easeTo({ center: [lon, lat], zoom: Math.max(mapa.getZoom(), 15), duration: 700 });
  const lim = estado.mapaActivo?.limites;
  if (lim && (lon < lim[0] || lat < lim[1] || lon > lim[2] || lat > lim[3])) {
    avisar(`Estás fuera del mapa «${estado.mapaActivo.nombre}». Tu posición se ve, pero sin calles ni senderos alrededor.`, { duracion: 7000 });
  }
}

$('#btn-ubicacion').addEventListener('click', async () => {
  gps.iniciar();
  if (estado.modo === 'libre') {
    fijarModo('seguir');
    centrarEnMiPosicion();
  } else if (estado.modo === 'seguir') {
    const ok = await brujula.activar().catch(() => false);
    if (!ok && !rumboActual()) avisar('Sin brújula: el mapa girará cuando te muevas.');
    fijarModo('rumbo');
    const r = rumboActual();
    if (r != null) mapa.easeTo({ bearing: r, duration: 400 });
  } else {
    fijarModo('seguir');
  }
});

mapa.on('dragstart', (e) => { if (e.originalEvent && estado.modo !== 'libre') fijarModo('libre'); });
mapa.on('rotate', () => { $('#aguja-norte').style.transform = `rotate(${-mapa.getBearing()}deg)`; });
$('#btn-norte').addEventListener('click', () => {
  if (estado.modo === 'rumbo') fijarModo('seguir');
  mapa.easeTo({ bearing: 0, pitch: 0, duration: 400 });
});

// ---------- Lugares (waypoints) ----------
async function cargarLugares() {
  estado.lugares = (await db.todos('lugares')).sort((a, b) => b.creado - a.creado);
  pintarLugares();
}
function pintarLugares() {
  mapa.getSource('lugares')?.setData({
    type: 'FeatureCollection',
    features: estado.lugares.map((l) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon, l.lat] }, properties: { id: l.id, nombre: l.nombre } })),
  });
}

let pulsacion = null;
const cancelarPulsacion = () => { clearTimeout(pulsacion); pulsacion = null; };
mapa.on('touchstart', (e) => {
  cancelarPulsacion();
  if (e.originalEvent.touches.length !== 1) return;
  const { lng, lat } = e.lngLat;
  pulsacion = setTimeout(() => { pulsacion = null; navigator.vibrate?.(15); hojaNuevoLugar(lng, lat, null); }, 650);
});
['touchend', 'touchmove', 'touchcancel', 'movestart', 'zoomstart'].forEach((ev) => mapa.on(ev, cancelarPulsacion));
mapa.on('contextmenu', (e) => hojaNuevoLugar(e.lngLat.lng, e.lngLat.lat, null));
mapa.on('click', 'lugares-punto', (e) => {
  const l = estado.lugares.find((x) => x.id === e.features[0].properties.id);
  if (l) hojaLugar(l);
});

// ---------- Tracks ----------
function pintarTrackActual() {
  const lin = lineas(grabador.track);
  mapa.getSource('track-actual')?.setData({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lin }, properties: {} });
}
function pintarTrackVisto() {
  const lin = lineas(estado.trackVisto);
  mapa.getSource('track-visto')?.setData({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lin }, properties: {} });
}

let reloj = null;
function actualizarPildora() {
  const pill = $('#grabando');
  const t = grabador.track;
  pill.hidden = grabador.estado === 'detenido';
  pill.classList.toggle('pausado', grabador.estado === 'pausado');
  if (!t) return;
  $('#grabando-texto').textContent = `${grabador.estado === 'pausado' ? 'En pausa' : 'Grabando'} · ${geo.fmtDuracion(grabador.tiempo())} · ${geo.fmtDistancia(t.distancia)}`;
  if (hojaAbierta === 'tracks') actualizarEstadisticasGrabacion();
}
grabador.addEventListener('punto', () => { pintarTrackActual(); actualizarPildora(); if (hojaAbierta === 'tracks') actualizarEstadisticasGrabacion(); });
grabador.addEventListener('cambio', () => {
  pintarTrackActual();
  actualizarPildora();
  clearInterval(reloj);
  if (grabador.estado === 'grabando') {
    gps.iniciar();
    pantalla.pedir('grabar');
    reloj = setInterval(actualizarPildora, 1000);
  } else pantalla.soltar('grabar');
  if (hojaAbierta === 'tracks') hojaTracks();
});
$('#grabando').addEventListener('click', () => hojaTracks());

// ---------- Búsqueda ----------
let marcaBusqueda = null;
$('#buscar').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#buscar-texto');
  const texto = input.value.trim();
  input.blur();
  if (!texto) return;
  const c = geo.leerCoordenadas(texto);
  if (c) {
    marcaBusqueda?.remove();
    marcaBusqueda = new maplibregl.Marker({ color: '#2f7df6' }).setLngLat([c.lon, c.lat]).addTo(mapa);
    if (estado.modo !== 'libre') fijarModo('libre');
    mapa.flyTo({ center: [c.lon, c.lat], zoom: Math.max(mapa.getZoom(), 14) });
    avisar(geo.fmtCoordDecimal(c.lat, c.lon), { accion: 'Guardar', alAccion: () => hojaNuevoLugar(c.lon, c.lat, null), duracion: 6000 });
    return;
  }
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const l = estado.lugares.find((x) => norm(x.nombre).includes(norm(texto)));
  if (l) {
    if (estado.modo !== 'libre') fijarModo('libre');
    mapa.flyTo({ center: [l.lon, l.lat], zoom: Math.max(mapa.getZoom(), 14) });
    return;
  }
  avisar(`No encontré «${texto}». Por ahora puedes buscar coordenadas o tus lugares guardados.`, { duracion: 5000 });
});

// ---------- Avisos ----------
let temporizadorAviso = null;
function avisar(texto, { accion, alAccion, duracion = 3500 } = {}) {
  const el = $('#aviso');
  el.innerHTML = `${esc(texto)}${accion ? `<button type="button">${esc(accion)}</button>` : ''}`;
  if (accion) el.querySelector('button').onclick = () => { el.hidden = true; alAccion(); };
  el.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { el.hidden = true; }, duracion);
}

// ---------- Hojas ----------
let hojaAbierta = null;
function abrirHoja(nombre, titulo, html) {
  hojaAbierta = nombre;
  $('#hoja-titulo').textContent = titulo;
  const c = $('#hoja-contenido');
  const scroll = c.scrollTop;
  c.innerHTML = html;
  pintarIconos(c);
  if ($('#hoja').hidden) c.scrollTop = 0; else c.scrollTop = scroll;
  $('#hoja').hidden = false;
  $('#fondo-hoja').hidden = false;
}
function cerrarHoja() {
  hojaAbierta = null;
  $('#hoja').hidden = true;
  $('#fondo-hoja').hidden = true;
}
$('#fondo-hoja').addEventListener('click', cerrarHoja);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && hojaAbierta) cerrarHoja(); });

document.querySelectorAll('[data-hoja]').forEach((b) => b.addEventListener('click', () => {
  ({ tracks: hojaTracks, lugares: hojaLugares, brujula: hojaBrujula, mapas: hojaMapas })[b.dataset.hoja]();
}));
$('#btn-capas').addEventListener('click', () => hojaCapas());

const fila = ({ icono: ic, color, titulo, sub, extra = '', accion = '', id = '', clase = '' }) => `
  <div class="fila ${clase}" ${accion ? `data-accion="${accion}" data-id="${esc(id)}" role="button" tabindex="0"` : ''}>
    ${ic ? `<span class="icono-app ${color}" data-icono="${ic}"></span>` : ''}
    <div class="fila-texto"><div class="fila-titulo">${titulo}</div>${sub ? `<div class="fila-sub">${sub}</div>` : ''}</div>
    ${extra}
  </div>`;
const mini = (accion, ic, etiqueta, id = '', peligro = false) =>
  `<button class="mini ${peligro ? 'peligro' : ''}" data-accion="${accion}" data-id="${esc(id)}" aria-label="${etiqueta}"><span data-icono="${ic}"></span></button>`;

// Mapas
async function hojaMapas() {
  const lista = await mapas.listar();
  const zonas = await sat.listarZonas();
  const esp = await mapas.espacio();
  const filas = lista.map((m) => fila({
    icono: 'mapa', color: 'verde', titulo: esc(m.nombre), accion: 'activar-mapa', id: m.id,
    clase: estado.mapaActivo?.id === m.id ? 'seleccionada' : '',
    sub: `${estado.mapaActivo?.id === m.id ? 'En uso · ' : ''}${geo.fmtBytes(m.bytes)} · zoom ${m.maxZoom}`,
    extra: `${mini('encuadrar-mapa', 'ver', 'Ver zona', m.id)}${mini('borrar-mapa', 'basura', 'Borrar mapa', m.id, true)}`,
  })).join('');
  const filasZonas = zonas.map((z) => fila({
    icono: 'globo', color: 'azul', titulo: esc(z.nombre), accion: 'ver-zona', id: z.id,
    sub: `${geo.fmtBytes(z.bytes)} · zoom ${z.zMax}${z.completa ? '' : ' · incompleta'}`,
    extra: `${mini('ver-zona', 'ver', 'Ver zona', z.id)}${mini('borrar-zona', 'basura', 'Borrar zona satelital', z.id, true)}`,
  })).join('');
  abrirHoja('mapas', 'Mapas offline', `
    ${lista.length ? `<div class="grupo-titulo">En este iPhone</div><div class="grupo">${filas}</div>` : '<p class="nota">Todavía no tienes mapas. Importa un paquete .pmtiles para usar la app sin conexión.</p>'}
    <div class="fila-botones"><button class="boton primario" data-accion="importar"><span data-icono="importar"></span>Importar desde Archivos</button></div>
    <div id="progreso-mapa" hidden><div class="barra-progreso"><div></div></div><div class="nota" id="progreso-texto"></div></div>
    <div class="grupo-titulo">Satélite sin conexión</div>
    ${zonas.length ? `<div class="grupo">${filasZonas}</div>` : '<p class="nota">Descarga imágenes satelitales de las zonas que vas a recorrer para verlas sin señal.</p>'}
    <div class="fila-botones"><button class="boton" data-accion="abrir-descarga-sat"><span data-icono="globo"></span>${estado.descargaSat ? 'Ver descarga en curso' : 'Descargar satélite'}</button></div>
    <div class="grupo-titulo">Descargar con internet</div>
    <input class="campo" id="url-mapa" type="url" inputmode="url" placeholder="https://…/magallanes.pmtiles" autocapitalize="off" autocorrect="off">
    <div class="fila-botones"><button class="boton" data-accion="descargar-mapa"><span data-icono="descargar"></span>Descargar</button></div>
    <p class="nota">${esp ? `Usando ${geo.fmtBytes(esp.usado)} de ${geo.fmtBytes(esp.cuota)} disponibles. ` : ''}${esp?.persistente ? 'Almacenamiento protegido: iOS no borrará tus mapas por falta de espacio.' : 'Los mapas quedan guardados dentro de la app y no requieren conexión.'}</p>`);
}

async function instalarMapa(origen, nombre) {
  hojaMapas();
  await new Promise((r) => setTimeout(r, 50));
  const caja = $('#progreso-mapa');
  if (caja) caja.hidden = false;
  const progreso = (hecho, total) => {
    const barra = $('#progreso-mapa .barra-progreso > div');
    const txt = $('#progreso-texto');
    if (barra && total) barra.style.width = `${Math.round((hecho / total) * 100)}%`;
    if (txt) txt.textContent = `Guardando ${nombre}: ${geo.fmtBytes(hecho)}${total ? ` de ${geo.fmtBytes(total)}` : ''}…`;
  };
  progreso(0, origen.size || 0);
  try {
    const m = await mapas.instalar(origen, nombre, progreso);
    await mapas.pedirPersistencia();
    await activarMapa(m, { encuadrar: true });
    avisar(`Mapa «${nombre}» listo para usar sin conexión.`);
  } catch (e) {
    avisar(e.message, { duracion: 7000 });
  }
  if (hojaAbierta === 'mapas') hojaMapas();
}

$('#archivo-mapa').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const nombre = f.name.replace(/\.pmtiles$/i, '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  instalarMapa(f, nombre);
});

// Capas
const marca = (si) => (si ? '<span class="marca" data-icono="check"></span>' : '');
async function hojaCapas() {
  const zonas = await sat.listarZonas();
  const tipo = (valor, icono, color, titulo, sub) => fila({ icono, color, titulo, sub, accion: 'capa', id: valor, extra: marca(estado.capa === valor) });
  const tema = (valor, titulo, sub) => fila({ titulo, sub, accion: 'tema', id: valor, extra: marca(estado.temaPreferido === valor) });
  const satelital = estado.capa !== 'mapa';
  let extra = '';
  if (satelital) {
    extra += `<div class="grupo">${fila({ titulo: 'Caminos, senderos y nombres', sub: 'Dibujados sobre la imagen satelital', accion: 'etiquetas', extra: marca(estado.etiquetas) })}</div>`;
  }
  if (estado.capa === 'hd') {
    extra += estado.claveEsri
      ? `<div class="grupo">${fila({ titulo: 'Clave de ArcGIS guardada', sub: 'La alta definición se ve cuando hay internet; sin señal se muestra Sentinel-2.', extra: `<button class="boton chico" data-accion="borrar-clave">Cambiar</button>` })}</div>`
      : `<div class="grupo-titulo">Clave gratuita de ArcGIS</div>
         <p class="nota">Esri entrega sus imágenes de alta definición solo con una clave personal, gratuita, de ArcGIS Location Platform. Mientras no la ingreses verás Sentinel-2.</p>
         <div class="fila-botones" style="margin-bottom:10px"><button class="boton primario" data-accion="importar-clave"><span data-icono="importar"></span>Importar clave desde Archivos</button></div>
         <p class="nota">Envía el archivo de la clave (.txt) por AirDrop y elígelo aquí. También puedes pegarla:</p>
         <input class="campo" id="clave-esri" type="text" placeholder="AAPK… o AAPT…" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Clave de ArcGIS">
         <div class="fila-botones" style="margin-bottom:14px"><button class="boton" data-accion="pegar-clave">Pegar</button><button class="boton" data-accion="guardar-clave">Guardar clave</button></div>`;
  }
  if (satelital) {
    extra += `<div class="fila-botones" style="margin-bottom:6px"><button class="boton" data-accion="abrir-descarga-sat"><span data-icono="descargar"></span>Descargar satélite de esta zona</button></div>
      <p class="nota">${zonas.length ? `Tienes ${zonas.length} ${zonas.length === 1 ? 'zona satelital descargada' : 'zonas satelitales descargadas'}. Fuera de ellas, el satélite solo se ve con internet.` : 'Aún no descargas imágenes satelitales: sin internet se verán solo donde las descargues.'}</p>`;
  } else {
    extra += `<div class="grupo-titulo">Tema</div><div class="grupo">${tema('auto', 'Automático', 'Claro de día, oscuro de noche según tu iPhone')}${tema('light', 'Claro', '')}${tema('dark', 'Oscuro', 'Cómodo de noche y ahorra batería en pantallas OLED')}</div>`;
  }
  abrirHoja('capas', 'Tipo de mapa', `
    <div class="grupo">
      ${tipo('mapa', 'mapa', 'verde', 'Mapa', 'Calles, caminos, senderos y lugares · sin conexión')}
      ${tipo('satelite', 'globo', 'azul', 'Satélite', `Sentinel-2 2025 · 10 m por píxel · sin conexión`)}
      ${tipo('hd', 'globo', 'morado', 'Satélite HD', 'Esri · menos de 1 m por píxel · solo con internet')}
    </div>
    ${extra}`);
}

// Busca la clave dentro de un texto (puede venir con espacios, saltos de línea u otras palabras).
async function guardarClaveEsri(texto) {
  const clave = (String(texto).match(/AAP[KT][\w.-]{20,}/) || [String(texto).trim()])[0];
  if (clave.length < 20 || /\s/.test(clave)) return avisar('Esa clave no parece válida. Debe empezar con AAPT o AAPK.');
  estado.claveEsri = clave;
  await ajustes.escribir('claveEsri', clave);
  aplicarEstilo();
  hojaCapas();
  avisar('Clave guardada solo en este iPhone. Acerca el mapa para ver el satélite HD.', { duracion: 5000 });
}
$('#archivo-clave').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 100000) return avisar('Ese archivo es demasiado grande para ser una clave.');
  guardarClaveEsri(await f.text());
});

// Descarga de imágenes satelitales por zonas
function hojaDescargaSat() {
  const d = estado.descargaSat;
  if (d) {
    const pct = d.total ? Math.round((d.hechas / d.total) * 100) : 0;
    abrirHoja('descarga-sat', 'Descargando satélite', `
      <p class="nota">${esc(d.nombre)}</p>
      <div class="barra-progreso"><div id="sat-barra" style="width:${pct}%"></div></div>
      <div class="nota" id="sat-texto">${textoProgresoSat()}</div>
      <div class="fila-botones"><button class="boton peligro" data-accion="cancelar-sat">Cancelar</button></div>
      <p class="nota">Mantén Rumbo abierta mientras descarga: iOS pausa las descargas de las apps web en segundo plano. Conviene usar Wi-Fi.</p>`);
    return;
  }
  const b = mapa.getBounds();
  const visible = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const opcion = (id, titulo, bbox, zMin, zMax) => {
    const n = sat.contarTeselas(bbox, zMin, zMax);
    const grande = n > sat.LIMITE_TESELAS;
    return fila({
      icono: 'descargar', color: grande ? 'gris' : 'azul', titulo,
      sub: grande ? 'Demasiado grande: acerca el mapa o elige menos detalle' : `${n.toLocaleString('es-CL')} imágenes · hasta ${geo.fmtBytes(n * sat.BYTES_POR_TESELA)}`,
      accion: grande ? '' : 'iniciar-descarga-sat', id,
    });
  };
  const region = estado.mapaActivo;
  abrirHoja('descarga-sat', 'Satélite sin conexión', `
    <input class="campo" id="nombre-zona" maxlength="60" value="Zona ${new Date().toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })}" aria-label="Nombre de la zona">
    <div class="grupo-titulo">Zona visible en pantalla</div>
    <div class="grupo">
      ${opcion('visible-14', 'Máximo detalle (zoom 14)', visible, 5, 14)}
      ${opcion('visible-13', 'Detalle medio (zoom 13)', visible, 5, 13)}
    </div>
    ${region ? `<div class="grupo-titulo">Región completa</div><div class="grupo">${opcion('region-12', `Toda la región «${esc(region.nombre)}» (zoom 12)`, region.limites, 4, 12)}</div>` : ''}
    <p class="nota">Las imágenes son Sentinel-2 cloudless 2025 de EOX: gratis para uso personal no comercial. El tamaño real suele ser menor que el estimado, porque el mar ocupa poco. Consejo: baja la región completa con detalle general y luego tus zonas de trekking con máximo detalle.</p>`);
}

function textoProgresoSat() {
  const d = estado.descargaSat;
  if (!d) return '';
  return `${d.hechas.toLocaleString('es-CL')} de ${d.total.toLocaleString('es-CL')} imágenes · ${geo.fmtBytes(d.bytes)}`;
}
function actualizarProgresoSat() {
  const d = estado.descargaSat;
  const barra = document.getElementById('sat-barra');
  const texto = document.getElementById('sat-texto');
  if (barra && d?.total) barra.style.width = `${Math.round((d.hechas / d.total) * 100)}%`;
  if (texto) texto.textContent = textoProgresoSat();
}

async function descargarSatelite({ nombre, bbox, zMin, zMax }) {
  if (estado.descargaSat) return avisar('Ya hay una descarga en curso.');
  if (!navigator.onLine) return avisar('Necesitas internet para descargar imágenes satelitales.');
  const control = new AbortController();
  estado.descargaSat = { control, hechas: 0, total: sat.contarTeselas(bbox, zMin, zMax), bytes: 0, nombre };
  pantalla.pedir('descarga');
  mapas.pedirPersistencia();
  hojaDescargaSat();
  try {
    const zona = await sat.descargarZona({ nombre, bbox, zMin, zMax }, (hechas, total, bytes) => {
      Object.assign(estado.descargaSat, { hechas, total, bytes });
      actualizarProgresoSat();
    }, control.signal);
    if (control.signal.aborted) avisar(`Descarga cancelada. Se guardó lo descargado (${geo.fmtBytes(zona.bytes)}).`, { duracion: 6000 });
    else avisar(`Satélite «${nombre}» listo sin conexión (${geo.fmtBytes(zona.bytes)}${zona.fallidas ? `, ${zona.fallidas} imágenes fallaron` : ''}).`, { duracion: 6000 });
    if (estado.capa === 'mapa') {
      estado.capa = 'satelite';
      await ajustes.escribir('capa', 'satelite');
    }
    aplicarEstilo();
  } catch (e) {
    avisar(e.message, { duracion: 7000 });
  } finally {
    estado.descargaSat = null;
    pantalla.soltar('descarga');
    if (hojaAbierta === 'descarga-sat') cerrarHoja();
    else if (hojaAbierta === 'mapas') hojaMapas();
  }
}

// Brújula
function svgBrujula() {
  const marcas = Array.from({ length: 72 }, (_, i) => {
    const largo = i % 18 === 0 ? 14 : i % 2 === 0 ? 8 : 4;
    return `<line x1="100" y1="10" x2="100" y2="${10 + largo}" transform="rotate(${i * 5} 100 100)" stroke="currentColor" stroke-width="${i % 18 === 0 ? 2.5 : 1.2}" opacity="${i % 18 === 0 ? 1 : 0.5}"/>`;
  }).join('');
  const letras = [['N', 0, '#e5484d'], ['E', 90], ['S', 180], ['O', 270]].map(([l, a, c]) =>
    `<text x="100" y="44" text-anchor="middle" font-size="18" font-weight="700" fill="${c || 'currentColor'}" transform="rotate(${a} 100 100)">${l}</text>`).join('');
  return `<svg class="brujula-grande" viewBox="0 0 200 200" aria-hidden="true">
    <circle cx="100" cy="100" r="96" fill="var(--superficie)" stroke="var(--linea)"/>
    <g id="rosa" style="transition: transform .12s linear; transform-origin: 100px 100px">${marcas}${letras}</g>
    <path d="M100 4 l7 12 h-14z" fill="#e5484d"/>
    <path d="M100 58 L110 100 L100 142 L90 100 Z" fill="none" stroke="var(--texto-2)" stroke-width="1.5"/>
    <circle cx="100" cy="100" r="4" fill="currentColor"/></svg>`;
}
function hojaBrujula() {
  abrirHoja('brujula', 'Brújula', `
    ${svgBrujula()}
    <div class="rumbo-grande" id="b-rumbo">—</div>
    <div class="rumbo-sub" id="b-fuente">${brujula.activa ? 'Brújula del iPhone' : 'Toca «Activar brújula» para usar el sensor'}</div>
    ${brujula.activa ? '' : '<div class="fila-botones" style="margin-bottom:14px"><button class="boton primario" data-accion="activar-brujula"><span data-icono="brujula"></span>Activar brújula</button></div>'}
    <div class="estadisticas">
      <div class="estadistica"><div class="etiqueta">Altitud</div><div class="valor" id="b-alt">—</div></div>
      <div class="estadistica"><div class="etiqueta">Velocidad</div><div class="valor" id="b-vel">—</div></div>
      <div class="estadistica"><div class="etiqueta">Precisión</div><div class="valor" id="b-prec">—</div></div>
    </div>
    <div class="grupo">
      ${fila({ titulo: '<span id="b-dec">—</span>', sub: 'Coordenadas (grados decimales)' })}
      ${fila({ titulo: '<span id="b-gms">—</span>', sub: 'Grados, minutos y segundos' })}
    </div>
    <p class="nota">La altitud viene del GPS y puede variar unos metros. Mantén el iPhone lejos de imanes y metales para que la brújula sea precisa.</p>`);
  gps.iniciar();
  actualizarHojaBrujula();
}
function actualizarHojaBrujula() {
  if (hojaAbierta !== 'brujula') return;
  const r = rumboActual();
  const rosa = document.getElementById('rosa');
  if (rosa && r != null) rosa.style.transform = `rotate(${-r}deg)`;
  $('#b-rumbo').textContent = geo.fmtRumbo(r);
  const c = gps.ultima?.coords;
  if (c) {
    $('#b-alt').textContent = geo.fmtAltitud(c.altitude);
    $('#b-vel').textContent = geo.fmtVelocidad(c.speed ?? 0);
    $('#b-prec').textContent = `±${Math.round(c.accuracy)} m`;
    $('#b-dec').textContent = geo.fmtCoordDecimal(c.latitude, c.longitude);
    $('#b-gms').textContent = geo.fmtCoordGMS(c.latitude, c.longitude);
  }
}
gps.addEventListener('posicion', actualizarHojaBrujula);

// Lugares
function subLugar(l) {
  const c = gps.ultima?.coords;
  if (!c) return geo.fmtCoordDecimal(l.lat, l.lon);
  const d = geo.distancia(c.longitude, c.latitude, l.lon, l.lat);
  return `${geo.fmtDistancia(d)} · ${geo.fmtRumbo(geo.azimut(c.longitude, c.latitude, l.lon, l.lat))}`;
}
function hojaLugares() {
  const c = gps.ultima?.coords;
  const lista = [...estado.lugares];
  if (c) lista.sort((a, b) => geo.distancia(c.longitude, c.latitude, a.lon, a.lat) - geo.distancia(c.longitude, c.latitude, b.lon, b.lat));
  const filas = lista.map((l) => fila({
    icono: 'pin', color: 'rojo', titulo: esc(l.nombre), sub: `<span data-dist="${l.id}">${subLugar(l)}</span>`, accion: 'abrir-lugar', id: l.id,
    extra: mini('ir-lugar', 'ver', 'Ver en el mapa', l.id),
  })).join('');
  abrirHoja('lugares', 'Lugares', `
    <div class="fila-botones" style="margin-bottom:14px">
      <button class="boton rojo" data-accion="guardar-aqui"><span data-icono="pin"></span>Guardar mi ubicación</button>
    </div>
    ${lista.length ? `<div class="grupo">${filas}</div>
      <div class="fila-botones"><button class="boton" data-accion="exportar-lugares"><span data-icono="compartir"></span>Exportar GPX</button></div>`
    : '<p class="nota">Mantén el dedo sobre el mapa para guardar cualquier punto, o guarda tu ubicación actual.</p>'}`);
}
function refrescarDistanciasLugares() {
  document.querySelectorAll('[data-dist]').forEach((el) => {
    const l = estado.lugares.find((x) => x.id === el.dataset.dist);
    if (l) el.textContent = subLugar(l);
  });
}
function hojaNuevoLugar(lon, lat, ele) {
  estado.nuevoLugar = { lon, lat, ele };
  abrirHoja('nuevo-lugar', 'Nuevo lugar', `
    <input class="campo" id="nombre-lugar" maxlength="60" value="Lugar ${estado.lugares.length + 1}" aria-label="Nombre del lugar">
    <p class="nota">${geo.fmtCoordDecimal(lat, lon)}${ele != null ? ` · ${geo.fmtAltitud(ele)}` : ''}</p>
    <div class="fila-botones"><button class="boton" data-accion="cerrar-hoja">Cancelar</button><button class="boton rojo" data-accion="confirmar-lugar">Guardar</button></div>`);
  const input = $('#nombre-lugar');
  input.focus();
  input.select();
}
function hojaLugar(l) {
  abrirHoja('lugar', esc(l.nombre), `
    <div class="grupo">
      ${fila({ titulo: geo.fmtCoordDecimal(l.lat, l.lon), sub: geo.fmtCoordGMS(l.lat, l.lon) })}
      ${fila({ titulo: `<span data-dist="${l.id}">${subLugar(l)}</span>`, sub: 'Distancia y rumbo desde tu posición' })}
      ${l.ele != null ? fila({ titulo: geo.fmtAltitud(l.ele), sub: 'Altitud' }) : ''}
      ${fila({ titulo: new Date(l.creado).toLocaleString('es-CL', { dateStyle: 'long', timeStyle: 'short' }), sub: 'Guardado' })}
    </div>
    <div class="fila-botones">
      <button class="boton" data-accion="ir-lugar" data-id="${l.id}"><span data-icono="ver"></span>Ver en mapa</button>
      <button class="boton peligro" data-accion="borrar-lugar" data-id="${l.id}"><span data-icono="basura"></span>Borrar</button>
    </div>`);
}

// Tracks
function estadisticasGrabacion() {
  const t = grabador.track;
  return `<div class="estadisticas" id="stats-grabacion">
    <div class="estadistica"><div class="etiqueta">Distancia</div><div class="valor">${geo.fmtDistancia(t?.distancia ?? 0)}</div></div>
    <div class="estadistica"><div class="etiqueta">Tiempo</div><div class="valor">${geo.fmtDuracion(grabador.tiempo())}</div></div>
    <div class="estadistica"><div class="etiqueta">Subida</div><div class="valor">+${geo.fmtAltitud(t?.subida ?? 0)}</div></div>
  </div>`;
}
function actualizarEstadisticasGrabacion() {
  const el = document.getElementById('stats-grabacion');
  if (el) el.outerHTML = estadisticasGrabacion();
}
async function hojaTracks() {
  const guardados = (await db.todos('tracks')).filter((t) => !t.abierto).sort((a, b) => b.inicio - a.inicio);
  const control = {
    detenido: `<div class="fila-botones"><button class="boton naranja" data-accion="grabar"><span data-icono="grabar"></span>Grabar track</button></div>`,
    grabando: `${estadisticasGrabacion()}<div class="fila-botones"><button class="boton" data-accion="pausar"><span data-icono="pausa"></span>Pausar</button><button class="boton rojo" data-accion="terminar"><span data-icono="detener"></span>Terminar</button></div>`,
    pausado: `${estadisticasGrabacion()}<div class="fila-botones"><button class="boton naranja" data-accion="reanudar"><span data-icono="reanudar"></span>Reanudar</button><button class="boton rojo" data-accion="terminar"><span data-icono="detener"></span>Terminar</button></div>`,
  }[grabador.estado];
  const filas = guardados.map((t) => fila({
    icono: 'track', color: 'naranja', titulo: esc(t.nombre), accion: 'abrir-track', id: t.id,
    sub: `${geo.fmtDistancia(t.distancia)} · ${geo.fmtDuracion(duracion(t))} · +${geo.fmtAltitud(t.subida)}`,
  })).join('');
  abrirHoja('tracks', 'Tracks', `${control}
    <p class="nota">Mientras grabas, la app mantiene la pantalla encendida: iOS pausa el GPS de las apps web si se bloquea la pantalla. Baja el brillo para ahorrar batería.</p>
    ${guardados.length ? `<div class="grupo-titulo">Historial</div><div class="grupo">${filas}</div>` : ''}`);
}
function svgPerfil(t) {
  const p = perfil(t);
  if (p.length < 2) return '';
  const dMax = p.at(-1)[0] || 1;
  const alts = p.map((x) => x[1]);
  const aMin = Math.min(...alts);
  const aMax = Math.max(...alts);
  const rango = Math.max(aMax - aMin, 10);
  const pts = p.map(([d, a]) => `${((d / dMax) * 300).toFixed(1)},${(78 - ((a - aMin) / rango) * 70).toFixed(1)}`).join(' ');
  return `<div class="grupo" style="padding:10px 12px">
    <div class="etiqueta">Perfil de elevación · ${geo.fmtAltitud(aMin)} a ${geo.fmtAltitud(aMax)}</div>
    <svg viewBox="0 0 300 80" preserveAspectRatio="none" style="width:100%;height:90px;display:block" aria-hidden="true">
      <polygon points="0,80 ${pts} 300,80" fill="#f08a24" opacity=".18"/><polyline points="${pts}" fill="none" stroke="#f08a24" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg></div>`;
}
async function hojaTrack(id) {
  const t = await db.obtener('tracks', id);
  if (!t) return hojaTracks();
  const dur = duracion(t);
  abrirHoja('track', 'Track', `
    <input class="campo" id="nombre-track" maxlength="80" value="${esc(t.nombre)}" data-id="${t.id}" aria-label="Nombre del track">
    <div class="estadisticas">
      <div class="estadistica"><div class="etiqueta">Distancia</div><div class="valor">${geo.fmtDistancia(t.distancia)}</div></div>
      <div class="estadistica"><div class="etiqueta">Tiempo</div><div class="valor">${geo.fmtDuracion(dur)}</div></div>
      <div class="estadistica"><div class="etiqueta">Media</div><div class="valor">${geo.fmtVelocidad(dur ? t.distancia / (dur / 1000) : 0)}</div></div>
      <div class="estadistica"><div class="etiqueta">Subida</div><div class="valor">+${geo.fmtAltitud(t.subida)}</div></div>
      <div class="estadistica"><div class="etiqueta">Bajada</div><div class="valor">−${geo.fmtAltitud(t.bajada)}</div></div>
      <div class="estadistica"><div class="etiqueta">Fecha</div><div class="valor" style="font-size:14px">${new Date(t.inicio).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })}</div></div>
    </div>
    ${svgPerfil(t)}
    <div class="fila-botones">
      <button class="boton" data-accion="ver-track" data-id="${t.id}"><span data-icono="ver"></span>Ver en mapa</button>
      <button class="boton" data-accion="exportar-track" data-id="${t.id}"><span data-icono="compartir"></span>GPX</button>
      <button class="boton peligro" data-accion="borrar-track" data-id="${t.id}"><span data-icono="basura"></span>Borrar</button>
    </div>`);
}
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'nombre-track') return;
  const t = await db.obtener('tracks', e.target.dataset.id);
  if (!t) return;
  t.nombre = e.target.value.trim() || t.nombre;
  await db.guardar('tracks', t);
});

// ---------- Acciones ----------
const acciones = {
  'cerrar-hoja': cerrarHoja,
  importar: () => $('#archivo-mapa').click(),
  'descargar-mapa': () => {
    const url = $('#url-mapa').value.trim();
    if (!/^https?:\/\/.+/i.test(url)) return avisar('Escribe una dirección que empiece con https://');
    const nombre = decodeURIComponent(url.split('/').pop().split('?')[0]).replace(/\.pmtiles$/i, '') || 'Mapa';
    instalarMapa({ url }, nombre);
  },
  'activar-mapa': async (id) => {
    const m = (await mapas.listar()).find((x) => x.id === id);
    if (m) { await activarMapa(m, { encuadrar: true }); hojaMapas(); }
  },
  'encuadrar-mapa': async (id) => {
    const m = (await mapas.listar()).find((x) => x.id === id);
    if (!m) return;
    if (estado.mapaActivo?.id !== m.id) await activarMapa(m);
    if (estado.modo !== 'libre') fijarModo('libre');
    cerrarHoja();
    encuadrarMapa(m);
  },
  'borrar-mapa': async (id) => {
    const m = (await mapas.listar()).find((x) => x.id === id);
    if (!m || !confirm(`¿Borrar el mapa «${m.nombre}» de este iPhone? Tendrás que importarlo de nuevo para usarlo.`)) return;
    await mapas.borrar(m);
    if (estado.mapaActivo?.id === id) {
      const resto = await mapas.listar();
      await activarMapa(resto[0] || null);
    }
    hojaMapas();
  },
  tema: async (valor) => {
    estado.temaPreferido = valor;
    await ajustes.escribir('tema', valor);
    aplicarEstilo();
    hojaCapas();
  },
  capa: async (valor) => {
    if (valor !== estado.capa) avisoHdMostrado = false;
    estado.capa = valor;
    await ajustes.escribir('capa', valor);
    aplicarEstilo();
    hojaCapas();
    if (valor === 'hd' && estado.claveEsri && !navigator.onLine) avisar('Sin internet: se muestra Sentinel-2 hasta que vuelva la señal.');
  },
  etiquetas: async () => {
    estado.etiquetas = !estado.etiquetas;
    await ajustes.escribir('etiquetas', estado.etiquetas);
    aplicarEstilo();
    hojaCapas();
  },
  'guardar-clave': () => guardarClaveEsri($('#clave-esri').value),
  'importar-clave': () => $('#archivo-clave').click(),
  'pegar-clave': async () => {
    try {
      const texto = await navigator.clipboard.readText();
      $('#clave-esri').value = texto.trim();
      if (texto.trim()) guardarClaveEsri(texto);
    } catch (_) {
      avisar('No se pudo leer el portapapeles. Mantén el dedo en el campo y elige «Pegar».');
    }
  },
  'borrar-clave': async () => {
    estado.claveEsri = '';
    await ajustes.escribir('claveEsri', '');
    aplicarEstilo();
    hojaCapas();
  },
  'abrir-descarga-sat': () => hojaDescargaSat(),
  'iniciar-descarga-sat': (id) => {
    const nombreZona = $('#nombre-zona')?.value.trim();
    if (id === 'region-12' && estado.mapaActivo) {
      return descargarSatelite({ nombre: nombreZona || estado.mapaActivo.nombre, bbox: estado.mapaActivo.limites, zMin: 4, zMax: 12 });
    }
    const b = mapa.getBounds();
    return descargarSatelite({ nombre: nombreZona || 'Zona', bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zMin: 5, zMax: id === 'visible-14' ? 14 : 13 });
  },
  'cancelar-sat': () => estado.descargaSat?.control.abort(),
  'ver-zona': async (id) => {
    const z = (await sat.listarZonas()).find((x) => x.id === id);
    if (!z) return;
    if (estado.modo !== 'libre') fijarModo('libre');
    if (estado.capa === 'mapa') { estado.capa = 'satelite'; await ajustes.escribir('capa', 'satelite'); aplicarEstilo(); }
    cerrarHoja();
    mapa.fitBounds([[z.bbox[0], z.bbox[1]], [z.bbox[2], z.bbox[3]]], { padding: 30, duration: 800 });
  },
  'borrar-zona': async (id) => {
    const z = (await sat.listarZonas()).find((x) => x.id === id);
    if (!z || !confirm(`¿Borrar las imágenes satelitales de «${z.nombre}»?`)) return;
    await sat.borrarZona(z);
    aplicarEstilo();
    hojaMapas();
  },
  'activar-brujula': async () => {
    const ok = await brujula.activar().catch(() => false);
    if (!ok) avisar('No se pudo activar la brújula. Revisa el permiso de movimiento y orientación.');
    hojaBrujula();
  },
  'guardar-aqui': () => {
    const c = gps.ultima?.coords;
    if (!c) { gps.iniciar(); return avisar('Esperando señal GPS para guardar tu ubicación…'); }
    hojaNuevoLugar(c.longitude, c.latitude, c.altitude ?? null);
  },
  'confirmar-lugar': async () => {
    const n = estado.nuevoLugar;
    if (!n) return;
    const nombre = $('#nombre-lugar').value.trim() || `Lugar ${estado.lugares.length + 1}`;
    await db.guardar('lugares', { id: nuevoId(), nombre, lon: n.lon, lat: n.lat, ele: n.ele, creado: Date.now() });
    estado.nuevoLugar = null;
    await cargarLugares();
    cerrarHoja();
    avisar(`«${nombre}» guardado.`);
  },
  'abrir-lugar': (id) => { const l = estado.lugares.find((x) => x.id === id); if (l) hojaLugar(l); },
  'ir-lugar': (id) => {
    const l = estado.lugares.find((x) => x.id === id);
    if (!l) return;
    if (estado.modo !== 'libre') fijarModo('libre');
    cerrarHoja();
    mapa.flyTo({ center: [l.lon, l.lat], zoom: Math.max(mapa.getZoom(), 15) });
  },
  'borrar-lugar': async (id) => {
    const l = estado.lugares.find((x) => x.id === id);
    if (!l || !confirm(`¿Borrar «${l.nombre}»?`)) return;
    await db.borrar('lugares', id);
    await cargarLugares();
    hojaLugares();
  },
  'exportar-lugares': () => compartirArchivo('lugares-rumbo.gpx', lugaresAGpx(estado.lugares)).catch((e) => avisar(e.message)),
  grabar: () => {
    cerrarHoja(); // primero: deja ver el mapa; el estado sigue en la píldora de arriba
    grabador.iniciar();
    if (estado.modo === 'libre') fijarModo('seguir');
    centrarEnMiPosicion();
  },
  pausar: () => grabador.pausar(),
  reanudar: () => grabador.reanudar(),
  terminar: async () => {
    if (!confirm('¿Terminar y guardar el track?')) return;
    const t = await grabador.terminar();
    avisar(t ? `Track guardado: ${geo.fmtDistancia(t.distancia)}.` : 'El track era demasiado corto y no se guardó.');
  },
  'abrir-track': (id) => hojaTrack(id),
  'ver-track': async (id) => {
    const t = await db.obtener('tracks', id);
    if (!t) return;
    estado.trackVisto = t;
    pintarTrackVisto();
    const pts = lineas(t).flat();
    if (!pts.length) return;
    const lon = pts.map((p) => p[0]);
    const lat = pts.map((p) => p[1]);
    if (estado.modo !== 'libre') fijarModo('libre');
    cerrarHoja();
    mapa.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]], { padding: 60, duration: 800, maxZoom: 16 });
  },
  'exportar-track': async (id) => {
    const t = await db.obtener('tracks', id);
    if (!t) return;
    const nombre = `${t.nombre.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'track'}.gpx`;
    compartirArchivo(nombre, trackAGpx(t)).catch((e) => avisar(e.message));
  },
  'borrar-track': async (id) => {
    if (!confirm('¿Borrar este track del historial?')) return;
    await db.borrar('tracks', id);
    if (estado.trackVisto?.id === id) { estado.trackVisto = null; pintarTrackVisto(); }
    hojaTracks();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-accion]');
  if (!el) return;
  const fn = acciones[el.dataset.accion];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el.dataset.id)).catch((err) => avisar(err.message || String(err), { duracion: 6000 }));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'nombre-lugar') acciones['confirmar-lugar']();
});

// ---------- Service worker (funcionamiento sin conexión) ----------
if ('serviceWorker' in navigator) {
  const habiaControlador = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (habiaControlador) avisar('Hay una versión nueva de Rumbo.', { accion: 'Actualizar', alAccion: () => location.reload(), duracion: 15000 });
  });
}

// Modo de prueba (?debug): permite simular posiciones GPS desde la consola.
if (new URLSearchParams(location.search).has('debug')) {
  window.rumbo = {
    gps, grabador, mapa, brujula,
    simular(lon, lat, alt = 100, precision = 5, velocidad = 1.2) {
      const p = { coords: { longitude: lon, latitude: lat, altitude: alt, accuracy: precision, speed: velocidad, heading: null }, timestamp: Date.now() };
      gps.ultima = p;
      gps.dispatchEvent(new CustomEvent('posicion', { detail: p }));
    },
  };
}

// ---------- Inicio ----------
async function iniciar() {
  pintarIconos();
  estado.temaPreferido = await ajustes.leer('tema', 'auto');
  estado.capa = await ajustes.leer('capa', 'mapa');
  estado.etiquetas = await ajustes.leer('etiquetas', true);
  estado.claveEsri = await ajustes.leer('claveEsri', '');
  await mapas.limpiarHuerfanos();
  const lista = await mapas.listar();
  const idActivo = await ajustes.leer('mapaActivo', null);
  const activo = lista.find((m) => m.id === idActivo) || lista[0] || null;
  await activarMapa(activo, { encuadrar: !!activo && !vista });
  await cargarLugares();
  await grabador.restaurar();
  gps.iniciar();
}
iniciar().catch((e) => avisar(`No se pudo iniciar: ${e.message}`, { duracion: 10000 }));
