import { pintarIconos, icono, trazo } from './iconos.js';
import { db, ajustes, nuevoId } from './db.js';
import * as geo from './geo.js';
import { Gps, Brujula, PantallaEncendida } from './sensores.js';
import * as mapas from './mapas.js';
import * as sat from './satelite.js';
import { crearNavegacion } from './navegacion.js';
import * as paquete from './paquete.js';
import * as relieve from './relieve.js';
import { Grabador, duracion, lineas, perfil, trackAGpx, lugaresAGpx, compartirArchivo, tiempoCortado } from './tracks.js';
import { iniciarCerros, abrirCerros, cerrarCerros } from './cerros.js';
import * as pron from './pronostico.js';
import { esZip, kmlDeKmz, leerKml } from './kml.js';
import * as dictado from './dictado.js';

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
  paquete: null, // { archivo: File, resumen } listo para enviar a otro iPhone
  gps: 'buscando', // buscando | ok | denegado
  modo: 'rumbo', // rumbo: te sigue y gira con tu dirección | libre: pausa breve mientras miras otra zona
  lugares: [],
  trackVisto: null,
  primeraPosicion: true,
};

const oscuroSistema = matchMedia('(prefers-color-scheme: dark)');
// Oscuro si lo pide el iPhone o el usuario, en ahorro de batería, o navegando de noche.
const temaEfectivo = () => {
  if (estado.ahorro || estado.nocheNav) return 'dark';
  return estado.temaPreferido === 'auto' ? (oscuroSistema.matches ? 'dark' : 'light') : estado.temaPreferido;
};

// ¿Está el sol bajo el horizonte? (cálculo astronómico aproximado; sirve sin internet)
function esDeNoche(lon, lat, fecha = new Date()) {
  const rad = Math.PI / 180;
  const d = (fecha.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * rad;
  const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const h = (gmst * 15 + lon) * rad - ra;
  const altura = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(h)) / rad;
  return altura < -3;
}
// Navegando de noche el mapa pasa a oscuro solo (se revisa como mucho una vez por minuto).
let ultimaRevisionNoche = 0;
function revisarNoche(lon, lat) {
  if (Date.now() - ultimaRevisionNoche < 60000 && estado.nocheNav === (nav.navegando() && estado.nocheNav)) return;
  ultimaRevisionNoche = Date.now();
  const noche = nav.navegando() && estado.capa === 'mapa' && esDeNoche(lon, lat);
  if (noche !== !!estado.nocheNav) { estado.nocheNav = noche; aplicarEstilo(); }
}

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
  revisarRegion();
});

// Con varias regiones instaladas (p. ej. Magallanes y Aysén), el mapa cambia solo a la región que estás mirando.
let temporizadorRegion = null;
const dentro = (lim, p) => lim && p[0] >= lim[0] && p[0] <= lim[2] && p[1] >= lim[1] && p[1] <= lim[3];
function revisarRegion() {
  clearTimeout(temporizadorRegion);
  temporizadorRegion = setTimeout(async () => {
    const c = mapa.getCenter().toArray();
    if (!estado.mapaActivo || dentro(estado.mapaActivo.limites, c)) return;
    const otro = (await mapas.listar()).find((m) => m.id !== estado.mapaActivo.id && dentro(m.limites, c));
    if (!otro) return;
    await activarMapa(otro);
    avisar(`Mapa de ${otro.nombre}`, { duracion: 2500 });
  }, 1200);
}

const vacia = { type: 'FeatureCollection', features: [] };
function agregarCapasPropias() {
  const fuente = (id) => mapa.getSource(id) || mapa.addSource(id, { type: 'geojson', data: vacia });
  ['precision', 'track-visto', 'track-actual', 'lugares', 'utiles', 'medida', 'dibujo', 'track-fotos', 'repeticion', 'objetivo'].forEach(fuente);
  mapa.addLayer({ id: 'objetivo', type: 'line', source: 'objetivo', layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#2f7df6', 'line-width': 3, 'line-dasharray': [1.5, 1.5] } });
  mapa.addLayer({ id: 'precision', type: 'fill', source: 'precision', paint: { 'fill-color': '#2f7df6', 'fill-opacity': 0.12 } });
  mapa.addLayer({ id: 'track-visto', type: 'line', source: 'track-visto', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#8b5cf6', 'line-width': 4, 'line-opacity': 0.85 } });
  mapa.addLayer({ id: 'track-actual', type: 'line', source: 'track-actual', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f08a24', 'line-width': 5 } });
  agregarImagenesLugares();
  fuente('senderos-dif');
  mapa.addLayer({ id: 'senderos-dif', type: 'line', source: 'senderos-dif', minzoom: 10, layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'd'], 1, '#2fb344', 2, '#1f7ae0', 3, '#e5484d', '#1c1c1e'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 6], 'line-opacity': 0.9,
      'line-dasharray': ['case', ['>=', ['get', 'd'], 4], ['literal', [2, 1]], ['literal', [1, 0]]] } });
  pintarSenderos();
  // Agua, refugios y campings de OpenStreetMap (vienen en las rutas sin conexión de la región).
  mapa.addLayer({ id: 'utiles-punto', type: 'symbol', source: 'utiles', minzoom: 11,
    layout: { 'icon-image': ['concat', 'lugar-', ['get', 'tipo']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 15, 1],
      'icon-allow-overlap': false, 'icon-padding': 1,
      ...(estado.urlFuente ? { 'text-field': ['get', 'nombre'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.2],
        'text-anchor': 'top', 'text-optional': true } : {}) },
    paint: { 'text-color': '#3a3a3c', 'text-halo-color': '#fff', 'text-halo-width': 1.6, 'text-opacity': ['step', ['zoom'], 0, 14, 1] } });
  // Medición de distancias y áreas.
  mapa.addLayer({ id: 'medida-area', type: 'fill', source: 'medida', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#ff9f0a', 'fill-opacity': 0.18 } });
  mapa.addLayer({ id: 'medida-linea', type: 'line', source: 'medida', filter: ['!=', ['geometry-type'], 'Point'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff9f0a', 'line-width': 3, 'line-dasharray': [2, 1.2] } });
  mapa.addLayer({ id: 'medida-puntos', type: 'circle', source: 'medida', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#ff9f0a', 'circle-stroke-width': 3 } });
  // Ruta de trekking dibujada: verde por senderos, punteada donde va a campo traviesa.
  mapa.addLayer({ id: 'dibujo-linea', type: 'line', source: 'dibujo', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#12a150', 'line-width': 5, 'line-dasharray': ['case', ['get', 'aPie'], ['literal', [1, 0]], ['literal', [1.5, 1.2]]] } });
  mapa.addLayer({ id: 'dibujo-puntos', type: 'circle', source: 'dibujo', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 7, 'circle-color': '#fff', 'circle-stroke-color': '#12a150', 'circle-stroke-width': 3 } });
  // Fotos del track que estás viendo, y el punto que avanza en la repetición 3D.
  mapa.addLayer({ id: 'track-fotos', type: 'circle', source: 'track-fotos',
    paint: { 'circle-radius': 9, 'circle-color': '#fff', 'circle-stroke-color': ['match', ['get', 'tipo'], 'nota', '#e5484d', '#8b5cf6'], 'circle-stroke-width': 4 } });
  mapa.addLayer({ id: 'repeticion', type: 'circle', source: 'repeticion',
    paint: { 'circle-radius': 8, 'circle-color': '#f08a24', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' } });
  mapa.addLayer({ id: 'lugares-punto', type: 'symbol', source: 'lugares',
    layout: { 'icon-image': ['concat', 'lugar-', ['coalesce', ['get', 'categoria'], 'general']], 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  if (estado.urlFuente) {
    mapa.addLayer({ id: 'lugares-nombre', type: 'symbol', source: 'lugares',
      layout: { 'text-field': ['get', 'nombre'], 'text-font': ['Noto Sans Medium'], 'text-size': 15, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#a8292d', 'text-halo-color': '#fff', 'text-halo-width': 2.2, 'text-halo-blur': 0.3 } });
  }
  pintarLugares();
  pintarUtiles();
  pintarMedida();
  pintarDibujo();
  pintarTrackActual();
  pintarTrackVisto();
  nav.agregarCapas();
  const p = gps.ultima;
  if (p) mapa.getSource('precision').setData(geo.circulo(p.coords.longitude, p.coords.latitude, p.coords.accuracy));
}
mapa.on('style.load', agregarCapasPropias);

function aplicarEstilo() {
  // Un solo «Satélite»: con clave, la imagen HD de Esri cuando hay internet y Sentinel-2 descargado cuando no.
  const capa = estado.capa === 'mapa' ? 'mapa' : estado.claveEsri ? 'hd' : 'satelite';
  mapa.setStyle(mapas.estilo(estado.urlFuente, temaEfectivo(), { capa, etiquetas: estado.etiquetas, claveEsri: estado.claveEsri,
    relieve: { ...relieve.estado, mostrar: estado.mostrarRelieve, curvas: estado.mostrarCurvas }, terreno3d: !!(estado.vista3d || estado.repeticion) }), { diff: false });
}
oscuroSistema.addEventListener('change', () => { if (estado.temaPreferido === 'auto') aplicarEstilo(); });

// Sin HD (sin clave o sin señal) la imagen es Sentinel-2, de 10 m por píxel: al acercarse mucho
// se explica una vez por sesión por qué se mezcla con el mapa.
const ZOOM_AVISO_HD = 15.5;
let avisoHdMostrado = false;
mapa.on('zoomend', () => {
  if (estado.capa === 'mapa' || avisoHdMostrado || mapa.getZoom() < ZOOM_AVISO_HD) return;
  if (estado.claveEsri && navigator.onLine) return;
  avisoHdMostrado = true;
  if (!estado.claveEsri) {
    avisar('Sin clave de ArcGIS ves Sentinel-2 (10 m por píxel). Agrega la clave para ver casas y senderos en HD con internet.',
      { accion: 'Agregar clave', alAccion: () => hojaCapas(), duracion: 8000 });
  } else {
    avisar('Sin señal: la imagen guardada es de 10 m por píxel, así que de cerca se combina con el mapa.', { duracion: 6000 });
  }
});
window.addEventListener('online', () => { if (estado.capa !== 'mapa') aplicarEstilo(); });

async function activarMapa(m, { encuadrar = false } = {}) {
  estado.mapaActivo = m;
  estado.urlFuente = m ? await mapas.abrirFuente(m) : null;
  await ajustes.escribir('mapaActivo', m ? m.id : null);
  // Relieve y curvas de la misma región que el mapa.
  if (m?.limites) await relieve.cargar([(m.limites[0] + m.limites[2]) / 2, (m.limites[1] + m.limites[3]) / 2]).catch(() => false);
  aplicarEstilo();
  $('#vacio').hidden = !!m;
  if (m && encuadrar) encuadrarMapa(m);
}

function encuadrarMapa(m) {
  fijarModo('libre');
  const [o, s, e, n] = m.limites;
  mapa.fitBounds([[o, s], [e, n]], { padding: 40, duration: 800 });
}

// ---------- Marcador de posición ----------
const puckEl = document.createElement('div');
puckEl.className = 'puck';
// Flecha de navegación cuando se conoce tu dirección; punto azul mientras no se sabe hacia dónde apuntas.
puckEl.innerHTML = `<svg class="puck-flecha" viewBox="0 0 48 48" aria-hidden="true">
  <path d="M24 4 L40 42 L24 33 L8 42 Z" fill="#2f7df6" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/></svg>
  <div class="puck-punto"></div>`;
const puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'map' });
let puckEnMapa = false;

// Dirección hacia donde avanzas, como un GPS de auto:
// - en movimiento, el rumbo del GPS (la brújula falla dentro de un vehículo por el metal);
// - detenido un momento (un semáforo), se mantiene el último rumbo de marcha;
// - quieto por más tiempo, la brújula del iPhone si está activa.
const VELOCIDAD_MARCHA = 1.5; // m/s (~5 km/h)
const MANTENER_RUMBO_MS = 90000;
function rumboActual() {
  const c = gps.ultima?.coords;
  if (c && c.heading != null && !Number.isNaN(c.heading) && c.speed > VELOCIDAD_MARCHA) {
    estado.rumboMarcha = { valor: c.heading, hora: Date.now() };
    return c.heading;
  }
  if (estado.rumboMarcha && Date.now() - estado.rumboMarcha.hora < MANTENER_RUMBO_MS) return estado.rumboMarcha.valor;
  if (brujula.activa && brujula.rumbo != null) return brujula.rumbo;
  return estado.rumboMarcha?.valor ?? null;
}

function actualizarRumbo() {
  const r = rumboActual();
  $('#dato-rumbo').textContent = geo.fmtRumbo(r);
  puckEl.classList.toggle('con-rumbo', r != null);
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

// El punto azul se desliza entre una posición y la siguiente en vez de saltar.
let animPuck = null;
function moverPuck(destino, ms) {
  cancelAnimationFrame(animPuck);
  const origen = puckEnMapa ? puck.getLngLat().toArray() : destino;
  const lejos = geo.distancia(origen[0], origen[1], destino[0], destino[1]) > 500;
  if (!puckEnMapa || lejos || ms <= 0) { puck.setLngLat(destino); return; }
  const t0 = performance.now();
  const paso = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    puck.setLngLat([origen[0] + (destino[0] - origen[0]) * k, origen[1] + (destino[1] - origen[1]) * k]);
    if (k < 1) animPuck = requestAnimationFrame(paso);
  };
  animPuck = requestAnimationFrame(paso);
}

// Vista conducción: tu posición queda en la parte baja del mapa visible, para ver más camino por delante.
function margenConduccion() {
  const alto = mapa.getContainer().clientHeight;
  const navegando = document.body.classList.contains('navegando');
  const panel = navegando ? $('#nav-panel') : $('.panel-datos');
  const topePanel = panel.getBoundingClientRect().top || alto;
  const abajo = Math.max(0, Math.min(alto * 0.4, alto - topePanel + 8));
  const arriba = navegando ? Math.round(alto * 0.42) : Math.round(alto * 0.38);
  return { top: arriba, bottom: Math.round(abajo), left: 0, right: 0 };
}

// Zoom según la velocidad, solo en vehículo (sobre ~15 km/h) y si no hiciste zoom a mano hace poco.
function zoomPorVelocidad(v) {
  if (v == null || v < 4 || Date.now() < (estado.zoomManualHasta || 0)) return null;
  if (v < 9) return 16; // < ~32 km/h
  if (v < 15) return 15.5; // < ~54 km/h
  if (v < 22) return 15; // < ~80 km/h
  if (v < 28) return 14.5; // < ~100 km/h
  return 14;
}

// Zoom al navegar: detalle de calle (escala ~30 m, se ven casas y esquinas).
// En carretera se aleja apenas, para anticipar la siguiente maniobra.
function zoomNavegacion(v) {
  if (nav.perfil() === 'pie' || v == null || v < 9) return 17.5; // < ~32 km/h
  if (v < 15) return 17; // < ~54 km/h
  if (v < 22) return 16.5; // < ~80 km/h
  return 16;
}

let ultimaFix = 0;
gps.addEventListener('posicion', (e) => {
  const p = e.detail;
  const { longitude: lon, latitude: lat, accuracy, altitude, speed } = p.coords;
  const ahora = performance.now();
  revisarCercania(lon, lat);
  revisarLuz(lon, lat);
  registrarPunto(p);
  // Modo bolsillo: pantalla negra; solo se graba el track (y la guía de voz si navegas), sin mover el mapa.
  if (estado.bolsillo) { nav.alPosicion(p); return; }
  // Ahorro de batería: fuera de la navegación, el mapa se actualiza cada 10 s (el track igual guarda cada punto).
  if (estado.ahorro && !nav.navegando() && ultimaFix && ahora - ultimaFix < 10000) return;
  const ms = estado.ahorro ? 0 : ultimaFix ? Math.min(1200, Math.max(300, ahora - ultimaFix)) : 0;
  ultimaFix = ahora;
  revisarNoche(lon, lat);
  moverPuck([lon, lat], ms);
  if (!puckEnMapa) { puck.addTo(mapa); puckEnMapa = true; }
  puckEl.classList.remove('sin-senal');
  mapa.getSource('precision')?.setData(geo.circulo(lon, lat, accuracy));
  if (estado.altitudActual == null) $('#dato-altitud').textContent = geo.fmtAltitud(altitude);
  $('#dato-precision').textContent = `±${Math.round(accuracy)} m`;
  $('#velocimetro').hidden = false;
  $('#velocimetro-valor').textContent = speed == null || speed < 0.5 ? '0' : Math.round(speed * 3.6);
  actualizarRumbo();
  nav.alPosicion(p);
  if (estado.modo !== 'libre' && !estado.repeticion) {
    const r = rumboActual();
    const zv = zoomPorVelocidad(speed);
    let zoom = mapa.getZoom();
    if (estado.primeraPosicion) zoom = Math.max(zoom, 15);
    else if (zv != null && Math.abs(zv - zoom) > 0.25) zoom += Math.sign(zv - zoom) * Math.min(0.5, Math.abs(zv - zoom));
    // Navegando, el mapa se mantiene al nivel de detalle de calle (salvo que tú hagas zoom con los dedos).
    if (nav.navegando() && Date.now() >= (estado.zoomManualHasta || 0)) {
      const objetivo = zoomNavegacion(speed);
      zoom = Math.abs(objetivo - zoom) > 1 ? objetivo : zoom + Math.sign(objetivo - zoom) * Math.min(0.5, Math.abs(objetivo - zoom));
    }
    mapa.easeTo({
      center: [lon, lat],
      zoom,
      bearing: r ?? mapa.getBearing(),
      padding: margenConduccion(),
      duration: estado.ahorro ? 0 : estado.primeraPosicion ? 900 : ms || 600,
      easing: (t) => t,
    });
    estado.primeraPosicion = false;
  }
  if (hojaAbierta === 'lugares') refrescarDistanciasLugares();
});

let ultimoAvisoGps = 0;
// Estado del GPS siempre a la vista: «Buscando…» o «Sin permiso» en el panel, y un aviso con
// el botón «Cómo activarla» si iOS no le da la ubicación a Rumbo.
gps.addEventListener('error', (e) => {
  puckEl.classList.add('sin-senal');
  estado.gps = e.detail.codigo === 1 ? 'denegado' : 'buscando';
  if (!gps.ultima || estado.gps === 'denegado') $('#dato-precision').textContent = estado.gps === 'denegado' ? 'Sin permiso' : 'Buscando…';
  if (estado.gps === 'denegado') {
    avisar('Rumbo no tiene permiso para usar tu ubicación.', { accion: 'Cómo activarla', alAccion: hojaPermisoGps, duracion: 30000 });
  } else if (Date.now() - ultimoAvisoGps > 20000) {
    ultimoAvisoGps = Date.now();
    avisar(e.detail.texto, { duracion: 5000 });
  }
});
gps.addEventListener('posicion', () => { estado.gps = 'ok'; });
$('.panel-datos').addEventListener('click', () => { if (estado.gps !== 'ok') hojaPermisoGps(); });

// Atenúa toda la pantalla (en pantallas OLED, más oscuro = menos consumo).
function aplicarAhorro() {
  document.body.classList.toggle('ahorro', !!estado.ahorro);
}

// ---------- SOS ----------
// Arma un SMS con tu ubicación: usa la señal de celular, no necesita datos ni internet.
$('#btn-sos').addEventListener('click', () => hojaSOS());
async function hojaSOS() {
  const p = gps.ultima;
  const c = p?.coords;
  const numero = await ajustes.leer('sosNumero', '');
  const hace = p ? Math.round((Date.now() - p.timestamp) / 60000) : null;
  // SMS de un solo segmento: sin tildes ni símbolos (°, ±), y menos de 160 caracteres. Un SMS con tildes
  // se parte en varios trozos de 70 caracteres, y con poca señal es más fácil que alguno no llegue.
  const dos = (n) => String(n).padStart(2, '0');
  const t = p ? new Date(p.timestamp) : null;
  const pos = c ? `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}` : '';
  const texto = c
    ? `SOS Rumbo: necesito ayuda. Estoy en ${pos} (+-${Math.round(c.accuracy)}m, ${dos(t.getHours())}:${dos(t.getMinutes())}). ${geo.utmCorto(c.latitude, c.longitude)}. https://maps.google.com/?q=${pos}`
    : 'SOS Rumbo: necesito ayuda. Mi telefono todavia no tiene ubicacion GPS.';
  const enlaceSms = (num) => `sms:${num.replace(/[^\d+]/g, '')}&body=${encodeURIComponent(texto)}`;
  abrirHoja('sos', 'SOS', `
    <div class="grupo">${fila({ icono: 'sos', color: 'rojo',
      titulo: c ? geo.fmtCoordDecimal(c.latitude, c.longitude) : 'Sin ubicación GPS',
      sub: c ? `UTM ${geo.fmtUtm(c.latitude, c.longitude)} · ±${Math.round(c.accuracy)} m · ${hace < 1 ? 'ahora' : `hace ${hace} min`}` : 'Sal al aire libre o revisa el permiso de ubicación' })}</div>
    ${navigator.onLine ? '' : `<p class="aviso-sos"><b>Tu iPhone está sin conexión.</b> Si está en <b>Modo avión</b>, desactívalo: el SMS y las llamadas necesitan la señal de celular (no necesitan internet ni datos).</p>`}
    <div class="grupo-titulo">Contacto de emergencia</div>
    <input class="campo" id="sos-numero" type="tel" inputmode="tel" autocomplete="tel" placeholder="+56 9 1234 5678" value="${esc(numero)}" aria-label="Teléfono del contacto">
    <a class="boton rojo ancho" id="sos-sms" href="${enlaceSms(numero)}"><span data-icono="compartir"></span>Enviar SMS con mi ubicación</a>
    <p class="nota">Mensaje corto (un solo SMS) con tus coordenadas: <i>${esc(texto)}</i></p>
    <div class="grupo-titulo">Llamar</div>
    <div class="fila-botones"><a class="boton" href="tel:133">133 Carabineros</a><a class="boton" href="tel:131">131 Ambulancia</a></div>
    <div class="fila-botones" style="margin-top:10px"><a class="boton" href="tel:132">132 Bomberos</a><a class="boton" href="tel:112">112 Emergencias</a></div>
    <div class="fila-botones" style="margin-top:10px"><button class="boton" data-accion="copiar-coords">Copiar coordenadas</button></div>
    ${bloqueFicha()}
    <div class="grupo-titulo">Antes de salir</div>
    ${estado.salida ? `<div class="grupo">${fila({ icono: 'ruta-r', color: 'verde', titulo: `Aviso activo: ${esc(estado.salida.destino || 'salida')}`,
      sub: `Vuelta a las ${geo.fmtHora(new Date(estado.salida.vuelta))}`, extra: '<button class="boton chico" data-accion="llegue-bien">Llegué bien</button>' })}</div>` : ''}
    <div class="fila-botones"><button class="boton" data-accion="aviso-salida"><span data-icono="compartir"></span>Aviso de salida (adónde voy y cuándo vuelvo)</button></div>
    <div class="grupo-titulo">Si no sale («No entregado»)</div>
    <div class="grupo">
      ${fila({ titulo: 'El SMS usa la señal de celular, no internet', sub: 'Funciona sin datos, pero no en Modo avión ni donde no hay ninguna antena' })}
      ${fila({ titulo: 'Busca una raya de señal', sub: 'Sube a un punto alto y despejado; luego en Mensajes toca el «!» rojo → Intentar de nuevo' })}
      ${fila({ titulo: 'Las llamadas a emergencias usan cualquier compañía', sub: '133, 131, 132 y 112 entran por otra red aunque la tuya no tenga cobertura' })}
      ${fila({ titulo: 'Sin ninguna antena', sub: 'Si tu iPhone ofrece «SOS de emergencia vía satélite» donde estás, aparece al llamar a emergencias. Deja tu ruta a alguien antes de salir.' })}
    </div>`);
  $('#sos-numero').addEventListener('input', (e) => {
    $('#sos-sms').href = enlaceSms(e.target.value);
    ajustes.escribir('sosNumero', e.target.value.trim());
  });
}

function hojaPermisoGps() {
  const enSafari = !(navigator.standalone === true || matchMedia('(display-mode: standalone)').matches);
  abrirHoja('gps', 'Activar la ubicación', `
    <p class="nota">${estado.gps === 'denegado'
    ? 'iOS no le está dando tu ubicación a Rumbo. Sin ella no se puede mostrar dónde estás, grabar tracks ni calcular rutas desde tu posición.'
    : 'Rumbo está buscando la señal GPS. Al aire libre y sin datos móviles la primera ubicación puede tardar un par de minutos.'}</p>
    <div class="grupo-titulo">En el iPhone</div>
    <div class="grupo">
      ${fila({ titulo: '1. Ajustes → Privacidad y seguridad → Localización', sub: 'Debe estar activada' })}
      ${fila({ titulo: '2. Baja hasta «Sitios web de Safari»', sub: 'Elige «Al usar la app» y activa «Ubicación exacta»' })}
      ${fila({ titulo: '3. Vuelve a Rumbo y toca «Reintentar»', sub: 'Si pregunta por la ubicación, toca «Permitir»' })}
    </div>
    ${enSafari ? `<p class="nota">Estás usando Rumbo dentro de Safari: además toca <b>aA</b> (o el ícono a la izquierda de la dirección) → <b>Configuración del sitio web</b> → <b>Ubicación</b> → <b>Permitir</b>. Mejor aún: instala Rumbo con <b>Compartir → Agregar a inicio</b>.</p>` : ''}
    <div class="fila-botones"><button class="boton primario" data-accion="gps-reintentar">Reintentar</button></div>`);
}

// ---------- Seguimiento (siempre activo, como un GPS de auto) ----------
// 'rumbo': el mapa te sigue y gira según tu dirección. 'libre': pausa breve mientras miras otra
// parte del mapa; vuelve sola a seguirte (12 s tras mover el mapa con el dedo, 30 s tras ir a un lugar).
const VOLVER_TRAS_GESTO_MS = 12000;
const VOLVER_TRAS_ACCION_MS = 30000;
let temporizadorVolver = null;
function fijarModo(modo, volverEn = VOLVER_TRAS_ACCION_MS) {
  if (modo === 'seguir') modo = 'rumbo';
  estado.modo = modo;
  clearTimeout(temporizadorVolver);
  const btn = $('#btn-ubicacion');
  btn.classList.toggle('activo', modo !== 'libre');
  $('#icono-ubicacion').innerHTML = icono(modo === 'libre' ? 'ubicacion' : 'rumbo');
  btn.setAttribute('aria-label', modo === 'libre' ? 'Volver a mi posición' : 'Siguiendo tu posición');
  // Al ir a un lugar, track o zona se quita el margen de la vista conducción para centrarlo bien.
  if (modo === 'libre' && volverEn === VOLVER_TRAS_ACCION_MS) mapa.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  if (modo === 'libre' && !herramientaActiva()) {
    temporizadorVolver = setTimeout(() => { fijarModo('rumbo'); centrarEnMiPosicion({ silencioso: true }); }, volverEn);
  }
}

// Lleva el mapa a tu última posición conocida (aunque estés quieto y el GPS no envíe datos nuevos).
function centrarEnMiPosicion({ silencioso = false, zoom = null } = {}) {
  gps.iniciar();
  const p = gps.ultima;
  if (!p) {
    estado.primeraPosicion = true;
    if (!silencioso) avisar('Buscando señal GPS… Al aire libre y en modo avión puede tardar un par de minutos.', { duracion: 6000 });
    return;
  }
  const { longitude: lon, latitude: lat } = p.coords;
  estado.primeraPosicion = false;
  const r = rumboActual();
  mapa.stop();
  if (zoom == null && nav.navegando()) zoom = zoomNavegacion(p.coords.speed);
  mapa.easeTo({ center: [lon, lat], zoom: zoom ?? Math.max(mapa.getZoom(), 15), bearing: r ?? mapa.getBearing(), padding: margenConduccion(), duration: 900 });
  const lim = estado.mapaActivo?.limites;
  if (!silencioso && lim && (lon < lim[0] || lat < lim[1] || lon > lim[2] || lat > lim[3])) {
    avisar(`Estás fuera del mapa «${estado.mapaActivo.nombre}». Tu posición se ve, pero sin calles ni senderos alrededor.`, { duracion: 7000 });
  }
}

// La brújula de iOS solo se puede activar después de un toque: se pide con el primer toque en la app.
document.addEventListener('click', () => { brujula.activar().catch(() => {}); }, { once: true, capture: true });

// Un solo botón, sin opciones: vuelve a tu posición y retoma el seguimiento.
$('#btn-ubicacion').addEventListener('click', () => {
  fijarModo('rumbo');
  centrarEnMiPosicion();
});

// Mover, girar (dos dedos) o hacer zoom pausa el seguimiento un momento; volver a tocar el mapa reinicia la espera.
// Después, el mapa vuelve solo a tu posición y a orientarse según tu dirección.
mapa.on('movestart', (e) => {
  if (!e.originalEvent) return;
  if (e.originalEvent.type?.includes('wheel') || e.originalEvent.touches?.length > 1) estado.zoomManualHasta = Date.now() + 60000;
  fijarModo('libre', VOLVER_TRAS_GESTO_MS);
});
mapa.on('rotate', () => { $('#aguja-norte').style.transform = `rotate(${-mapa.getBearing()}deg)`; });
// Brújula: mientras miras el mapa por tu cuenta, lo deja con el norte arriba.
$('#btn-norte').addEventListener('click', () => {
  if (estado.modo === 'libre') {
    fijarModo('libre', VOLVER_TRAS_GESTO_MS);
    mapa.easeTo({ bearing: 0, duration: 400 });
  } else {
    avisar('El mapa gira según la dirección en que avanzas. Gíralo con dos dedos para mirar; la flecha roja siempre apunta al norte.');
  }
});

// ---------- Lugares (waypoints) ----------
async function cargarLugares() {
  estado.lugares = (await db.todos('lugares')).sort((a, b) => b.creado - a.creado);
  pintarLugares();
}
function pintarLugares() {
  mapa.getSource('lugares')?.setData({
    type: 'FeatureCollection',
    features: estado.lugares.map((l) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
      properties: { id: l.id, nombre: l.nombre, categoria: CATEGORIAS[l.categoria] ? l.categoria : 'general' } })),
  });
}

// Categorías de lugares: color e ícono propios en el mapa y en las listas.
const CATEGORIAS = {
  general: { nombre: 'Lugar', color: '#E5484D', clase: 'rojo', icono: 'pin-r' },
  campamento: { nombre: 'Campamento', color: '#30A46C', clase: 'verde', icono: 'campamento' },
  agua: { nombre: 'Agua', color: '#2F7DF6', clase: 'azul', icono: 'agua' },
  mirador: { nombre: 'Mirador', color: '#5856D6', clase: 'indigo', icono: 'mirador' },
  peligro: { nombre: 'Peligro', color: '#E8A10C', clase: 'amarillo', icono: 'peligro' },
  refugio: { nombre: 'Refugio', color: '#8B6B4A', clase: 'cafe', icono: 'refugio' },
};
const cat = (l) => CATEGORIAS[l?.categoria] || CATEGORIAS.general;

// Íconos de los lugares en el mapa: círculo de color con el glifo blanco (se dibujan una vez).
const imagenesLugares = Object.fromEntries(Object.entries(CATEGORIAS).map(([k, c]) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56"><circle cx="28" cy="28" r="24" fill="${c.color}" stroke="#fff" stroke-width="4"/>
    <g transform="translate(14 14) scale(1.17)" color="#fff" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${trazo(c.icono)}</g></svg>`;
  const img = new Image(56, 56);
  const listo = new Promise((res) => { img.onload = () => res(img); img.onerror = () => res(null); });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return [k, listo];
}));
async function agregarImagenesLugares() {
  for (const [k, p] of Object.entries(imagenesLugares)) {
    const img = await p;
    if (img && !mapa.hasImage(`lugar-${k}`)) mapa.addImage(`lugar-${k}`, img, { pixelRatio: 2 });
  }
}

// Reduce una foto a 1280 px como máximo (JPEG) para guardarla sin ocupar demasiado.
async function reducirFoto(archivo) {
  const bmp = await createImageBitmap(archivo);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(bmp.width * k);
  lienzo.height = Math.round(bmp.height * k);
  lienzo.getContext('2d').drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
  bmp.close?.();
  return new Promise((res) => lienzo.toBlob(res, 'image/jpeg', 0.82));
}
const urlsFotos = new Map();
function urlFoto(l) {
  if (!l.foto) return '';
  if (!urlsFotos.has(l.id)) urlsFotos.set(l.id, URL.createObjectURL(l.foto));
  return urlsFotos.get(l.id);
}

let pulsacion = null;
const cancelarPulsacion = () => { clearTimeout(pulsacion); pulsacion = null; };
mapa.on('touchstart', (e) => {
  cancelarPulsacion();
  if (e.originalEvent.touches.length !== 1) return;
  const { lng, lat } = e.lngLat;
  pulsacion = setTimeout(() => { pulsacion = null; if (nav.estaEligiendo() || herramientaActiva()) return; navigator.vibrate?.(15); hojaNuevoLugar(lng, lat, null); }, 650);
});
['touchend', 'touchmove', 'touchcancel', 'movestart', 'zoomstart'].forEach((ev) => mapa.on(ev, cancelarPulsacion));
mapa.on('contextmenu', (e) => { if (!nav.estaEligiendo() && !herramientaActiva()) hojaNuevoLugar(e.lngLat.lng, e.lngLat.lat, null); });
mapa.on('click', 'lugares-punto', (e) => {
  if (nav.estaEligiendo() || nav.navegando() || herramientaActiva()) return;
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
  const fotos = estado.trackVisto?.fotos || [];
  const notas = estado.trackVisto?.notas || [];
  mapa.getSource('track-fotos')?.setData({ type: 'FeatureCollection', features: [
    ...fotos.map((f, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lon, f.lat] }, properties: { id: `${estado.trackVisto.id}|${i}`, tipo: 'foto' } })),
    ...notas.map((n) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [n.lon, n.lat] }, properties: { id: estado.trackVisto.id, tipo: 'nota' } })),
  ] });
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

// ---------- Dictado sin conexión ----------
// Toca el micrófono, habla y el texto aparece en el buscador (Whisper, dentro del iPhone, sin internet).
// La primera vez se descarga el modelo una sola vez.
let dictando = null;
const TAMANO_DICTADO = '170 MB';
$('#btn-dictar').addEventListener('click', async () => {
  const btn = $('#btn-dictar');
  if (dictando) { dictando.detener = true; return; }
  if (!estado.dictadoListo) return hojaDictado();
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return avisar('Este iPhone no permite grabar audio desde la app. Usa el 🎤 del teclado.');
  const ctx = new (window.AudioContext || window.webkitAudioContext)(); // en el mismo toque (iOS)
  const senal = { detener: false };
  dictando = senal;
  btn.classList.add('escuchando');
  avisar('Te escucho… di la dirección o «llévame a…». Toca el micrófono para terminar.', { duracion: 9000 });
  try {
    const audio = await dictado.grabar({ senal, ctx });
    btn.classList.remove('escuchando');
    if (!audio) return avisar('No escuché nada. Toca el micrófono y habla cerca del iPhone.');
    btn.classList.add('pensando');
    avisar('Escribiendo lo que dijiste…', { duracion: 30000 });
    const texto = await dictado.transcribir(audio);
    $('#aviso').hidden = true;
    if (!texto) return avisar('No te entendí. Prueba de nuevo, más cerca del iPhone.');
    $('#buscar-texto').value = texto;
    $('#buscar').requestSubmit();
  } catch (e) {
    avisar(e.name === 'NotAllowedError' ? 'Rumbo no tiene permiso para el micrófono: Ajustes → Privacidad → Micrófono.'
      : `No se pudo dictar (${e.message}). Puedes usar el 🎤 del teclado.`, { duracion: 9000 });
  } finally {
    dictando = null;
    btn.classList.remove('escuchando', 'pensando');
  }
});
function hojaDictado() {
  abrirHoja('dictado', 'Dictado sin conexión', `
    <p class="nota">Toca el micrófono, habla, y lo que dices se escribe en el buscador. Funciona dentro del iPhone, sin internet ni señal.</p>
    <p class="nota">Necesita una descarga única de unos <b>${TAMANO_DICTADO}</b> (mejor con Wi-Fi). Cada dictado tarda unos segundos en escribirse.</p>
    <div id="progreso-dictado" hidden><div class="barra-progreso"><div></div></div><div class="nota" id="progreso-dictado-texto"></div></div>
    <div class="fila-botones" style="margin-bottom:10px"><button class="boton primario" data-accion="dictado-descargar"><span data-icono="descargar"></span>Descargar dictado (${TAMANO_DICTADO})</button></div>
    <p class="nota">Mientras tanto puedes usar el 🎤 del teclado del iPhone en el buscador.</p>`);
}
async function descargarDictado() {
  if (!navigator.onLine) return avisar('La descarga del dictado necesita internet (una sola vez).');
  const caja = $('#progreso-dictado');
  if (caja) caja.hidden = false;
  pantalla.pedir('dictado');
  try {
    await dictado.preparar((hecho, total) => {
      const barra = $('#progreso-dictado .barra-progreso > div');
      if (barra) barra.style.width = `${Math.round((hecho / total) * 100)}%`;
      const t = $('#progreso-dictado-texto');
      if (t) t.textContent = `${geo.fmtBytes(hecho)} de ${geo.fmtBytes(total)}`;
    });
    estado.dictadoListo = true;
    await ajustes.escribir('dictadoListo', true);
    cerrarHoja();
    avisar('Dictado listo: toca el micrófono del buscador y habla.', { duracion: 6000 });
  } catch (e) {
    avisar(`No se pudo descargar el dictado: ${e.message}`, { duracion: 9000 });
  } finally {
    pantalla.soltar('dictado');
  }
}

// «llévame a X», «ir a X», «quiero ir a X»: arma la ruta al primer resultado. «buscar X» solo busca.
function leerPedido(texto) {
  const ir = texto.match(/^(ll[eéa][vb][aá]me|ir|navegar|vamos|quiero ir)\s+(a|al|hasta|hacia)\s+(.+)$/i);
  const consulta = (ir ? ir[3] : texto.replace(/^(buscar|busca|encuentra)\s+/i, '')).replace(/\s+n[uú]mero\s+/i, ' ').replace(/[.。]$/, '').trim();
  return { consulta, ir: !!ir };
}

// ---------- Búsqueda ----------
let marcaBusqueda = null;
$('#buscar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#buscar-texto');
  const pedido = leerPedido(input.value.trim());
  const texto = pedido.consulta;
  const irDirecto = pedido.ir;
  if (pedido.ir) input.value = texto;
  input.blur();
  if (!texto) return;
  const c = geo.leerCoordenadas(texto);
  if (c) {
    marcaBusqueda?.remove();
    marcaBusqueda = new maplibregl.Marker({ color: '#2f7df6' }).setLngLat([c.lon, c.lat]).addTo(mapa);
    if (estado.modo !== 'libre') fijarModo('libre');
    mapa.flyTo({ center: [c.lon, c.lat], zoom: Math.max(mapa.getZoom(), 14) });
    avisar(geo.fmtCoordDecimal(c.lat, c.lon), { accion: 'Opciones', alAccion: () => hojaNuevoLugar(c.lon, c.lat, null), duracion: 8000 });
    return;
  }
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Tus lugares primero; después calles, pueblos y servicios de la red sin conexión.
  const propios = estado.lugares.filter((x) => norm(x.nombre).includes(norm(texto)))
    .map((x) => ({ nombre: x.nombre, tipo: 'tu lugar', lon: x.lon, lat: x.lat, lugarId: x.id }));
  const yo = gps.ultima?.coords;
  const red = await nav.buscar(texto, yo ? [yo.longitude, yo.latitude] : mapa.getCenter().toArray()).catch(() => []);
  estado.resultados = [...propios, ...red];
  // Dictado «llévame a …»: con resultados, se arma la ruta al primero.
  if (irDirecto) {
    const r = estado.resultados[0];
    if (r) {
      agregarReciente({ nombre: r.nombre, sub: ETIQUETA_TIPO[r.tipo] || '', lon: r.lon, lat: r.lat });
      avisar(`Ruta a ${r.nombre}`, { duracion: 3000 });
      return nav.irA({ lon: r.lon, lat: r.lat, nombre: r.nombre });
    }
  }
  if (!estado.resultados.length) {
    return avisar(`No encontré «${texto}». ${nav.tieneRed() ? 'Prueba con otra palabra.' : 'Para buscar calles y lugares descarga las rutas sin conexión (Mapas).'}`, { duracion: 6000 });
  }
  if (estado.resultados.length === 1) return acciones['ir-resultado']('0');
  hojaResultados(texto);
});

const ETIQUETA_TIPO = { ciudad: 'Ciudad', pueblo: 'Pueblo', localidad: 'Localidad', estancia: 'Estancia', barrio: 'Barrio', isla: 'Isla',
  bencinera: 'Bencinera', salud: 'Salud', farmacia: 'Farmacia', carabineros: 'Carabineros', bomberos: 'Bomberos', refugio: 'Refugio',
  ferry: 'Ferry', restaurante: 'Comida', banco: 'Banco', supermercado: 'Supermercado', camping: 'Camping', alojamiento: 'Alojamiento',
  mirador: 'Mirador', museo: 'Museo', atraccion: 'Atractivo', informacion: 'Información', cumbre: 'Cumbre', glaciar: 'Glaciar',
  lago: 'Lago', bahia: 'Bahía', cabo: 'Cabo', aeropuerto: 'Aeropuerto', parque: 'Parque', rio: 'Río', calle: 'Calle o camino', 'tu lugar': 'Tu lugar', direccion: 'Dirección', mall: 'Centro comercial', educacion: 'Educación',
  iglesia: 'Iglesia', comercio: 'Comercio', servicio: 'Servicio', oficina: 'Oficina', turismo: 'Turismo', recreacion: 'Recreación',
  historico: 'Histórico', transporte: 'Transporte', edificio: 'Edificio', lugar: 'Lugar' };
const ICONO_TIPO = { 'tu lugar': ['pin-r', 'rojo'], bencinera: ['auto', 'naranja'], salud: ['mas', 'rojo'], farmacia: ['mas', 'verde'],
  carabineros: ['sos', 'azul'], refugio: ['refugio', 'cafe'], camping: ['campamento', 'verde'], mirador: ['mirador', 'indigo'],
  cumbre: ['montana', 'cafe'], glaciar: ['montana', 'azul'], lago: ['agua', 'azul'], rio: ['agua', 'azul'], calle: ['ruta-r', 'gris'],
  ciudad: ['mapa-r', 'indigo'], pueblo: ['mapa-r', 'indigo'], aeropuerto: ['ruta-r', 'azul'], ferry: ['ruta-r', 'azul'],
  direccion: ['pin-r', 'azul'], mall: ['pin-r', 'indigo'], comercio: ['pin-r', 'naranja'], educacion: ['pin-r', 'azul'],
  iglesia: ['pin-r', 'cafe'], transporte: ['ruta-r', 'azul'] };
// Texto bajo cada resultado: tipo, si la dirección es aproximada o si el número no está en el mapa.
const detalleResultado = (r) => (r.aprox ? 'Dirección aproximada (entre números vecinos)'
  : r.sinNumero ? `Calle · el n° ${esc(r.sinNumero)} no está en el mapa` : ETIQUETA_TIPO[r.tipo] || r.tipo);
function hojaResultados(texto) {
  const filas = estado.resultados.map((r, i) => {
    const [ic, color] = ICONO_TIPO[r.tipo] || ['pin-r', 'gris'];
    const dist = r.dist != null ? ` · ${geo.fmtDistancia(r.dist)}` : '';
    return fila({ icono: ic, color, titulo: esc(r.nombre), sub: `${detalleResultado(r)}${r.extra ? ` · ${esc(r.extra)} m` : ''}${dist}`,
      accion: 'ir-resultado', id: String(i) });
  }).join('');
  abrirHoja('resultados', `«${esc(texto)}»`, `<div class="grupo">${filas}</div>`);
}

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
  ({ ruta: () => nav.hojaRuta(), tracks: hojaTracks, lugares: hojaLugares, brujula: hojaBrujula, mapas: hojaMapas })[b.dataset.hoja]();
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
  const redes = await mapas.listarRutas();
  const catalogo = navigator.onLine ? await nav.catalogo() : null;
  const zonas = await sat.listarZonas();
  const esp = await mapas.espacio();
  const filasRegiones = (await estadoRegiones(catalogo)).map((r) => {
    const pend = r.items.filter((i) => i.estado !== 'ok');
    const mb = pend.reduce((s, i) => s + i.c.bytes, 0);
    const hay = pend.some((i) => i.estado === 'nueva');
    const boton = estado.descargandoRegion === r.region ? '<span class="nota" style="margin:0">Descargando…</span>'
      : pend.length ? `<button class="boton chico ${hay ? 'primario' : ''}" data-accion="descargar-region" data-id="${esc(r.region)}">${hay && pend.length < r.items.length ? 'Actualizar' : 'Descargar'}</button>`
        : '<span class="marca" data-icono="check"></span>';
    const sub = !pend.length ? 'Instalada y al día'
      : `${pend.length < r.items.length ? (hay ? 'Hay versión nueva' : 'Incompleta') : 'No instalada'} · ${geo.fmtBytes(mb)} · ${pend.map((i) => ({ mapa: 'mapa', rutas: 'rutas', relieve: 'relieve', curvas: 'curvas' })[i.c.tipo]).join(', ')}`;
    return fila({ icono: 'mapa-r', color: 'verde', titulo: esc(r.nombre), sub, extra: boton });
  });
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
    ${relieve.estado.urlRelieve || relieve.estado.urlCurvas || nav.tieneRed() ? `<div class="grupo-titulo">Mostrar en el mapa</div><div class="grupo">${filasCapasTerreno()}</div>` : ''}
    ${filasRegiones.length ? `<div class="grupo-titulo">Regiones disponibles</div><div class="grupo">${filasRegiones.join('')}</div>
      <div id="progreso-region" ${estado.descargandoRegion ? '' : 'hidden'}><div class="barra-progreso"><div></div></div><div class="nota" id="progreso-region-texto">Preparando…</div></div>
      <p class="nota">Cada región trae mapa, rutas con búsqueda, relieve y curvas de nivel. Conviene descargarlas con Wi-Fi y con Rumbo abierta.</p>` : ''}
    <div class="grupo-titulo">Rutas sin conexión</div>
    ${redes.length ? `<div class="grupo">${redes.map((r) => {
    const nueva = catalogo?.find((c) => c.tipo === 'rutas' && c.id === r.region && c.bytes !== r.bytes);
    return fila({ icono: 'ruta', color: 'azul', titulo: esc(r.nombre),
      sub: nueva ? `Hay una versión nueva (${geo.fmtBytes(nueva.bytes)}): búsqueda y límites de velocidad` : `${geo.fmtBytes(r.bytes)} · caminos de OpenStreetMap del ${esc(r.generado || '')}`,
      extra: `${nueva ? `<button class="boton chico primario" data-accion="nav-descargar-red" data-id="${esc(nueva.archivo)}">Actualizar</button>` : ''}${mini('borrar-red', 'basura', 'Borrar rutas sin conexión', r.id, true)}` });
  }).join('')}</div>
    <div id="progreso-red" hidden><div class="barra-progreso"><div></div></div><div class="nota" id="progreso-red-texto"></div></div>`
    : `<p class="nota">Descarga la red de caminos de tu región para calcular rutas y navegar sin internet.</p>
       <div class="fila-botones" style="margin-bottom:6px"><button class="boton" data-accion="abrir-ruta"><span data-icono="ruta"></span>Obtener rutas sin conexión</button></div>`}
    <div class="grupo-titulo">Satélite sin conexión</div>
    ${zonas.length ? `<div class="grupo">${filasZonas}</div>` : '<p class="nota">Descarga imágenes satelitales de las zonas que vas a recorrer para verlas sin señal.</p>'}
    <div class="fila-botones"><button class="boton" data-accion="abrir-descarga-sat"><span data-icono="globo"></span>${estado.descargaSat ? 'Ver descarga en curso' : 'Descargar satélite'}</button></div>
    <div class="grupo-titulo">Descargar con internet</div>
    <input class="campo" id="url-mapa" type="url" inputmode="url" placeholder="https://…/magallanes.pmtiles" autocapitalize="off" autocorrect="off">
    <div class="fila-botones"><button class="boton" data-accion="descargar-mapa"><span data-icono="descargar"></span>Descargar</button></div>
    <p class="nota">${esp ? `Usando ${geo.fmtBytes(esp.usado)} de ${geo.fmtBytes(esp.cuota)} disponibles. ` : ''}${esp?.persistente ? 'Almacenamiento protegido: iOS no borrará tus mapas por falta de espacio.' : 'Los mapas quedan guardados dentro de la app y no requieren conexión.'}</p>
    <div class="grupo-titulo">Respaldo de tus datos</div>
    <p class="nota">Un archivo liviano, sin mapas, con tus lugares, tracks (con fotos y notas de voz), Casa y Trabajo, ficha médica y ajustes. Guárdalo en iCloud Drive: si se borra Rumbo, lo recuperas con «Importar desde Archivos».</p>
    ${estado.respaldo ? `<p class="nota">Respaldo listo: ${geo.fmtBytes(estado.respaldo.archivo.size)} · ${estado.respaldo.resumen.lugares} lugares y ${estado.respaldo.resumen.tracks} tracks.</p>
      <div class="fila-botones" style="margin-bottom:6px"><button class="boton primario" data-accion="guardar-respaldo"><span data-icono="importar"></span>Guardar en Archivos</button>
      <button class="boton" data-accion="enviar-respaldo"><span data-icono="compartir"></span>Compartir</button></div>`
    : '<div class="fila-botones" style="margin-bottom:6px"><button class="boton" data-accion="crear-respaldo"><span data-icono="importar"></span>Crear respaldo (sin mapas)</button></div>'}
    <div class="grupo-titulo">Pasar todo a otro iPhone</div>
    <p class="nota">Crea un solo archivo con todo lo descargado (mapas, rutas, satélite, lugares y tracks) y envíalo por WhatsApp, correo, AirDrop o iCloud Drive. En el otro iPhone se guarda en Archivos y se instala con «Importar desde Archivos», sin descargar nada.</p>
    ${estado.paquete
    ? `<p class="nota">Paquete listo: ${geo.fmtBytes(estado.paquete.archivo.size)} · ${estado.paquete.resumen.mapas} mapa(s), ${estado.paquete.resumen.rutas ? 'rutas, ' : ''}${estado.paquete.resumen.teselas.toLocaleString('es-CL')} imágenes satelitales, ${estado.paquete.resumen.lugares} lugares y ${estado.paquete.resumen.tracks} tracks${estado.paquete.resumen.clave ? ' y Satélite HD listo (incluye tu clave)' : ''}.</p>
       <div class="fila-botones" style="margin-bottom:6px"><button class="boton primario" data-accion="enviar-paquete"><span data-icono="compartir"></span>Enviar paquete (${geo.fmtBytes(estado.paquete.archivo.size)})</button></div>
       <div class="fila-botones" style="margin-bottom:6px"><button class="boton" data-accion="guardar-paquete"><span data-icono="importar"></span>Guardar en Archivos</button></div>
       <p class="nota">WhatsApp acepta archivos de hasta 2 GB. El correo normal admite unos 20 MB; con Mail Drop de iCloud (la app Correo lo ofrece sola) hasta 5 GB.</p>`
    : '<div class="fila-botones" style="margin-bottom:6px"><button class="boton" data-accion="crear-paquete"><span data-icono="importar"></span>Crear paquete para otro iPhone</button></div>'}
    <div class="grupo-titulo">Aplicación</div>
    <div class="grupo">${fila({ icono: 'bateria', color: 'verde', titulo: 'Ahorro de batería', sub: 'Pantalla atenuada, mapa oscuro y menos actualizaciones', accion: 'ahorro', extra: interruptor(estado.ahorro) })}
      ${fila({ icono: 'microfono', color: 'azul', titulo: 'Dictado sin conexión', sub: estado.dictadoListo ? 'Instalado: toca el micrófono del buscador y habla' : `No instalado · descarga única de ${TAMANO_DICTADO}`,
        accion: estado.dictadoListo ? '' : 'dictado-hoja', extra: estado.dictadoListo ? '<button class="boton chico" data-accion="dictado-borrar">Borrar</button>' : '' })}
      ${fila({ icono: 'sol', color: 'amarillo', titulo: 'Mantener la pantalla encendida', sub: 'Mientras Rumbo está abierta. Al navegar y grabar siempre queda encendida.', accion: 'pantalla-siempre', extra: interruptor(estado.pantallaSiempre) })}</div>
    <div class="grupo">${fila({ titulo: `Versión del ${esc(await versionApp())}`, sub: 'Rumbo se actualiza sola al abrirla con internet',
      extra: '<button class="boton chico" data-accion="buscar-actualizacion">Buscar</button>' })}</div>
    <div class="grupo-titulo">Desinstalar</div>
    <p class="nota">Borra de este iPhone todo lo que Rumbo guardó: mapas, rutas, relieve, satélite, lugares, tracks, fotos, notas de voz, ficha médica y ajustes. Antes puedes crear un respaldo (arriba).</p>
    <div class="fila-botones" style="margin-bottom:24px"><button class="boton rojo" data-accion="desinstalar"><span data-icono="basura"></span>Borrar todo y desinstalar</button></div>`);
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
    if (m.tipo === 'rutas') {
      await nav.cargarRed();
      avisar(`${m.nombre}: listas para calcular rutas sin conexión.`);
    } else if (m.tipo === 'relieve' || m.tipo === 'curvas') {
      await relieve.cargar();
      aplicarEstilo();
      avisar(`${m.nombre} instalado. Actívalo o desactívalo en el botón de capas.`);
    } else {
      await activarMapa(m, { encuadrar: true });
      avisar(`Mapa «${nombre}» listo para usar sin conexión.`);
    }
  } catch (e) {
    avisar(e.message, { duracion: 7000 });
  }
  if (hojaAbierta === 'mapas') hojaMapas();
}

// ---------- Regiones del catálogo (descargar y actualizar con internet) ----------
const normalizarNombre = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
async function estadoRegiones(catalogo) {
  const instalados = await mapas.listarTodo();
  const regiones = new Map();
  for (const c of (catalogo || []).filter((x) => x.region)) {
    if (!regiones.has(c.region)) regiones.set(c.region, { region: c.region, nombre: c.regionNombre || c.region, items: [] });
    const tipoRec = (r) => (r.tipo || 'mapa') === c.tipo;
    let rec = instalados.find((r) => tipoRec(r) && r.region === c.region);
    // Mapas importados a mano antes de existir el catálogo: se reconocen por el nombre.
    if (!rec && c.tipo === 'mapa') rec = instalados.find((r) => tipoRec(r) && !r.region && normalizarNombre(r.nombre) === normalizarNombre(c.regionNombre));
    const estadoItem = !rec ? 'falta' : (rec.version ? rec.version !== c.version : rec.bytes !== c.bytes) ? 'nueva' : 'ok';
    regiones.get(c.region).items.push({ c, rec, estado: estadoItem });
  }
  return [...regiones.values()];
}

async function descargarRegion(regionId) {
  if (estado.descargandoRegion) return avisar('Ya hay una descarga en curso.');
  const region = (await estadoRegiones(await nav.catalogo())).find((r) => r.region === regionId);
  if (!region) return avisar('No encontré esa región en el catálogo. Revisa tu conexión.');
  const pendientes = region.items.filter((i) => i.estado !== 'ok');
  if (!pendientes.length) return avisar(`${region.nombre} ya está al día.`);
  estado.descargandoRegion = regionId;
  pantalla.pedir('region');
  await mapas.pedirPersistencia();
  hojaMapas();
  const base = new URL('.', document.baseURI).href;
  try {
    for (const [n, { c, rec }] of pendientes.entries()) {
      const progreso = (hecho, total) => {
        const barra = $('#progreso-region .barra-progreso > div');
        const txt = $('#progreso-region-texto');
        if (barra && total) barra.style.width = `${Math.round((hecho / total) * 100)}%`;
        if (txt) txt.textContent = `${n + 1} de ${pendientes.length} · ${c.nombre}: ${geo.fmtBytes(hecho)} de ${geo.fmtBytes(c.bytes)}`;
      };
      // Las direcciones del catálogo pueden ser relativas (datos/…) o completas (raw.githubusercontent.com).
      const origen = c.partes ? { urls: c.partes.map((p) => new URL(p, base).href), total: c.bytes } : { url: new URL(c.archivo, base).href, total: c.bytes };
      if (rec && c.tipo === 'mapa' && !rec.region) await mapas.borrar(rec); // mapa antiguo sin región: lo reemplaza
      await mapas.instalar(origen, c.tipo === 'mapa' ? region.nombre : c.nombre, progreso, { region: c.region, version: c.version });
    }
    const lista = await mapas.listar();
    const nuevo = lista.find((m) => m.region === regionId);
    if (!estado.mapaActivo || estado.mapaActivo.region === regionId || !lista.some((m) => m.id === estado.mapaActivo.id)) {
      if (nuevo) await activarMapa(nuevo, { encuadrar: !estado.mapaActivo });
    } else {
      await relieve.cargar(mapa.getCenter().toArray()).catch(() => false);
      aplicarEstilo();
    }
    await nav.cargarRed(mapa.getCenter().toArray()).catch(() => false);
    avisar(`${region.nombre} lista para usar sin conexión.`, { duracion: 6000 });
  } catch (e) {
    avisar(`No se pudo completar la descarga: ${e.message}`, { duracion: 8000 });
  } finally {
    estado.descargandoRegion = null;
    pantalla.soltar('region');
    if (hojaAbierta === 'mapas') hojaMapas();
  }
}

// Importa un GPX (de otra app o de alguien que hizo la ruta): sus tracks quedan en el historial
// listos para «Seguir», y sus waypoints como lugares.
async function importarGpx(f) {
  const doc = new DOMParser().parseFromString(await f.text(), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('el GPX está dañado');
  const num = (el, a) => parseFloat(el.getAttribute(a));
  const punto = (el) => {
    const ele = el.querySelector('ele');
    const time = el.querySelector('time');
    return [num(el, 'lon'), num(el, 'lat'), ele ? parseFloat(ele.textContent) : null, time ? Date.parse(time.textContent) || 0 : 0];
  };
  const segmentos = [...doc.querySelectorAll('trkseg')].map((s) => [...s.querySelectorAll('trkpt')].map(punto))
    .concat([...doc.querySelectorAll('rte')].map((r) => [...r.querySelectorAll('rtept')].map(punto)))
    .filter((s) => s.length > 1);
  const puntos = [...doc.querySelectorAll('wpt')].map((w) => {
    const [lon, lat, ele] = punto(w);
    return { lon, lat, ele, nombre: w.querySelector('name')?.textContent.trim() || '', desc: w.querySelector('desc')?.textContent.trim() || '',
      tipo: (w.querySelector('type')?.textContent || '').toLowerCase() };
  });
  const nombre = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent.trim() || '';
  return guardarImportado(f.name, { nombre, segmentos, puntos });
}

// Guarda lo leído de un GPX, KML o KMZ: el recorrido como track y los puntos como lugares.
async function guardarImportado(archivo, { nombre, segmentos, puntos }) {
  const base = archivo.replace(/\.(gpx|kml|kmz)$/i, '');
  segmentos = segmentos.filter((s) => s.length > 1);
  let creados = 0;
  let primero = null;
  if (segmentos.length) {
    let distancia = 0, subida = 0, bajada = 0;
    for (const s of segmentos) {
      for (let i = 1; i < s.length; i++) {
        distancia += geo.distancia(s[i - 1][0], s[i - 1][1], s[i][0], s[i][1]);
        const dz = (s[i][2] ?? s[i - 1][2]) - (s[i - 1][2] ?? s[i][2]);
        if (Number.isFinite(dz)) { if (dz > 0) subida += dz; else bajada -= dz; }
      }
    }
    const tiempos = segmentos.flat().map((p) => p[3]).filter(Boolean);
    const t = { id: nuevoId(), nombre: nombre || base, inicio: tiempos[0] || Date.now(), fin: tiempos.at(-1) || Date.now(), segmentos,
      distancia, subida, bajada, tiempo: tiempos.length > 1 ? tiempos.at(-1) - tiempos[0] : 0, abierto: false, importado: true };
    await db.guardar('tracks', t);
    primero = t;
  }
  for (const w of puntos) {
    await db.guardar('lugares', { id: nuevoId(), nombre: w.nombre || `Punto de ${base}`, lon: w.lon, lat: w.lat, ele: w.ele ?? null,
      creado: Date.now(), categoria: CATEGORIAS[w.tipo] ? w.tipo : 'general', nota: w.desc || '' });
    creados++;
  }
  await cargarLugares();
  if (!primero && !creados) return avisar(`«${archivo}» no tiene recorridos ni puntos.`);
  avisar(`Importado: ${primero ? `track «${primero.nombre}» (${geo.fmtDistancia(primero.distancia)})` : ''}${primero && creados ? ' y ' : ''}${creados ? `${creados} lugares` : ''}.`, { duracion: 6000 });
  if (primero) hojaTrack(primero.id);
}

// Importa un paquete .rumbo creado en otro iPhone (mapas, rutas, satélite, lugares, tracks).
async function importarPaqueteUI(f) {
  await hojaMapas();
  const caja = $('#progreso-mapa');
  if (caja) caja.hidden = false;
  pantalla.pedir('importar');
  try {
    const r = await paquete.importarPaquete(f, (etapa, hecho, total) => {
      const barra = $('#progreso-mapa .barra-progreso > div');
      const txt = $('#progreso-texto');
      if (barra && total) barra.style.width = `${Math.round((hecho / total) * 100)}%`;
      if (txt) txt.textContent = `Instalando ${etapa}${total ? `: ${Math.round((hecho / total) * 100)} %` : '…'}`;
    });
    await mapas.pedirPersistencia();
    estado.capa = await ajustes.leer('capa', estado.capa);
    estado.etiquetas = await ajustes.leer('etiquetas', estado.etiquetas);
    estado.claveEsri = await ajustes.leer('claveEsri', estado.claveEsri);
    const lista = await mapas.listar();
    if (!estado.mapaActivo && lista.length) await activarMapa(lista[0], { encuadrar: true });
    else aplicarEstilo();
    await nav.cargarRed();
    await relieve.cargar().catch(() => false);
    aplicarEstilo();
    await cargarLugares();
    avisar(`Paquete instalado: ${r.mapas} mapa(s), ${r.rutas ? 'rutas, ' : ''}${r.teselas.toLocaleString('es-CL')} imágenes satelitales, ${r.lugares} lugares y ${r.tracks} tracks.`, { duracion: 8000 });
  } catch (e) {
    avisar(`No se pudo instalar el paquete: ${e.message}`, { duracion: 8000 });
  } finally {
    pantalla.soltar('importar');
    if (hojaAbierta === 'mapas') hojaMapas();
  }
}

// Al elegir un archivo siempre se avisa qué pasa: así nunca parece que "no hace nada".
$('#archivo-mapa').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  avisar(`Abriendo «${f.name}» (${geo.fmtBytes(f.size)})…`, { duracion: 15000 });
  try {
    if (await paquete.esPaquete(f)) return await importarPaqueteUI(f);
    const inicio = await f.slice(0, 2000).text();
    if (/<gpx[\s>]/i.test(inicio)) return await importarGpx(f);
    if (/<kml[\s>]/i.test(inicio)) return await guardarImportado(f.name, leerKml(await f.text()));
    if (esZip(new Uint8Array(await f.slice(0, 4).arrayBuffer()))) return await guardarImportado(f.name, leerKml(await kmlDeKmz(await f.arrayBuffer())));
    const cabeza = new TextDecoder().decode(await f.slice(0, 8).arrayBuffer());
    if (!cabeza.startsWith('PMTiles') && cabeza !== 'RUMBORUT') {
      return avisar(`«${f.name}» no es un paquete de Rumbo (.rumbo), un mapa (.pmtiles) ni una ruta (GPX, KML o KMZ).`, { duracion: 10000 });
    }
    const nombre = f.name.replace(/\.(pmtiles|rutas)$/i, '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    await instalarMapa(f, nombre);
  } catch (err) {
    avisar(`No se pudo leer «${f.name}»: ${err.message}. Si llegó por WhatsApp o correo, guárdalo primero en Archivos y vuelve a elegirlo.`, { duracion: 12000 });
  }
});

// En iPhone, si Rumbo se abre dentro de Safari (sin instalar), se explica cómo instalarla:
// lo importado en Safari no lo ve la app instalada (iOS guarda los datos por separado).
const esIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalada = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
$('#vacio-instalar').hidden = !(esIOS && !instalada);
$('#vacio-importar').hidden = esIOS && !instalada;

// Capas
const marca = (si) => (si ? '<span class="marca" data-icono="check"></span>' : '');
// Interruptor estilo iOS para las opciones que se activan o desactivan (la fila completa lo cambia).
const interruptor = (si) => `<span class="interruptor${si ? ' on' : ''}" role="switch" aria-checked="${si ? 'true' : 'false'}"></span>`;
async function hojaCapas() {
  const zonas = await sat.listarZonas();
  const tipo = (valor, icono, color, titulo, sub) => fila({ icono, color, titulo, sub, accion: 'capa', id: valor, extra: marca((estado.capa === 'mapa' ? 'mapa' : 'satelite') === valor) });
  const tema = (valor, titulo, sub) => fila({ titulo, sub, accion: 'tema', id: valor, extra: marca(estado.temaPreferido === valor) });
  const satelital = estado.capa !== 'mapa';
  let extra = '';
  if (satelital) {
    extra += `<div class="grupo">${fila({ titulo: 'Caminos, senderos y nombres', sub: 'Dibujados sobre la imagen satelital', accion: 'etiquetas', extra: interruptor(estado.etiquetas) })}</div>`;
  }
  if (satelital) {
    extra += estado.claveEsri
      ? `<div class="grupo">${fila({ titulo: 'Clave de ArcGIS guardada', sub: 'Alta definición con internet; sin señal, Sentinel-2.', extra: `<button class="boton chico" data-accion="borrar-clave">Cambiar</button>` })}</div>`
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
      ${tipo('satelite', 'globo', 'azul', 'Satélite', estado.claveEsri ? 'HD (menos de 1 m) con internet · Sentinel-2 (10 m) sin señal' : 'Sentinel-2 · 10 m por píxel · sin conexión')}
    </div>
    <div class="grupo">${fila({ icono: 'auto', color: 'indigo', titulo: 'Modo HUD para el parabrisas', sub: 'Flecha, distancia y velocidad reflejadas en el vidrio, de noche', accion: 'hud' })}</div>
    ${relieve.estado.urlRelieve || relieve.estado.urlCurvas
    ? `<div class="grupo">${filasCapasTerreno()}${relieve.estado.urlRelieve ? fila({ icono: 'montana', color: 'azul', titulo: 'Vista 3D del terreno', sub: 'Inclina el mapa con dos dedos', accion: 'vista-3d', extra: interruptor(estado.vista3d) }) : ''}</div>`
    : '<p class="nota">Para ver relieve y curvas de nivel, instálalos desde Mapas (vienen en el paquete de la región).</p>'}
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
    ${region ? '' : `<div class="grupo" style="padding:12px 14px;margin-bottom:14px;border-color:var(--azul)">
      <p class="nota" style="margin:0 0 10px"><b>¿Te enviaron un paquete de Rumbo (.rumbo)?</b> Ya trae el mapa, el satélite y las rutas: impórtalo en vez de descargar todo por internet.</p>
      <div class="fila-botones"><button class="boton primario" data-accion="importar"><span data-icono="importar"></span>Importar paquete</button></div></div>`}
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
    if (zona.yaExistia) avisar('Esa zona ya estaba descargada: no se descargó nada nuevo.', { duracion: 5000 });
    else if (control.signal.aborted) avisar(`Descarga cancelada. Se guardó lo descargado (${geo.fmtBytes(zona.bytes)}).`, { duracion: 6000 });
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
    <div class="fila-botones" style="margin-bottom:14px"><button class="boton verde" data-accion="cerros"><span data-icono="montana"></span>¿Qué cerro es ese? (cámara)</button></div>
    <div class="estadisticas">
      <div class="estadistica"><div class="etiqueta">Altitud</div><div class="valor" id="b-alt">—</div></div>
      <div class="estadistica"><div class="etiqueta">Velocidad</div><div class="valor" id="b-vel">—</div></div>
      <div class="estadistica"><div class="etiqueta">Precisión</div><div class="valor" id="b-prec">—</div></div>
    </div>
    <div class="grupo">
      ${fila({ titulo: '<span id="b-dec">—</span>', sub: 'Coordenadas (grados decimales)' })}
      ${fila({ titulo: '<span id="b-gms">—</span>', sub: 'Grados, minutos y segundos' })}
      ${fila({ titulo: '<span id="b-utm">—</span>', sub: 'UTM (WGS84) · el formato de Carabineros y rescatistas' })}
      ${filaLuz('b-luz')}
    </div>
    <p class="nota">La altitud combina el GPS con el relieve guardado (si está instalado), que es más preciso que el GPS solo. Mantén el iPhone lejos de imanes y metales para que la brújula sea precisa.</p>`);
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
    $('#b-alt').textContent = geo.fmtAltitud(estado.altitudActual ?? c.altitude);
    $('#b-vel').textContent = geo.fmtVelocidad(c.speed ?? 0);
    $('#b-prec').textContent = `±${Math.round(c.accuracy)} m`;
    $('#b-dec').textContent = geo.fmtCoordDecimal(c.latitude, c.longitude);
    $('#b-gms').textContent = geo.fmtCoordGMS(c.latitude, c.longitude);
    $('#b-utm').textContent = geo.fmtUtm(c.latitude, c.longitude);
    $('#b-luz').textContent = textoLuzActual() || '—';
    actualizarChipLuz();
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
    icono: cat(l).icono, color: cat(l).clase, titulo: esc(l.nombre), sub: `<span data-dist="${l.id}">${subLugar(l)}</span>${l.foto ? ' · 📷' : ''}`, accion: 'abrir-lugar', id: l.id,
    extra: mini('ir-lugar', 'ver', 'Ver en el mapa', l.id),
  })).join('');
  abrirHoja('lugares', 'Lugares', `
    <div class="fila-botones" style="margin-bottom:14px">
      <button class="boton rojo" data-accion="guardar-aqui"><span data-icono="pin"></span>Guardar mi ubicación</button>
    </div>
    ${lista.length ? `<div class="grupo">${filas}</div>
      <div class="fila-botones"><button class="boton" data-accion="exportar-lugares"><span data-icono="compartir"></span>Exportar GPX</button></div>`
    : '<p class="nota">Mantén el dedo sobre el mapa para guardar cualquier punto, o guarda tu ubicación actual.</p>'}
    <div class="grupo" style="margin-top:14px">
      ${fila({ icono: 'voz', color: 'azul', titulo: 'Avisarme al acercarme', sub: 'Voz y aviso a 150 m de refugios, agua, miradores y campamentos; a 300 m de un peligro', accion: 'alertas-cercania', extra: interruptor(estado.alertasCercania) })}
      ${fila({ icono: 'ruta-r', color: 'naranja', titulo: 'Medir distancia o área', sub: 'Toca puntos en el mapa', accion: 'medir' })}
      ${fila({ icono: 'auto', color: 'azul', titulo: '¿Dónde estacioné?', sub: estado.auto ? 'Te llevo de vuelta a tu auto' : 'Guarda dónde dejas el auto', accion: 'auto-hoja' })}
    </div>
    <div id="lista-pronosticos"></div>`);
  pintarListaPronosticos();
}
function refrescarDistanciasLugares() {
  document.querySelectorAll('[data-dist]').forEach((el) => {
    const l = estado.lugares.find((x) => x.id === el.dataset.dist);
    if (l) el.textContent = subLugar(l);
  });
}
// Punto elegido en el mapa (dedo mantenido o búsqueda): ir, salir desde ahí o guardarlo.
function hojaNuevoLugar(lon, lat, ele, nombre = null) {
  estado.nuevoLugar = { lon, lat, ele, categoria: 'general', nombre: nombre || `Lugar ${estado.lugares.length + 1}`, titulo: nombre, nota: '', foto: null };
  pintarNuevoLugar();
  // Altitud del punto tocado, desde el relieve guardado en el iPhone.
  if (ele == null && relieve.disponible()) {
    const n = estado.nuevoLugar;
    relieve.altitud(lon, lat).then((h) => {
      if (h == null || estado.nuevoLugar !== n) return;
      n.ele = Math.round(h);
      const el = document.getElementById('alt-punto');
      if (el) el.textContent = `${geo.fmtCoordDecimal(lat, lon)} · altitud ${geo.fmtAltitud(n.ele)}`;
    });
  }
}
function pintarNuevoLugar() {
  const n = estado.nuevoLugar;
  const chips = Object.entries(CATEGORIAS).map(([k, c]) => `<button class="cat ${n.categoria === k ? 'sel' : ''}" data-accion="cat-lugar" data-id="${k}">
    <span class="icono-app ${c.clase}" data-icono="${c.icono}"></span><span>${c.nombre}</span></button>`).join('');
  abrirHoja('nuevo-lugar', n.titulo ? esc(n.titulo) : 'Punto elegido', `
    <p class="nota" id="alt-punto">${geo.fmtCoordDecimal(n.lat, n.lon)}${n.ele != null ? ` · altitud ${geo.fmtAltitud(n.ele)}` : ''}</p>
    <p class="nota" style="margin-top:-10px">UTM ${geo.fmtUtm(n.lat, n.lon)}</p>
    <div class="fila-botones" style="margin-bottom:16px">
      <button class="boton primario" data-accion="ir-aqui"><span data-icono="ruta"></span>Ir aquí</button>
      <button class="boton" data-accion="salir-desde-aqui"><span data-icono="seguir"></span>Salir desde aquí</button>
      <button class="boton" data-accion="medir-desde-aqui"><span data-icono="ruta-r"></span>Medir</button>
      <button class="boton" data-accion="pronostico-aqui"><span data-icono="sol"></span>Pronóstico</button>
      <button class="boton" data-accion="recta-aqui"><span data-icono="rumbo"></span>Línea recta</button>
    </div>
    <div class="fila-botones" style="margin-bottom:14px">
      <button class="boton chico" data-accion="fav-guardar" data-id="casa">🏠 Guardar como Casa</button>
      <button class="boton chico" data-accion="fav-guardar" data-id="trabajo">💼 Guardar como Trabajo</button>
    </div>
    <div class="grupo-titulo">Guardar como lugar</div>
    <div class="categorias">${chips}</div>
    <input class="campo" id="nombre-lugar" maxlength="60" value="${esc(n.nombre)}" aria-label="Nombre del lugar">
    <textarea class="campo campo-nota" id="nota-lugar" maxlength="500" placeholder="Nota (opcional): agua potable, buen reparo del viento…" aria-label="Nota">${esc(n.nota)}</textarea>
    ${n.foto ? `<img class="foto-lugar" src="${URL.createObjectURL(n.foto)}" alt="Foto del lugar">` : ''}
    <div class="fila-botones" style="margin-bottom:10px"><button class="boton" data-accion="foto-lugar"><span data-icono="foto"></span>${n.foto ? 'Cambiar foto' : 'Agregar foto'}</button></div>
    <div class="fila-botones"><button class="boton rojo" data-accion="confirmar-lugar"><span data-icono="pin"></span>Guardar lugar</button></div>`);
}
// Guarda lo escrito antes de volver a dibujar la hoja (al cambiar categoría o foto).
function leerNuevoLugar() {
  const n = estado.nuevoLugar;
  if (!n) return;
  n.nombre = $('#nombre-lugar')?.value ?? n.nombre;
  n.nota = $('#nota-lugar')?.value ?? n.nota;
}
$('#archivo-foto').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const foto = await reducirFoto(f);
    if (estado.editandoFoto) {
      const l = await db.obtener('lugares', estado.editandoFoto);
      if (l) { l.foto = foto; await db.guardar('lugares', l); urlsFotos.delete(l.id); await cargarLugares(); hojaLugar(l); }
      estado.editandoFoto = null;
    } else if (estado.nuevoLugar) {
      leerNuevoLugar();
      estado.nuevoLugar.foto = foto;
      pintarNuevoLugar();
    }
  } catch (err) {
    avisar(`No se pudo usar esa foto: ${err.message}`);
  }
});
function hojaLugar(l) {
  const c = cat(l);
  abrirHoja('lugar', esc(l.nombre), `
    ${l.foto ? `<img class="foto-lugar" src="${urlFoto(l)}" alt="Foto de ${esc(l.nombre)}">` : ''}
    <div class="fila" style="padding:0 2px 10px;border:0"><span class="icono-app ${c.clase}" data-icono="${c.icono}"></span><div class="fila-texto"><div class="fila-titulo">${c.nombre}</div></div></div>
    <textarea class="campo campo-nota" id="nota-editar" data-id="${l.id}" maxlength="500" placeholder="Agrega una nota…" aria-label="Nota">${esc(l.nota || '')}</textarea>
    <div class="fila-botones" style="margin-bottom:12px"><button class="boton" data-accion="foto-editar" data-id="${l.id}"><span data-icono="foto"></span>${l.foto ? 'Cambiar foto' : 'Agregar foto'}</button></div>
    <div class="grupo">
      ${fila({ titulo: geo.fmtCoordDecimal(l.lat, l.lon), sub: geo.fmtCoordGMS(l.lat, l.lon) })}
      ${fila({ titulo: geo.fmtUtm(l.lat, l.lon), sub: 'UTM (WGS84)' })}
      ${fila({ titulo: `<span data-dist="${l.id}">${subLugar(l)}</span>`, sub: 'Distancia y rumbo desde tu posición' })}
      ${l.ele != null ? fila({ titulo: geo.fmtAltitud(l.ele), sub: 'Altitud' }) : ''}
      ${fila({ titulo: new Date(l.creado).toLocaleString('es-CL', { dateStyle: 'long', timeStyle: 'short' }), sub: 'Guardado' })}
    </div>
    <div class="fila-botones" style="margin-bottom:10px">
      <button class="boton primario" data-accion="como-llegar" data-id="${l.id}"><span data-icono="ruta"></span>Cómo llegar</button>
      <button class="boton" data-accion="ir-lugar" data-id="${l.id}"><span data-icono="ver"></span>Ver en mapa</button>
      <button class="boton" data-accion="pronostico-lugar" data-id="${l.id}"><span data-icono="sol"></span>Pronóstico</button>
      <button class="boton" data-accion="recta-lugar" data-id="${l.id}"><span data-icono="rumbo"></span>Línea recta</button>
    </div>
    <div class="fila-botones">
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
    grabando: `${estadisticasGrabacion()}<div class="fila-botones"><button class="boton" data-accion="pausar"><span data-icono="pausa"></span>Pausar</button><button class="boton rojo" data-accion="terminar"><span data-icono="detener"></span>Terminar</button></div>
      <div class="fila-botones" style="margin-top:10px"><button class="boton primario" data-accion="bolsillo"><span data-icono="bateria"></span>Modo bolsillo</button>
      <button class="boton" data-accion="foto-track"><span data-icono="foto"></span>Foto aquí</button>
      <button class="boton" data-accion="nota-voz"><span data-icono="microfono"></span>Nota de voz</button></div>
      <div class="fila-botones" style="margin-top:10px"><button class="boton verde" data-accion="volver-inicio"><span data-icono="rumbo"></span>Volver al inicio por el mismo camino</button></div>`,
    pausado: `${estadisticasGrabacion()}<div class="fila-botones"><button class="boton naranja" data-accion="reanudar"><span data-icono="reanudar"></span>Reanudar</button><button class="boton rojo" data-accion="terminar"><span data-icono="detener"></span>Terminar</button></div>`,
  }[grabador.estado];
  const filas = guardados.map((t) => fila({
    icono: 'track', color: 'naranja', titulo: esc(t.nombre), accion: 'abrir-track', id: t.id,
    sub: `${t.planificada ? 'Planificada · ' : ''}${geo.fmtDistancia(t.distancia)} · ${geo.fmtDuracion(duracion(t))} · +${geo.fmtAltitud(t.subida)}${t.fotos?.length ? ` · 📷 ${t.fotos.length}` : ''}${t.notas?.length ? ` · 🎙 ${t.notas.length}` : ''}`,
  })).join('');
  abrirHoja('tracks', 'Tracks', `${control}
    <div class="grupo">${filaLuz()}</div>
    <p class="nota">iOS detiene el GPS de Rumbo si bloqueas la pantalla. Para llevar el iPhone en el bolsillo usa el <b>Modo bolsillo</b>: la pantalla queda negra (gasta muy poco) y el GPS sigue grabando. No uses el botón lateral.</p>
    <div class="grupo">${fila({ icono: 'bateria', color: 'verde', titulo: 'Ahorro de batería', sub: 'Pantalla atenuada, mapa oscuro y menos actualizaciones', accion: 'ahorro', extra: interruptor(estado.ahorro) })}
      ${fila({ icono: 'caminar', color: 'verde', titulo: 'Dibujar ruta de trekking', sub: 'Distancia, desnivel y tiempo a pie', accion: 'dibujar' })}
      ${fila({ icono: 'track-r', color: 'indigo', titulo: 'Estadísticas y récords', sub: 'Kilómetros y desnivel por mes y año', accion: 'estadisticas' })}</div>
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
    ${t.cortes?.length ? `<p class="nota aviso-luz">⚠︎ El GPS estuvo detenido ${geo.fmtFalta(tiempoCortado(t))} en ${t.cortes.length} ${t.cortes.length === 1 ? 'momento' : 'momentos'} (pantalla bloqueada o Rumbo en segundo plano): esos tramos faltan.</p>` : ''}
    ${svgPerfil(t)}
    ${t.fotos?.length ? `<div class="fotos-track">${t.fotos.map((f, i) => `<img src="${urlFotoTrack(t, f)}" alt="Foto ${i + 1}" data-accion="ver-foto-track" data-id="${t.id}|${i}">`).join('')}</div>` : ''}
    ${t.notas?.length ? `<div class="grupo-titulo">Notas de voz</div><div class="grupo notas-voz">${t.notas.map((n, i) => `<div class="fila"><div class="fila-texto">
      <div class="fila-titulo">Nota ${i + 1} · ${new Date(n.t).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · ${n.dur} s</div>
      <audio controls preload="none" src="${urlNota(t, n)}"></audio></div></div>`).join('')}</div>` : ''}
    <div class="fila-botones" style="margin-bottom:10px">
      <button class="boton primario" data-accion="tarjeta-track" data-id="${t.id}"><span data-icono="compartir"></span>Tarjeta para compartir</button>
    </div>
    <div class="fila-botones" style="margin-bottom:10px">
      <button class="boton" data-accion="repetir-track" data-id="${t.id}"><span data-icono="rumbo"></span>Repetir en 3D</button>
      <button class="boton" data-accion="volver-track" data-id="${t.id}"><span data-icono="rumbo"></span>Volver por él</button>
    </div>
    <div class="fila-botones">
      <button class="boton primario" data-accion="seguir-track" data-id="${t.id}"><span data-icono="rumbo"></span>Seguir</button>
      <button class="boton" data-accion="ver-track" data-id="${t.id}"><span data-icono="ver"></span>Ver en mapa</button>
      <button class="boton" data-accion="exportar-track" data-id="${t.id}"><span data-icono="compartir"></span>GPX</button>
      <button class="boton peligro" data-accion="borrar-track" data-id="${t.id}"><span data-icono="basura"></span>Borrar</button>
    </div>`);
}
// Nota de un lugar ya guardado: se guarda al salir del campo.
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'nota-editar') return;
  const l = await db.obtener('lugares', e.target.dataset.id);
  if (!l) return;
  l.nota = e.target.value.trim();
  await db.guardar('lugares', l);
  await cargarLugares();
});

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
    if (valor !== 'mapa' && estado.claveEsri && !navigator.onLine) avisar('Sin internet: se muestra la imagen guardada (Sentinel-2) hasta que vuelva la señal.');
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
    leerNuevoLugar();
    const nombre = n.nombre.trim() || `Lugar ${estado.lugares.length + 1}`;
    await db.guardar('lugares', { id: nuevoId(), nombre, lon: n.lon, lat: n.lat, ele: n.ele, creado: Date.now(),
      categoria: n.categoria, nota: n.nota.trim(), foto: n.foto || null });
    estado.nuevoLugar = null;
    await cargarLugares();
    cerrarHoja();
    avisar(`«${nombre}» guardado.`);
  },
  'abrir-ruta': () => nav.hojaRuta(),
  'descargar-region': (id) => descargarRegion(id),
  relieve: async () => {
    estado.mostrarRelieve = !estado.mostrarRelieve;
    await ajustes.escribir('mostrarRelieve', estado.mostrarRelieve);
    aplicarEstilo();
    if (hojaAbierta === 'mapas') hojaMapas(); else hojaCapas();
  },
  curvas: async () => {
    estado.mostrarCurvas = !estado.mostrarCurvas;
    await ajustes.escribir('mostrarCurvas', estado.mostrarCurvas);
    aplicarEstilo();
    if (hojaAbierta === 'mapas') hojaMapas(); else hojaCapas();
  },
  'ir-resultado': (i) => {
    const r = estado.resultados?.[Number(i)];
    if (!r) return;
    agregarReciente({ nombre: r.nombre, sub: ETIQUETA_TIPO[r.tipo] || '', lon: r.lon, lat: r.lat });
    fijarModo('libre');
    mapa.flyTo({ center: [r.lon, r.lat], zoom: Math.max(mapa.getZoom(), r.tipo === 'ciudad' ? 13 : r.tipo === 'direccion' ? 17 : 15.5) });
    if (r.aprox) avisar(`${r.nombre}: ubicación aproximada, calculada con los números vecinos de la calle.`, { duracion: 5000 });
    else if (r.sinNumero) avisar(`El número ${r.sinNumero} no está en el mapa: te muestro la calle.`, { duracion: 5000 });
    marcaBusqueda?.remove();
    marcaBusqueda = new maplibregl.Marker({ color: '#2f7df6' }).setLngLat([r.lon, r.lat]).addTo(mapa);
    if (r.lugarId) { const l = estado.lugares.find((x) => x.id === r.lugarId); if (l) return hojaLugar(l); }
    hojaNuevoLugar(r.lon, r.lat, null, r.nombre);
  },
  ahorro: async () => {
    estado.ahorro = !estado.ahorro;
    await ajustes.escribir('ahorro', estado.ahorro);
    aplicarAhorro();
    aplicarEstilo();
    if (hojaAbierta === 'tracks') hojaTracks(); else if (hojaAbierta === 'mapas') hojaMapas();
    avisar(estado.ahorro ? 'Ahorro de batería activado: pantalla atenuada y mapa oscuro.' : 'Ahorro de batería desactivado.');
  },
  'cat-lugar': (id) => { leerNuevoLugar(); estado.nuevoLugar.categoria = id; pintarNuevoLugar(); },
  'foto-lugar': () => { estado.editandoFoto = null; leerNuevoLugar(); $('#archivo-foto').click(); },
  'foto-editar': (id) => { estado.editandoFoto = id; $('#archivo-foto').click(); },
  'copiar-coords': async () => {
    const c = gps.ultima?.coords;
    if (!c) return avisar('Todavía no hay ubicación GPS.');
    const t = `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;
    try { await navigator.clipboard.writeText(t); avisar(`Copiado: ${t}`); } catch (_) { avisar(t, { duracion: 10000 }); }
  },
  'crear-paquete': async () => {
    pantalla.pedir('paquete');
    try {
      // La clave de ArcGIS va siempre incluida: el otro iPhone ve Satélite HD sin configurar nada.
      estado.paquete = await paquete.crearPaquete({
        incluirClave: true,
        alProgreso: (etapa, hecho, total) => avisar(`Preparando el paquete: ${etapa}${total ? ` ${Math.round((hecho / total) * 100)} %` : '…'}`, { duracion: 120000 }),
      });
      $('#aviso').hidden = true;
    } finally {
      pantalla.soltar('paquete');
    }
    hojaMapas();
  },
  // Compartir debe llamarse directo desde el toque (exigencia de iOS), por eso es un segundo botón.
  // Se comparte solo el archivo (sin texto): con texto, apps como WhatsApp envían el texto y omiten el archivo.
  'enviar-paquete': async () => {
    const f = estado.paquete?.archivo;
    if (!f) return;
    if (!navigator.share) return avisar('Este iPhone no permite compartir archivos desde la app. Actualiza iOS.');
    avisar('Abriendo el menú Compartir…', { duracion: 15000 });
    try {
      await navigator.share({ files: [f], title: f.name });
      $('#aviso').hidden = true;
    } catch (e) {
      if (e.name === 'AbortError') { $('#aviso').hidden = true; return; }
      avisar(`No se pudo abrir Compartir (${e.name}). Prueba «Guardar en Archivos» y envíalo desde la app Archivos.`, { duracion: 12000 });
    }
  },
  'guardar-paquete': () => {
    const f = estado.paquete?.archivo;
    if (!f) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  },
  'buscar-actualizacion': async () => {
    if (!navigator.onLine) return avisar('Necesitas internet para buscar una versión nueva.');
    const r = await navigator.serviceWorker?.getRegistration();
    if (!r) return avisar('No se pudo revisar: abre Rumbo desde el ícono de inicio.');
    avisar('Buscando versión nueva…');
    await r.update().catch(() => {});
    if (r.installing || r.waiting) avisar('Descargando la versión nueva… se aplicará en unos segundos.', { duracion: 8000 });
    else avisar(`Ya tienes la última versión (${await versionApp()}).`);
  },
  'ir-aqui': () => { const n = estado.nuevoLugar; if (n) nav.irA({ lon: n.lon, lat: n.lat, ...(n.titulo ? { nombre: n.titulo } : {}) }); },
  'seguir-track': async (id) => {
    const t = await db.obtener('tracks', id);
    if (!t) return;
    nav.seguirTrack(t.segmentos.flat().map((p) => [p[0], p[1]]), t.nombre);
  },
  'salir-desde-aqui': () => { const n = estado.nuevoLugar; if (n) nav.salirDesde({ lon: n.lon, lat: n.lat, nombre: 'Punto elegido' }); },
  'como-llegar': (id) => { const l = estado.lugares.find((x) => x.id === id); if (l) nav.irA({ lon: l.lon, lat: l.lat, nombre: l.nombre }); },
  'borrar-red': async (id) => {
    const r = (await mapas.listarRutas()).find((x) => x.id === id);
    if (!r || !confirm(`¿Borrar ${r.nombre} de este iPhone? Sin ellas no se pueden calcular rutas sin conexión.`)) return;
    await mapas.borrar(r);
    await nav.cargarRed();
    hojaMapas();
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
    // Sin permiso de ubicación un track no puede registrar nada: primero se explica cómo activarla.
    if (estado.gps === 'denegado') { gps.reiniciar(); return hojaPermisoGps(); }
    cerrarHoja(); // primero: deja ver el mapa; el estado sigue en la píldora de arriba
    grabador.iniciar();
    if (estado.modo === 'libre') fijarModo('seguir');
    if (!gps.ultima) avisar('Buscando señal GPS: el track empezará a registrar puntos apenas la encuentre.', { accion: 'Ayuda', alAccion: hojaPermisoGps, duracion: 10000 });
    else centrarEnMiPosicion();
  },
  'gps-ayuda': () => hojaPermisoGps(),
  'gps-reintentar': () => {
    gps.reiniciar();
    cerrarHoja();
    avisar('Buscando señal GPS…', { duracion: 6000 });
  },
  pausar: () => grabador.pausar(),
  reanudar: () => grabador.reanudar(),
  terminar: async () => {
    if (!confirm('¿Terminar y guardar el track?')) return;
    const t = await grabador.terminar();
    if (t) avisar(`Track guardado: ${geo.fmtDistancia(t.distancia)} en ${geo.fmtDuracion(duracion(t))}.`);
  },
  'abrir-track': (id) => hojaTrack(id),
  'ver-track': async (id) => {
    const t = await db.obtener('tracks', id);
    if (!t) return;
    estado.trackVisto = t;
    pintarTrackVisto();
    const pts = t.segmentos.flat().map((p) => [p[0], p[1]]);
    if (!pts.length) return avisar('Este track no alcanzó a registrar posiciones GPS.');
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
  const nombre = el.dataset.accion;
  const fn = nombre.startsWith('nav-') ? (id) => nav.accion(nombre, id) : acciones[nombre];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el.dataset.id)).catch((err) => avisar(err.message || String(err), { duracion: 6000 }));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'nombre-lugar') acciones['confirmar-lugar']();
});

async function versionApp() {
  try { return (await (await fetch('./version.json')).json()).fecha; } catch (_) { return 'desconocida'; }
}


// ---------- Modo bolsillo (grabar con la pantalla negra) ----------
// iOS detiene el GPS de las apps web cuando se bloquea la pantalla. En vez de bloquearla, la pantalla
// queda negra (en pantallas OLED casi no gasta) y Rumbo sigue recibiendo posiciones.
let relojBolsillo = null;
let toqueBolsillo = null;
function entrarBolsillo() {
  if (grabador.estado !== 'grabando') return avisar('El modo bolsillo es para grabar: empieza un track primero (Tracks → Grabar track).', { duracion: 5000 });
  estado.bolsillo = true;
  actualizarChipLuz();
  cerrarHoja();
  $('#bolsillo').hidden = false;
  pantalla.pedir('bolsillo');
  actualizarBolsillo();
  clearInterval(relojBolsillo);
  relojBolsillo = setInterval(actualizarBolsillo, 5000);
}
function salirBolsillo() {
  estado.bolsillo = false;
  actualizarChipLuz();
  $('#bolsillo').hidden = true;
  pantalla.soltar('bolsillo');
  clearInterval(relojBolsillo);
  pintarTrackActual();
  actualizarPildora();
  centrarEnMiPosicion({ silencioso: true });
}
function actualizarBolsillo() {
  if (!estado.bolsillo) return;
  if (grabador.estado === 'detenido') return salirBolsillo();
  const t = grabador.track;
  $('#bolsillo-tiempo').textContent = geo.fmtDuracion(grabador.tiempo());
  $('#bolsillo-dist').textContent = `${geo.fmtDistancia(t?.distancia ?? 0)} · +${geo.fmtAltitud(t?.subida ?? 0)}`;
  const p = gps.ultima;
  const edad = p ? Date.now() - p.timestamp : null;
  $('#bolsillo-gps').textContent = !p ? 'Buscando GPS…' : edad < 20000 ? 'GPS grabando' : `Último punto hace ${geo.fmtFalta(edad)}`;
  $('#bolsillo-luz').textContent = textoLuzActual();
}
$('#bolsillo').addEventListener('pointerdown', () => {
  clearTimeout(toqueBolsillo);
  $('#bolsillo').classList.add('pulsando');
  toqueBolsillo = setTimeout(() => { $('#bolsillo').classList.remove('pulsando'); salirBolsillo(); }, 900);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('#bolsillo').addEventListener(ev, () => {
  clearTimeout(toqueBolsillo);
  $('#bolsillo').classList.remove('pulsando');
}));

// Si iOS detuvo el GPS mientras grababas (pantalla bloqueada o Rumbo en segundo plano), se avisa al volver.
let ocultoDesde = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    ocultoDesde = grabador.estado === 'grabando' ? Date.now() : null;
    return;
  }
  if (ocultoDesde == null) return;
  const ms = grabador.marcarCorte(ocultoDesde, Date.now());
  ocultoDesde = null;
  if (ms) {
    avisar(`El track se cortó ${geo.fmtFalta(ms)}: iOS detiene el GPS al bloquear la pantalla o salir de Rumbo. Usa el modo bolsillo para que no pase.`,
      { accion: 'Modo bolsillo', alAccion: entrarBolsillo, duracion: 15000 });
  }
});

// ---------- Horas de luz ----------
function textoLuz(lon, lat) {
  const ahora = new Date();
  const l = geo.luz(lon, lat, ahora);
  if (l.dia) return l.puesta ? `Quedan ${geo.fmtFalta(l.puesta - ahora)} de luz · puesta de sol ${geo.fmtHora(l.puesta)}` : 'Sol todo el día';
  return l.salida ? `De noche · el sol sale a las ${geo.fmtHora(l.salida)}` : 'Noche todo el día';
}
function textoLuzActual() {
  const c = gps.ultima?.coords;
  if (c) return textoLuz(c.longitude, c.latitude);
  const m = mapa.getCenter();
  return textoLuz(m.lng, m.lat);
}
// Opción «Mostrar en el mapa»: un chip con las horas de luz siempre a la vista.
function filaLuz(id = '') {
  return fila({ icono: 'sol', color: 'amarillo', titulo: `<span${id ? ` id="${id}"` : ''}>${textoLuzActual()}</span>`,
    sub: 'Mostrar siempre en el mapa', accion: 'luz-en-mapa', extra: interruptor(estado.luzEnMapa) });
}
function actualizarChipLuz() {
  const chip = $('#chip-luz');
  chip.hidden = !estado.luzEnMapa || !!estado.bolsillo;
  if (chip.hidden) return;
  const c = gps.ultima?.coords;
  const m = mapa.getCenter();
  const [lon, lat] = c ? [c.longitude, c.latitude] : [m.lng, m.lat];
  const ahora = new Date();
  const l = geo.luz(lon, lat, ahora);
  const falta = l.dia && l.puesta ? l.puesta - ahora : null;
  $('#chip-luz-texto').textContent = l.dia
    ? (l.puesta ? `${falta >= 3600000 ? geo.fmtFalta(falta).replace(' min', '') : geo.fmtFalta(falta)} · ${geo.fmtHora(l.puesta)}` : 'Sol todo el día')
    : (l.salida ? `Sale ${geo.fmtHora(l.salida)}` : 'Noche');
  chip.classList.toggle('noche', !l.dia);
  chip.classList.toggle('poca', falta != null && falta < 3600000);
}
setInterval(actualizarChipLuz, 60000);
$('#chip-luz').addEventListener('click', () => hojaBrujula());

// Grabando o navegando: aviso cuando queda una hora y veinte minutos de luz.
const avisosLuz = new Set();
let ultimaRevisionLuz = 0;
function revisarLuz(lon, lat) {
  if (grabador.estado !== 'grabando' && !nav.navegando()) return;
  if (Date.now() - ultimaRevisionLuz < 60000) return;
  ultimaRevisionLuz = Date.now();
  const l = geo.luz(lon, lat);
  if (!l.dia || !l.puesta) return;
  const min = (l.puesta - Date.now()) / 60000;
  const umbral = [20, 60].find((u) => min <= u && !avisosLuz.has(u));
  if (umbral == null) return;
  [20, 60].filter((u) => u >= umbral).forEach((u) => avisosLuz.add(u));
  const texto = `Queda${min >= 60 ? '' : 'n'} ${geo.fmtFalta(l.puesta - Date.now())} de luz: el sol se pone a las ${geo.fmtHora(l.puesta)}.`;
  avisar(texto, { duracion: 10000 });
  nav.hablar(texto.replace(' h ', ' horas ').replace(' min', ' minutos'));
}

// ---------- Avisos de cercanía ----------
// Voz y aviso al acercarte a tus lugares con categoría (refugio, agua, mirador, campamento, peligro).
const avisadosCerca = new Set();
let cercaListo = false;
function revisarCercania(lon, lat) {
  if (!estado.alertasCercania) return;
  for (const l of estado.lugares) {
    const k = l.categoria || 'general';
    if (k === 'general') continue;
    const radio = k === 'peligro' ? 300 : 150;
    const d = geo.distancia(lon, lat, l.lon, l.lat);
    if (d > radio * 2) { avisadosCerca.delete(l.id); continue; }
    if (d > radio || avisadosCerca.has(l.id)) continue;
    avisadosCerca.add(l.id);
    if (!cercaListo) continue; // al abrir la app no se avisa de lo que ya está cerca
    const m = Math.max(10, Math.round(d / 10) * 10);
    const texto = k === 'peligro' ? `Atención: peligro a ${m} metros. ${l.nombre}.` : `${CATEGORIAS[k].nombre} a ${m} metros: ${l.nombre}.`;
    avisar(texto, { duracion: 7000 });
    nav.hablar(texto);
    navigator.vibrate?.(k === 'peligro' ? [120, 80, 120, 80, 120] : [60]);
  }
  cercaListo = true;
}

// ---------- Aviso de salida ----------
const sinTildes = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '');
const dosCifras = (n) => String(n).padStart(2, '0');
async function hojaAvisoSalida(plan = null) {
  plan = plan || nav.rutaPlanificada();
  const numero = await ajustes.leer('sosNumero', '');
  const ahora = Date.now();
  const base = plan?.duracion ? ahora + 2 * plan.duracion * 1000 + 3600000 : ahora + 4 * 3600000;
  const vuelta = new Date(Math.ceil(base / 1800000) * 1800000);
  abrirHoja('salida', 'Aviso de salida', `
    <p class="nota">Antes de salir, avisa a alguien adónde vas y a qué hora vuelves: si no das noticias, sabrá dónde buscarte. Va por SMS (señal de celular, sin internet), así que envíalo mientras todavía tienes señal.</p>
    <div class="grupo-titulo">Voy a</div>
    <input class="campo" id="salida-destino" maxlength="60" value="${esc(plan?.destino && plan.destino !== 'Mi ubicación' ? plan.destino : '')}" placeholder="Ej.: Torres del Paine, sendero Base Torres" aria-label="Destino">
    <div class="grupo-titulo">Vuelvo a las</div>
    <input class="campo" id="salida-vuelta" type="time" value="${dosCifras(vuelta.getHours())}:${dosCifras(vuelta.getMinutes())}" aria-label="Hora de regreso">
    <div class="grupo-titulo">Avisar a</div>
    <input class="campo" id="salida-numero" type="tel" inputmode="tel" autocomplete="tel" placeholder="+56 9 1234 5678" value="${esc(numero)}" aria-label="Teléfono del contacto">
    <a class="boton primario ancho" id="salida-sms" href="#"><span data-icono="compartir"></span>Enviar aviso por SMS</a>
    <p class="nota" id="salida-texto"></p>
    <p class="nota">Rumbo te recordará a la hora de regreso, para que avises que llegaste bien.</p>`);
  const datos = () => {
    const destino = $('#salida-destino').value.trim();
    const [h, m] = ($('#salida-vuelta').value || '00:00').split(':').map(Number);
    const v = new Date();
    v.setHours(h, m, 0, 0);
    if (v.getTime() <= Date.now()) v.setDate(v.getDate() + 1);
    const manana = v.getDate() !== new Date().getDate();
    const c = gps.ultima?.coords;
    const desde = c ? ` Salgo desde ${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}.` : '';
    const mapa_ = plan ? ` Destino: https://maps.google.com/?q=${plan.lat.toFixed(5)},${plan.lon.toFixed(5)}` : '';
    const texto = sinTildes(`Rumbo: salgo hacia ${destino || 'el cerro'}. Vuelvo aprox a las ${dosCifras(h)}:${dosCifras(m)}${manana ? ' de manana' : ''}. Si no doy noticias 2 h despues, llama al 133 y da ${plan ? 'esta ruta' : 'estos datos'}.${desde}${mapa_}`);
    return { destino, vuelta: v.getTime(), texto, numero: $('#salida-numero').value.trim() };
  };
  const armar = () => {
    const d = datos();
    $('#salida-sms').href = `sms:${d.numero.replace(/[^\d+]/g, '')}&body=${encodeURIComponent(d.texto)}`;
    $('#salida-texto').textContent = `Mensaje: ${d.texto}`;
  };
  ['#salida-destino', '#salida-vuelta', '#salida-numero'].forEach((sel) => $(sel).addEventListener('input', armar));
  $('#salida-numero').addEventListener('change', (e) => ajustes.escribir('sosNumero', e.target.value.trim()));
  $('#salida-sms').addEventListener('click', () => {
    const d = datos();
    estado.salida = { destino: d.destino, vuelta: d.vuelta, numero: d.numero, recordado: false };
    ajustes.escribir('salida', estado.salida);
  });
  armar();
}
function llegueBien() {
  const s = estado.salida;
  if (!s) return;
  const texto = sinTildes(`Rumbo: llegue bien${s.destino ? ` de ${s.destino}` : ''}. Gracias!`);
  estado.salida = null;
  ajustes.escribir('salida', null);
  location.href = `sms:${(s.numero || '').replace(/[^\d+]/g, '')}&body=${encodeURIComponent(texto)}`;
  if (hojaAbierta === 'sos') hojaSOS();
}
// A la hora de regreso, recordatorio para avisar que llegaste bien.
setInterval(() => {
  const s = estado.salida;
  if (!s || s.recordado || Date.now() < s.vuelta) return;
  s.recordado = true;
  ajustes.escribir('salida', s);
  avisar('Es tu hora de regreso. Si ya estás bien, avísale a tu contacto.', { accion: 'Llegué bien', alAccion: llegueBien, duracion: 120000 });
  nav.hablar('Es tu hora de regreso. Si ya estás bien, avísale a tu contacto.');
}, 30000);

// ---------- Medir distancias y áreas ----------
function areaM2(pts) {
  if (pts.length < 3) return 0;
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * kx * y2 * 110540 - x2 * kx * y1 * 110540;
  }
  return Math.abs(a) / 2;
}
function fmtArea(m2) {
  if (m2 < 10000) return `${Math.round(m2).toLocaleString('es-CL')} m²`;
  if (m2 < 1e6) return `${(m2 / 10000).toLocaleString('es-CL', { maximumFractionDigits: 1 })} ha`;
  return `${(m2 / 1e6).toLocaleString('es-CL', { maximumFractionDigits: 2 })} km²`;
}
function pintarMedida() {
  const m = estado.medida;
  const f = [];
  if (m) {
    const pts = m.puntos;
    if (m.area && pts.length >= 3) f.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] }, properties: {} });
    else if (pts.length >= 2) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: {} });
    pts.forEach((p) => f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }));
  }
  mapa.getSource('medida')?.setData({ type: 'FeatureCollection', features: f });
  if (!m) return;
  const pts = m.puntos;
  let largo = 0;
  for (let i = 1; i < pts.length; i++) largo += geo.distancia(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  if (m.area && pts.length >= 3) largo += geo.distancia(pts.at(-1)[0], pts.at(-1)[1], pts[0][0], pts[0][1]);
  $('#medir-texto').textContent = pts.length < 2 ? 'Toca el mapa para agregar puntos'
    : m.area && pts.length >= 3 ? `Área ${fmtArea(areaM2(pts))} · perímetro ${geo.fmtDistancia(largo)}`
      : `Distancia ${geo.fmtDistancia(largo)} · ${pts.length} puntos`;
  $('#medir-area').classList.toggle('primario', m.area);
}
function iniciarMedida(desde = null) {
  estado.medida = { puntos: desde ? [desde] : [], area: false };
  cerrarHoja();
  fijarModo('libre');
  $('#medir').hidden = false;
  pintarMedida();
}
function terminarMedida() {
  estado.medida = null;
  $('#medir').hidden = true;
  pintarMedida();
  fijarModo('libre');
}
mapa.on('click', (e) => {
  if (!estado.medida) return;
  estado.medida.puntos.push([e.lngLat.lng, e.lngLat.lat]);
  pintarMedida();
});

// ---------- Puntos útiles de OpenStreetMap (agua, refugios, campings) ----------
const NOMBRE_UTIL = { agua: 'Agua', refugio: 'Refugio', campamento: 'Camping' };
function pintarUtiles() {
  const lista = nav.utiles();
  mapa.getSource('utiles')?.setData({ type: 'FeatureCollection', features: lista.map(([tipo, lon, lat, nombre]) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { tipo, nombre: nombre || '' } })) });
}
mapa.on('click', 'utiles-punto', (e) => {
  if (nav.estaEligiendo() || nav.navegando() || herramientaActiva()) return;
  const f = e.features[0];
  const [lon, lat] = f.geometry.coordinates;
  hojaNuevoLugar(lon, lat, null, f.properties.nombre || NOMBRE_UTIL[f.properties.tipo] || 'Punto');
  if (CATEGORIAS[f.properties.tipo]) { estado.nuevoLugar.categoria = f.properties.tipo; pintarNuevoLugar(); }
});

Object.assign(acciones, {
  bolsillo: () => entrarBolsillo(),
  'pantalla-siempre': async () => {
    estado.pantallaSiempre = !estado.pantallaSiempre;
    await ajustes.escribir('pantallaSiempre', estado.pantallaSiempre);
    if (estado.pantallaSiempre) pantalla.pedir('abierta'); else pantalla.soltar('abierta');
    hojaMapas();
    avisar(estado.pantallaSiempre ? 'La pantalla queda encendida mientras Rumbo está abierta.' : 'La pantalla se apagará sola salvo al navegar o grabar.');
  },
  'vista-3d': async () => { await cambiar3d(); if (hojaAbierta === 'capas') hojaCapas(); },
  'luz-en-mapa': async () => {
    estado.luzEnMapa = !estado.luzEnMapa;
    await ajustes.escribir('luzEnMapa', estado.luzEnMapa);
    actualizarChipLuz();
    if (hojaAbierta === 'tracks') hojaTracks(); else if (hojaAbierta === 'brujula') hojaBrujula();
    avisar(estado.luzEnMapa ? 'Horas de luz a la vista en el mapa (arriba a la izquierda).' : 'Horas de luz ocultas del mapa.');
  },
  'aviso-salida': () => hojaAvisoSalida(),
  'llegue-bien': () => llegueBien(),
  'alertas-cercania': async () => {
    estado.alertasCercania = !estado.alertasCercania;
    await ajustes.escribir('alertasCercania', estado.alertasCercania);
    hojaLugares();
  },
  medir: () => iniciarMedida(),
  'medir-desde-aqui': () => { const n = estado.nuevoLugar; iniciarMedida(n ? [n.lon, n.lat] : null); },
  'medir-deshacer': () => { estado.medida?.puntos.pop(); pintarMedida(); },
  'medir-area': () => { if (estado.medida) { estado.medida.area = !estado.medida.area; pintarMedida(); } },
  'medir-terminar': () => terminarMedida(),
});


// Herramientas que usan toques sobre el mapa: mientras están activas el mapa no vuelve solo a seguirte.
const herramientaActiva = () => !!(estado.medida || estado.dibujo || estado.repeticion);

// Opciones de terreno (en Mapas y en Tipo de mapa): curvas de nivel apagadas por defecto.
function filasCapasTerreno() {
  return `${nav.tieneRed() ? fila({ icono: 'caminar', color: 'verde', titulo: 'Dificultad de senderos',
    sub: '🟢 fácil · 🔵 montaña · 🔴 exigente · ⚫ alta montaña (según OpenStreetMap)', accion: 'dificultad-senderos', extra: interruptor(estado.mostrarDificultad) }) : ''}
    ${relieve.estado.urlCurvas ? fila({ icono: 'montana', color: 'cafe', titulo: 'Curvas de nivel', sub: 'Líneas de altura cada 20 m, con su cota cada 100 m', accion: 'curvas', extra: interruptor(estado.mostrarCurvas) }) : ''}
    ${relieve.estado.urlRelieve ? fila({ icono: 'montana', color: 'verde', titulo: 'Relieve sombreado', sub: 'Sombras que muestran cerros y quebradas (solo en el mapa, no en satélite)', accion: 'relieve', extra: interruptor(estado.mostrarRelieve) }) : ''}`;
}

// ---------- Altitud corregida con el relieve ----------
// La altitud del GPS del iPhone varía ±10–30 m. El modelo de elevación guardado da la del terreno en ese
// punto; se combinan (más peso al relieve, salvo que el GPS informe muy buena precisión vertical).
async function altitudCorregida(c) {
  const dem = relieve.disponible() ? await relieve.altitud(c.longitude, c.latitude).catch(() => null) : null;
  if (dem == null) return c.altitude;
  if (c.altitude != null && c.altitudeAccuracy != null && c.altitudeAccuracy <= 8) return dem * 0.6 + c.altitude * 0.4;
  return dem;
}
async function registrarPunto(p) {
  const c = p.coords;
  const alt = await altitudCorregida(c);
  if (alt != null) {
    estado.altitudActual = alt;
    if (!estado.bolsillo) $('#dato-altitud').textContent = geo.fmtAltitud(alt);
  }
  if (grabador.estado !== 'grabando') return;
  grabador.agregar(alt === c.altitude ? p : { timestamp: p.timestamp, coords: { latitude: c.latitude, longitude: c.longitude,
    accuracy: c.accuracy, altitude: alt, altitudeAccuracy: c.altitudeAccuracy, speed: c.speed, heading: c.heading } });
}

// ---------- Vista 3D del terreno ----------
async function cambiar3d(activar = !estado.vista3d) {
  if (activar && !relieve.estado.urlRelieve) {
    return avisar('Para la vista 3D instala el relieve de la región (Mapas → Regiones disponibles).', { duracion: 7000 });
  }
  estado.vista3d = activar;
  await ajustes.escribir('vista3d', activar);
  $('#btn-3d').classList.toggle('activo', activar);
  if (activar) { mapa.setMaxPitch(80); mapa.touchPitch.enable(); } else { mapa.touchPitch.disable(); }
  aplicarEstilo();
  mapa.easeTo({ pitch: activar ? 60 : 0, duration: 900 });
  if (!activar) setTimeout(() => { if (!estado.vista3d) mapa.setMaxPitch(0); }, 950);
  else avisar('Vista 3D: inclina el mapa deslizando dos dedos hacia arriba o abajo.', { duracion: 5000 });
}
$('#btn-3d').addEventListener('click', () => cambiar3d());

// ---------- Fotos dentro del track ----------
const urlsFotosTrack = new Map();
function urlFotoTrack(t, f) {
  const k = `${t.id}|${f.t}`;
  if (!urlsFotosTrack.has(k)) urlsFotosTrack.set(k, URL.createObjectURL(f.blob));
  return urlsFotosTrack.get(k);
}
function tomarFotoTrack() {
  if (grabador.estado !== 'grabando') return avisar('Las fotos del recorrido se toman mientras grabas un track.');
  $('#archivo-foto-track').click();
}
$('#archivo-foto-track').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !grabador.track) return;
  const p = gps.ultima;
  if (!p) return avisar('Sin posición GPS: la foto no se puede ubicar en el recorrido.');
  const blob = await reducirFoto(f);
  grabador.agregarFoto({ lon: p.coords.longitude, lat: p.coords.latitude, ele: estado.altitudActual ?? p.coords.altitude ?? null, t: Date.now(), blob });
  avisar(`Foto guardada en el track (${grabador.track.fotos.length}).`);
});
$('#btn-foto-track').addEventListener('click', tomarFotoTrack);
grabador.addEventListener('cambio', () => { $('#btn-foto-track').hidden = grabador.estado !== 'grabando'; });
async function verFotoTrack(clave) {
  const [id, i] = clave.split('|');
  const t = await db.obtener('tracks', id);
  const f = t?.fotos?.[Number(i)];
  if (!f) return;
  abrirHoja('foto', `Foto ${Number(i) + 1} de ${t.fotos.length}`, `
    <img class="foto-lugar" src="${urlFotoTrack(t, f)}" alt="Foto del recorrido">
    <p class="nota">${new Date(f.t).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' })} · ${geo.fmtCoordDecimal(f.lat, f.lon)}${f.ele != null ? ` · ${geo.fmtAltitud(f.ele)}` : ''}</p>
    <div class="fila-botones"><button class="boton" data-accion="ir-foto-track" data-id="${clave}"><span data-icono="ver"></span>Ver en el mapa</button>
    <button class="boton" data-accion="abrir-track" data-id="${t.id}">Volver al track</button></div>`);
}
mapa.on('click', 'track-fotos', (e) => {
  if (herramientaActiva()) return;
  const p = e.features[0].properties;
  if (p.tipo === 'nota') hojaTrack(p.id); else verFotoTrack(p.id);
});

// ---------- Dibujar una ruta de trekking ----------
// Cada tramo entre dos toques va por senderos y caminos (red sin conexión, perfil a pie). Si el punto
// queda lejos de un sendero, ese tramo es una línea recta (campo traviesa).
async function iniciarDibujo() {
  await nav.cargarRed(mapa.getCenter().toArray()).catch(() => false);
  estado.dibujo = { puntos: [], tramos: [], stats: null };
  cerrarHoja();
  fijarModo('libre');
  $('#dibujo').hidden = false;
  pintarDibujo();
  if (!nav.tieneRed()) avisar('Sin las rutas de la región la línea irá recta entre tus puntos.', { duracion: 6000 });
}
function terminarDibujo() {
  estado.dibujo = null;
  $('#dibujo').hidden = true;
  pintarDibujo();
  fijarModo('libre');
}
function coordsDibujo() {
  const d = estado.dibujo;
  const out = d?.puntos.length ? [d.puntos[0]] : [];
  for (const t of d?.tramos || []) out.push(...t.coords.slice(1));
  return out;
}
function pintarDibujo() {
  const d = estado.dibujo;
  const f = [];
  if (d) {
    d.tramos.forEach((t) => f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.coords }, properties: { aPie: t.aPie } }));
    d.puntos.forEach((p) => f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }));
  }
  mapa.getSource('dibujo')?.setData({ type: 'FeatureCollection', features: f });
  if (!d) return;
  const s = d.stats;
  $('#dibujo-texto').textContent = d.calculando ? 'Calculando…'
    : d.puntos.length < 2 ? 'Toca el mapa: inicio, puntos de paso y destino'
      : `${geo.fmtDistancia(s.distancia)} · +${geo.fmtAltitud(s.subida)} −${geo.fmtAltitud(s.bajada)} · ${geo.fmtFalta(s.tiempo)} a pie`;
}
// Tiempo a pie según la pendiente (función de Tobler: 6 km/h en plano, más lento en subidas y bajadas fuertes).
function tiempoAPie(puntos) {
  let seg = 0;
  for (let i = 1; i < puntos.length; i++) {
    const dd = puntos[i][0] - puntos[i - 1][0];
    if (dd <= 0) continue;
    const pend = (puntos[i][1] - puntos[i - 1][1]) / dd;
    const v = 6 * Math.exp(-3.5 * Math.abs(pend + 0.05)) * 0.9; // ×0,9: con mochila
    seg += dd / ((v * 1000) / 3600);
  }
  return seg * 1000;
}
async function recalcularDibujo() {
  const d = estado.dibujo;
  const coords = coordsDibujo();
  const acum = [0];
  for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + geo.distancia(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  const distancia = acum.at(-1) || 0;
  const pf = coords.length > 1 ? await relieve.perfil(coords, acum, Math.min(300, Math.max(20, Math.round(distancia / 25)))) : null;
  d.stats = pf
    ? { distancia, subida: pf.subida, bajada: pf.bajada, tiempo: tiempoAPie(pf.puntos) }
    : { distancia, subida: 0, bajada: 0, tiempo: (distancia / 4500) * 3600000 };
}
mapa.on('click', async (e) => {
  const d = estado.dibujo;
  if (!d || d.calculando) return;
  const p = [e.lngLat.lng, e.lngLat.lat];
  const previo = d.puntos.at(-1);
  d.puntos.push(p);
  if (previo) {
    d.calculando = true;
    pintarDibujo();
    const r = nav.tieneRed() ? await nav.tramoAPie(previo, p) : null;
    // Si el sendero más cercano queda a más de 150 m de alguno de los dos puntos, el tramo va recto.
    const ok = r && geo.distancia(...r.coords[0], ...previo) < 150 && geo.distancia(...r.coords.at(-1), ...p) < 150;
    d.tramos.push(ok ? { coords: [previo, ...r.coords, p], aPie: true } : { coords: [previo, p], aPie: false });
    await recalcularDibujo();
    d.calculando = false;
  }
  pintarDibujo();
});
async function guardarDibujo({ seguir = false } = {}) {
  const d = estado.dibujo;
  if (!d || d.puntos.length < 2) return avisar('Toca al menos dos puntos en el mapa.');
  const coords = coordsDibujo();
  const seg = [];
  for (const c of coords) seg.push([Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6, relieve.disponible() ? await relieve.altitud(c[0], c[1]) : null, 0]);
  const ahora = Date.now();
  const t = { id: nuevoId(), nombre: `Ruta planificada ${new Date(ahora).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })}`,
    inicio: ahora, fin: ahora, segmentos: [seg], distancia: d.stats.distancia, subida: d.stats.subida, bajada: d.stats.bajada,
    tiempo: d.stats.tiempo, abierto: false, planificada: true };
  await db.guardar('tracks', t);
  terminarDibujo();
  if (seguir) nav.seguirTrack(coords, t.nombre);
  else { avisar('Ruta guardada en Tracks: desde ahí puedes seguirla, exportarla o pedir el pronóstico.', { duracion: 6000 }); hojaTrack(t.id); }
}

// ---------- Pronóstico guardado ----------
async function pedirPronostico({ nombre, lon, lat }) {
  const guardados = await pron.listar();
  const previo = guardados.find((v) => Math.abs(v.lon - lon) < 0.01 && Math.abs(v.lat - lat) < 0.01);
  if (!navigator.onLine) {
    if (previo) return hojaPronostico(previo.id);
    return avisar('El pronóstico se descarga con internet y después queda guardado para verlo sin señal.', { duracion: 7000 });
  }
  avisar('Descargando pronóstico…', { duracion: 4000 });
  try {
    const p = await pron.descargar({ nombre, lon, lat });
    hojaPronostico(p.id);
  } catch (err) {
    if (previo) { avisar('No se pudo actualizar: muestro el que tenías guardado.'); return hojaPronostico(previo.id); }
    avisar(`No se pudo descargar el pronóstico: ${err.message}`, { duracion: 7000 });
  }
}
const DIA_SEMANA = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
async function hojaPronostico(id) {
  const p = await pron.obtener(id);
  if (!p) return;
  const d = p.datos.daily;
  const h = p.datos.hourly;
  const edad = Date.now() - p.guardado;
  const filas = d.time.map((dia, i) => {
    const [, simbolo, texto] = pron.clima(d.weather_code[i]);
    const f = new Date(`${dia}T12:00`);
    const nivel = pron.nivelViento(d.wind_gusts_10m_max[i]);
    return `<div class="pron-dia">
      <div class="pron-fecha">${DIA_SEMANA[f.getDay()]} ${f.getDate()}</div>
      <div class="pron-cielo"><span class="pron-simbolo">${simbolo}</span>${texto}</div>
      <div class="pron-temp">${Math.round(d.temperature_2m_min[i])}° / <b>${Math.round(d.temperature_2m_max[i])}°</b></div>
      <div class="pron-lluvia">💧 ${d.precipitation_sum[i].toLocaleString('es-CL', { maximumFractionDigits: 1 })} mm${d.precipitation_probability_max?.[i] != null ? ` · ${d.precipitation_probability_max[i]}%` : ''}</div>
      <div class="pron-viento ${nivel}">${pron.flecha(d.wind_direction_10m_dominant[i])} ${Math.round(d.wind_speed_10m_max[i])} km/h · ráfagas <b>${Math.round(d.wind_gusts_10m_max[i])}</b> · del ${pron.direccion(d.wind_direction_10m_dominant[i])}</div>
    </div>`;
  }).join('');
  // Próximas 24 h cada 3 horas (desde la hora actual del lugar).
  const ahoraIso = new Date(Date.now() + ((p.datos.utc_offset_seconds || 0) * 1000)).toISOString().slice(0, 13);
  const i0 = Math.max(0, h.time.findIndex((t) => t.slice(0, 13) >= ahoraIso));
  const horas = [];
  for (let i = i0; i < Math.min(h.time.length, i0 + 24); i += 3) {
    horas.push(`<div class="pron-hora"><div>${h.time[i].slice(11, 16)}</div><div>${pron.simbolo(h.weather_code[i], h.is_day?.[i] ?? 1)}</div><div><b>${Math.round(h.temperature_2m[i])}°</b></div>
      <div class="${pron.nivelViento(h.wind_gusts_10m[i])}">${Math.round(h.wind_speed_10m[i])}<small>/${Math.round(h.wind_gusts_10m[i])}</small></div><div>${h.precipitation[i] ? `${h.precipitation[i]} mm` : '·'}</div></div>`);
  }
  const fuerte = d.wind_gusts_10m_max.some((g) => g >= 60);
  abrirHoja('pronostico', esc(p.nombre), `
    <p class="nota">${geo.fmtCoordDecimal(p.lat, p.lon)} · guardado ${edad < 3600000 ? `hace ${geo.fmtFalta(edad)}` : `el ${new Date(p.guardado).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' })}`}
      ${edad > 86400000 ? ' · <b>tiene más de un día: puede haber cambiado</b>' : ''}. Se ve sin señal.</p>
    ${fuerte ? '<p class="nota aviso-luz">⚠︎ Ráfagas de 60 km/h o más en los próximos días: en terreno abierto o con mochila grande puede ser peligroso.</p>' : ''}
    <div class="grupo-titulo">Próximas horas · viento / ráfagas km/h</div>
    <div class="pron-horas">${horas.join('')}</div>
    <div class="grupo-titulo">Próximos ${d.time.length} días</div>
    <div class="grupo pron-dias">${filas}</div>
    <div class="fila-botones">
      <button class="boton" data-accion="pronostico-actualizar" data-id="${p.id}"><span data-icono="descargar"></span>Actualizar</button>
      <button class="boton peligro" data-accion="pronostico-borrar" data-id="${p.id}"><span data-icono="basura"></span>Borrar</button>
    </div>
    <p class="nota">Datos de Open-Meteo.com (CC BY 4.0). El viento en cumbres y portezuelos suele ser más fuerte que el pronosticado.</p>`);
}
async function pintarListaPronosticos() {
  const el = document.getElementById('lista-pronosticos');
  if (!el) return;
  const lista = await pron.listar();
  el.innerHTML = lista.length ? `<div class="grupo-titulo">Pronósticos guardados</div><div class="grupo">${lista.map((p) => {
    const g = Math.max(...p.datos.daily.wind_gusts_10m_max.slice(0, 3));
    return fila({ icono: 'sol', color: 'amarillo', titulo: esc(p.nombre), accion: 'abrir-pronostico', id: p.id,
      sub: `Guardado ${new Date(p.guardado).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })} · ráfagas hasta ${Math.round(g)} km/h` });
  }).join('')}</div>` : '';
  pintarIconos(el);
}

// ---------- Repetición del track en 3D ----------
function iniciarRepeticion(t) {
  const coords = t.segmentos.flat().map((p) => [p[0], p[1]]);
  if (coords.length < 2) return avisar('Este track tiene muy pocos puntos para repetirlo.');
  const acum = [0];
  for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + geo.distancia(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  const total = acum.at(-1);
  estado.trackVisto = t;
  pintarTrackVisto();
  estado.repeticion = { coords, acum, total, dur: Math.min(90000, Math.max(25000, total * 4)), avance: 0, ultimo: null, pausa: false, rumbo: null };
  cerrarHoja();
  fijarModo('libre');
  mapa.setMaxPitch(80);
  aplicarEstilo();
  $('#repeticion').hidden = false;
  $('#rep-pausa').textContent = 'Pausa';
  requestAnimationFrame(cuadroRepeticion);
}
function puntoEn(r, d) {
  let i = 1;
  while (i < r.acum.length - 1 && r.acum[i] < d) i++;
  const k = (d - r.acum[i - 1]) / ((r.acum[i] - r.acum[i - 1]) || 1);
  const a = r.coords[i - 1];
  const b = r.coords[i];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
function cuadroRepeticion(ahora) {
  const r = estado.repeticion;
  if (!r) return;
  if (r.ultimo != null && !r.pausa) r.avance = Math.min(1, r.avance + (ahora - r.ultimo) / r.dur);
  r.ultimo = ahora;
  const d = r.avance * r.total;
  const p = puntoEn(r, d);
  const delante = puntoEn(r, Math.min(r.total, d + Math.max(150, r.total * 0.03)));
  const objetivo = geo.azimut(p[0], p[1], delante[0], delante[1]);
  if (r.rumbo == null) r.rumbo = objetivo;
  let dif = objetivo - r.rumbo;
  if (dif > 180) dif -= 360;
  if (dif < -180) dif += 360;
  r.rumbo = (r.rumbo + dif * 0.04 + 360) % 360;
  mapa.jumpTo({ center: p, bearing: r.rumbo, pitch: 62, zoom: r.total > 15000 ? 13.2 : 14.2 });
  mapa.getSource('repeticion')?.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} });
  $('#rep-barra').style.width = `${(r.avance * 100).toFixed(1)}%`;
  $('#rep-texto').textContent = `${geo.fmtDistancia(d)} de ${geo.fmtDistancia(r.total)}`;
  if (r.avance >= 1) { r.pausa = true; $('#rep-pausa').textContent = 'Otra vez'; }
  requestAnimationFrame(cuadroRepeticion);
}
function terminarRepeticion() {
  estado.repeticion = null;
  $('#repeticion').hidden = true;
  mapa.getSource('repeticion')?.setData({ type: 'FeatureCollection', features: [] });
  aplicarEstilo();
  if (!estado.vista3d) { mapa.easeTo({ pitch: 0, duration: 600 }); setTimeout(() => { if (!estado.vista3d) mapa.setMaxPitch(0); }, 650); }
  fijarModo('libre');
}

// ---------- Estadísticas y récords ----------
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
async function hojaEstadisticas(anio = null) {
  const tracks = (await db.todos('tracks')).filter((t) => !t.abierto && !t.planificada && !t.importado);
  if (!tracks.length) return abrirHoja('estadisticas', 'Estadísticas', '<p class="nota">Graba tu primer track y aquí verás tus kilómetros, desnivel y récords.</p>');
  const suma = (lista) => lista.reduce((s, t) => ({ km: s.km + t.distancia, sube: s.sube + (t.subida || 0), ms: s.ms + duracion(t), n: s.n + 1 }), { km: 0, sube: 0, ms: 0, n: 0 });
  const anios = [...new Set(tracks.map((t) => new Date(t.inicio).getFullYear()))].sort((a, b) => b - a);
  anio = anio || anios[0];
  const delAnio = tracks.filter((t) => new Date(t.inicio).getFullYear() === anio);
  const meses = MESES.map((m, i) => ({ m, ...suma(delAnio.filter((t) => new Date(t.inicio).getMonth() === i)) }));
  const maxKm = Math.max(1, ...meses.map((x) => x.km));
  const total = suma(tracks);
  const tAnio = suma(delAnio);
  const altMax = (t) => Math.max(-Infinity, ...t.segmentos.flat().map((p) => p[2]).filter((v) => v != null));
  const record = (titulo, t, valor) => fila({ icono: 'track-r', color: 'naranja', titulo: `${titulo}: ${valor}`, sub: `${esc(t.nombre)}`, accion: 'abrir-track', id: t.id });
  const mayor = (f) => tracks.reduce((a, b) => (f(b) > f(a) ? b : a));
  const cifra = (etq, v) => `<div class="estadistica"><div class="etiqueta">${etq}</div><div class="valor">${v}</div></div>`;
  const tAlt = mayor(altMax);
  abrirHoja('estadisticas', 'Estadísticas', `
    <div class="grupo-titulo">Todo</div>
    <div class="estadisticas">${cifra('Salidas', total.n)}${cifra('Distancia', geo.fmtDistancia(total.km))}${cifra('Subida', `+${geo.fmtAltitud(total.sube)}`)}</div>
    <div class="grupo-titulo">${anios.length > 1 ? anios.map((a) => `<button class="boton chico ${a === anio ? 'primario' : ''}" data-accion="estadisticas" data-id="${a}">${a}</button>`).join(' ') : anio}</div>
    <div class="estadisticas">${cifra('Salidas', tAnio.n)}${cifra('Distancia', geo.fmtDistancia(tAnio.km))}${cifra('Tiempo', geo.fmtDuracion(tAnio.ms))}</div>
    <div class="barras-meses">${meses.map((x) => `<div class="barra-mes" title="${x.m}: ${geo.fmtDistancia(x.km)}">
      <div class="barra-valor">${x.km ? (x.km / 1000).toLocaleString('es-CL', { maximumFractionDigits: x.km < 10000 ? 1 : 0 }) : ''}</div>
      <div class="barra" style="height:${Math.max(x.km ? 4 : 0, (x.km / maxKm) * 100)}%"></div><div class="barra-etiqueta">${x.m}</div></div>`).join('')}</div>
    <p class="nota">Kilómetros por mes en ${anio} · subida del año +${geo.fmtAltitud(tAnio.sube)}</p>
    <div class="grupo-titulo">Récords</div>
    <div class="grupo">
      ${record('Más larga', mayor((t) => t.distancia), geo.fmtDistancia(mayor((t) => t.distancia).distancia))}
      ${record('Más desnivel', mayor((t) => t.subida || 0), `+${geo.fmtAltitud(mayor((t) => t.subida || 0).subida)}`)}
      ${record('Más tiempo', mayor(duracion), geo.fmtDuracion(duracion(mayor(duracion))))}
      ${Number.isFinite(altMax(tAlt)) ? record('Mayor altitud', tAlt, geo.fmtAltitud(altMax(tAlt))) : ''}
    </div>
    <p class="nota">Cuenta los tracks que grabaste con Rumbo (no los importados ni las rutas planificadas).</p>`);
}

Object.assign(acciones, {
  cerros: () => abrirCerros(),
  'cerros-cerrar': () => cerrarCerros(),
  'foto-track': () => tomarFotoTrack(),
  'ver-foto-track': (id) => verFotoTrack(id),
  'ir-foto-track': async (clave) => {
    const [id, i] = clave.split('|');
    const t = await db.obtener('tracks', id);
    const f = t?.fotos?.[Number(i)];
    if (!f) return;
    estado.trackVisto = t;
    pintarTrackVisto();
    cerrarHoja();
    fijarModo('libre');
    mapa.flyTo({ center: [f.lon, f.lat], zoom: Math.max(mapa.getZoom(), 15) });
  },
  dibujar: () => iniciarDibujo(),
  'dibujo-deshacer': async () => {
    const d = estado.dibujo;
    if (!d || d.calculando || !d.puntos.length) return;
    d.puntos.pop();
    d.tramos.splice(Math.max(0, d.puntos.length - 1));
    await recalcularDibujo();
    pintarDibujo();
  },
  'dibujo-guardar': () => guardarDibujo(),
  'dibujo-seguir': () => guardarDibujo({ seguir: true }),
  'dibujo-cancelar': () => terminarDibujo(),
  'pronostico-aqui': () => { const n = estado.nuevoLugar; if (n) pedirPronostico({ nombre: $('#nombre-lugar')?.value || n.nombre, lon: n.lon, lat: n.lat }); },
  'pronostico-lugar': (id) => { const l = estado.lugares.find((x) => x.id === id); if (l) pedirPronostico({ nombre: l.nombre, lon: l.lon, lat: l.lat }); },
  'abrir-pronostico': (id) => hojaPronostico(id),
  'pronostico-actualizar': async (id) => { const p = await pron.obtener(id); if (p) pedirPronostico(p); },
  'pronostico-borrar': async (id) => { await pron.borrar(id); hojaLugares(); },
  'repetir-track': async (id) => { const t = await db.obtener('tracks', id); if (t) iniciarRepeticion(t); },
  'rep-pausa': () => {
    const r = estado.repeticion;
    if (!r) return;
    if (r.avance >= 1) { r.avance = 0; r.pausa = false; } else r.pausa = !r.pausa;
    $('#rep-pausa').textContent = r.pausa ? 'Seguir' : 'Pausa';
  },
  'rep-salir': () => terminarRepeticion(),
  estadisticas: (anio) => hojaEstadisticas(anio ? Number(anio) : null),
});


// ---------- ¿Dónde estacioné? ----------
// Al llegar en auto se guarda solo dónde quedó; también se puede guardar a mano.
let marcaAuto = null;
function pintarAuto() {
  marcaAuto?.remove();
  marcaAuto = null;
  const a = estado.auto;
  if (!a) return;
  const el = document.createElement('div');
  el.className = 'marca-auto';
  el.textContent = '🚗';
  el.addEventListener('click', (e) => { e.stopPropagation(); hojaAuto(); });
  marcaAuto = new maplibregl.Marker({ element: el }).setLngLat([a.lon, a.lat]).addTo(mapa);
}
async function guardarAuto(c, { automatico = false } = {}) {
  if (!c) return avisar('Sin posición GPS: no puedo guardar dónde quedó el auto.');
  estado.auto = { lon: c.longitude, lat: c.latitude, t: Date.now() };
  await ajustes.escribir('autoEstacionado', estado.auto);
  pintarAuto();
  if (hojaAbierta === 'auto') hojaAuto();
  avisar(automatico ? 'Llegaste: guardé dónde quedó tu auto 🚗' : 'Guardé dónde quedó tu auto 🚗', { accion: 'Ver', alAccion: hojaAuto, duracion: 7000 });
}
function hojaAuto() {
  const a = estado.auto;
  const c = gps.ultima?.coords;
  if (!a) {
    return abrirHoja('auto', '¿Dónde estacioné?', `<p class="nota">Cuando llegas a un destino navegando en auto, Rumbo guarda solo dónde quedó. También puedes guardarlo ahora.</p>
      <div class="fila-botones"><button class="boton primario" data-accion="auto-aqui"><span data-icono="pin"></span>Mi auto está aquí</button></div>`);
  }
  const d = c ? geo.distancia(c.longitude, c.latitude, a.lon, a.lat) : null;
  abrirHoja('auto', '¿Dónde estacioné?', `
    <div class="grupo">${fila({ icono: 'auto', color: 'azul', titulo: d != null ? `A ${geo.fmtDistancia(d)} de ti` : geo.fmtCoordDecimal(a.lat, a.lon),
      sub: `Guardado ${new Date(a.t).toLocaleString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}` })}</div>
    <div class="fila-botones" style="margin-bottom:10px">
      <button class="boton primario" data-accion="auto-ir"><span data-icono="caminar"></span>Llévame a pie</button>
      <button class="boton" data-accion="auto-recta"><span data-icono="rumbo"></span>Línea recta</button>
    </div>
    <div class="fila-botones"><button class="boton" data-accion="auto-aqui">Guardar aquí de nuevo</button>
      <button class="boton peligro" data-accion="auto-borrar"><span data-icono="basura"></span>Borrar</button></div>`);
}

// ---------- Casa, Trabajo y búsquedas recientes ----------
const FAVS = { casa: { nombre: 'Casa', emoji: '🏠' }, trabajo: { nombre: 'Trabajo', emoji: '💼' } };
function pintarSugerencias() {
  const caja = $('#sugerencias');
  const fav = (k) => {
    const f = estado.favoritos[k];
    return `<button class="sug sug-fav" data-accion="${f ? 'fav-ir' : 'fav-definir'}" data-id="${k}">${FAVS[k].emoji} ${FAVS[k].nombre}${f ? '' : ' <small>Definir</small>'}</button>`;
  };
  const rec = estado.recientes.map((r, i) => `<button class="sug" data-accion="reciente" data-id="${i}">🕘<span>${esc(r.nombre)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></button>`).join('');
  caja.innerHTML = `<div class="sug-favs">${fav('casa')}${fav('trabajo')}</div>
    ${estado.auto ? '<button class="sug" data-accion="auto-hoja">🚗<span>¿Dónde estacioné?</span></button>' : ''}
    ${rec ? `<div class="sug-titulo">Recientes</div>${rec}<button class="sug" data-accion="recientes-borrar"><small>Borrar recientes</small></button>` : ''}`;
}
function mostrarSugerencias(si) {
  if (si) pintarSugerencias();
  $('#sugerencias').hidden = !si;
}
$('#buscar-texto').addEventListener('focus', () => mostrarSugerencias(!$('#buscar-texto').value.trim()));
$('#buscar-texto').addEventListener('input', () => mostrarSugerencias(!$('#buscar-texto').value.trim()));
$('#buscar-texto').addEventListener('blur', () => setTimeout(() => mostrarSugerencias(false), 250));
async function agregarReciente(r) {
  const nuevo = { nombre: r.nombre, sub: r.sub || '', lon: r.lon, lat: r.lat };
  estado.recientes = [nuevo, ...estado.recientes.filter((x) => x.nombre !== nuevo.nombre)].slice(0, 8);
  await ajustes.escribir('recientes', estado.recientes);
}
async function guardarFavorito(k, punto) {
  estado.favoritos = { ...estado.favoritos, [k]: punto };
  await ajustes.escribir('favoritos', estado.favoritos);
  avisar(`${FAVS[k].emoji} ${FAVS[k].nombre} guardado. Tócalo en el buscador para ir.`);
}
function hojaDefinirFavorito(k) {
  abrirHoja('favorito', `${FAVS[k].emoji} ${FAVS[k].nombre}`, `
    <p class="nota">Guarda tu ${FAVS[k].nombre.toLowerCase()} para llegar con un toque desde el buscador.</p>
    <div class="fila-botones" style="margin-bottom:10px"><button class="boton primario" data-accion="fav-aqui" data-id="${k}"><span data-icono="pin"></span>Usar mi ubicación actual</button></div>
    <p class="nota">O mantén el dedo sobre el mapa en el lugar y toca «${FAVS[k].nombre}».</p>`);
}

// ---------- Volver al inicio por el mismo camino ----------
function volverPorTrack(t, nombre = 'de regreso al inicio') {
  const coords = t ? t.segmentos.flat().map((p) => [p[0], p[1]]).reverse() : [];
  if (coords.length < 2) return avisar('Todavía no hay suficiente recorrido grabado para guiarte de vuelta.');
  // Desde donde estás: se recorta lo que queda «detrás» de tu posición (el inicio del regreso es tu último punto).
  nav.seguirTrack(coords, nombre);
  avisar('Te guío de vuelta por el mismo camino. Si te sales, te aviso hacia dónde volver.', { duracion: 6000 });
}

// ---------- Ir en línea recta a un punto ----------
function iniciarObjetivo(punto) {
  estado.objetivo = punto;
  brujula.activar().catch(() => false);
  cerrarHoja();
  $('#objetivo').hidden = false;
  $('#objetivo-nombre').textContent = punto.nombre || 'Punto elegido';
  estado.objetivoLlegado = false;
  actualizarObjetivo();
  avisar('La flecha apunta al lugar. Sostén el iPhone plano y gira hasta que apunte hacia arriba.', { duracion: 6000 });
}
function terminarObjetivo() {
  estado.objetivo = null;
  $('#objetivo').hidden = true;
  mapa.getSource('objetivo')?.setData({ type: 'FeatureCollection', features: [] });
}
function actualizarObjetivo() {
  const o = estado.objetivo;
  if (!o) return;
  const c = gps.ultima?.coords;
  if (!c) { $('#objetivo-distancia').textContent = 'Sin GPS'; return; }
  const d = geo.distancia(c.longitude, c.latitude, o.lon, o.lat);
  const az = geo.azimut(c.longitude, c.latitude, o.lon, o.lat);
  const rumbo = rumboActual();
  // Con brújula (o en marcha) la flecha es relativa a hacia dónde miras; si no, apunta respecto al norte.
  const giro = rumbo == null ? az : az - rumbo;
  $('#objetivo-svg').style.transform = `rotate(${giro}deg)`;
  $('#objetivo-distancia').textContent = geo.fmtDistancia(d);
  $('#objetivo-rumbo').textContent = `Rumbo ${geo.fmtRumbo(az)}${rumbo == null ? ' · activa la brújula para que la flecha gire contigo' : ''}`;
  mapa.getSource('objetivo')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[c.longitude, c.latitude], [o.lon, o.lat]] }, properties: {} });
  if (d < Math.max(15, c.accuracy || 0) && !estado.objetivoLlegado) {
    estado.objetivoLlegado = true;
    navigator.vibrate?.([100, 60, 100]);
    nav.hablar(`Llegaste a ${o.nombre || 'tu punto'}.`);
    avisar(`Llegaste a ${o.nombre || 'tu punto'}.`);
  }
}
gps.addEventListener('posicion', actualizarObjetivo);
brujula.addEventListener('rumbo', () => { if (estado.objetivo) actualizarObjetivo(); });

// ---------- Ficha médica de emergencia ----------
const CAMPOS_FICHA = [
  ['nombre', 'Nombre', 'Nombre y apellido'], ['sangre', 'Grupo sanguíneo', 'Ej.: O+'], ['alergias', 'Alergias', 'Ej.: penicilina, abejas'],
  ['medicamentos', 'Medicamentos', 'Ej.: insulina, aspirina'], ['condiciones', 'Condiciones médicas', 'Ej.: diabetes, asma, marcapasos'],
  ['contactoNombre', 'Contacto de emergencia', 'Nombre'], ['contactoTel', 'Teléfono del contacto', '+56 9 …'], ['notas', 'Otras notas', 'Seguro de salud, RUT…'],
];
function hojaFichaEditar() {
  const f = estado.ficha || {};
  abrirHoja('ficha', 'Ficha médica', `
    <p class="nota">Queda solo en este iPhone. En una emergencia, quien te ayude la ve desde el botón SOS de Rumbo.</p>
    ${CAMPOS_FICHA.map(([k, etq, ph]) => `<div class="grupo-titulo">${etq}</div>
      <input class="campo" id="ficha-${k}" ${k === 'contactoTel' ? 'type="tel" inputmode="tel"' : ''} maxlength="120" value="${esc(f[k] || '')}" placeholder="${ph}" aria-label="${etq}">`).join('')}
    <div class="fila-botones"><button class="boton primario" data-accion="ficha-guardar">Guardar ficha</button></div>`);
}
function hojaFichaVer() {
  const f = estado.ficha || {};
  const c = gps.ultima?.coords;
  const dato = (etq, v) => (v ? `<div class="dato"><div class="etq">${etq}</div>${esc(v)}</div>` : '');
  abrirHoja('ficha-ver', 'Ficha médica', `<div class="ficha-grande">
    ${f.sangre ? `<div class="dato"><div class="etq">Grupo sanguíneo</div><div class="sangre">${esc(f.sangre)}</div></div>` : ''}
    ${dato('Nombre', f.nombre)}${dato('Alergias', f.alergias)}${dato('Medicamentos', f.medicamentos)}${dato('Condiciones médicas', f.condiciones)}
    ${f.contactoNombre || f.contactoTel ? `<div class="dato"><div class="etq">Contacto de emergencia</div>${esc(f.contactoNombre || '')}
      ${f.contactoTel ? `<br><a href="tel:${esc(f.contactoTel.replace(/[^\d+]/g, ''))}">${esc(f.contactoTel)}</a>` : ''}</div>` : ''}
    ${dato('Notas', f.notas)}
    ${c ? `<div class="dato"><div class="etq">Ubicación</div>${geo.fmtUtm(c.latitude, c.longitude)}<br>${geo.fmtCoordDecimal(c.latitude, c.longitude)}</div>` : ''}
  </div>
  <div class="fila-botones"><button class="boton" data-accion="ficha-editar">Editar</button></div>`);
}
function bloqueFicha() {
  const f = estado.ficha;
  const tiene = f && Object.values(f).some(Boolean);
  if (!tiene) {
    return `<div class="grupo-titulo">Ficha médica</div>
      <div class="fila-botones"><button class="boton" data-accion="ficha-editar"><span data-icono="mas"></span>Completar ficha médica</button></div>`;
  }
  const resumen = [f.sangre && `Grupo ${f.sangre}`, f.alergias && `Alergias: ${f.alergias}`, f.condiciones].filter(Boolean).join(' · ');
  return `<div class="grupo-titulo">Ficha médica</div>
    <div class="grupo">${fila({ icono: 'sos', color: 'rojo', titulo: esc(f.nombre || 'Ficha médica'), sub: esc(resumen || 'Ver datos'), accion: 'ficha-ver' })}</div>`;
}

Object.assign(acciones, {
  'auto-hoja': () => hojaAuto(),
  'auto-aqui': () => guardarAuto(gps.ultima?.coords),
  'auto-ir': () => { const a = estado.auto; if (a) nav.irA({ lon: a.lon, lat: a.lat, nombre: 'Mi auto' }, 'pie'); },
  'auto-recta': () => { const a = estado.auto; if (a) iniciarObjetivo({ lon: a.lon, lat: a.lat, nombre: 'Mi auto' }); },
  'auto-borrar': async () => { estado.auto = null; await ajustes.escribir('autoEstacionado', null); pintarAuto(); cerrarHoja(); },
  'fav-ir': (k) => { const f = estado.favoritos[k]; if (f) { $('#buscar-texto').blur(); nav.irA({ lon: f.lon, lat: f.lat, nombre: FAVS[k].nombre }); } },
  'fav-definir': (k) => hojaDefinirFavorito(k),
  'fav-aqui': (k) => { const c = gps.ultima?.coords; if (!c) return avisar('Sin posición GPS todavía.'); guardarFavorito(k, { lon: c.longitude, lat: c.latitude }); cerrarHoja(); },
  'fav-guardar': (k) => { const n = estado.nuevoLugar; if (n) guardarFavorito(k, { lon: n.lon, lat: n.lat }); },
  reciente: (i) => {
    const r = estado.recientes[Number(i)];
    if (!r) return;
    $('#buscar-texto').value = r.nombre;
    $('#buscar-texto').blur();
    fijarModo('libre');
    mapa.flyTo({ center: [r.lon, r.lat], zoom: Math.max(mapa.getZoom(), 15.5) });
    marcaBusqueda?.remove();
    marcaBusqueda = new maplibregl.Marker({ color: '#2f7df6' }).setLngLat([r.lon, r.lat]).addTo(mapa);
    hojaNuevoLugar(r.lon, r.lat, null, r.nombre);
  },
  'recientes-borrar': async () => { estado.recientes = []; await ajustes.escribir('recientes', []); pintarSugerencias(); },
  'volver-inicio': () => volverPorTrack(grabador.track),
  'volver-track': async (id) => volverPorTrack(await db.obtener('tracks', id), 'por el mismo camino'),
  'recta-aqui': () => { const n = estado.nuevoLugar; if (n) iniciarObjetivo({ lon: n.lon, lat: n.lat, nombre: $('#nombre-lugar')?.value || n.titulo || 'Punto elegido' }); },
  'recta-lugar': (id) => { const l = estado.lugares.find((x) => x.id === id); if (l) iniciarObjetivo({ lon: l.lon, lat: l.lat, nombre: l.nombre }); },
  'objetivo-cerrar': () => terminarObjetivo(),
  'ficha-editar': () => hojaFichaEditar(),
  'ficha-ver': () => hojaFichaVer(),
  'ficha-guardar': async () => {
    const f = {};
    for (const [k] of CAMPOS_FICHA) f[k] = $(`#ficha-${k}`).value.trim();
    estado.ficha = f;
    await ajustes.escribir('fichaMedica', f);
    avisar('Ficha médica guardada.');
    hojaSOS();
  },
});


// ---------- Modo HUD (parabrisas) ----------
// Pantalla negra con flecha, distancia y velocidad grandes, en espejo: el iPhone se deja bajo el parabrisas
// y se lee el reflejo en el vidrio. Toca dos veces para cambiar el espejo; mantén 1 segundo para salir.
const ESPEJOS = [['scaleY(-1)', 'Espejo vertical (iPhone con la parte de arriba hacia el vidrio)'], ['scaleX(-1)', 'Espejo horizontal'], ['none', 'Sin espejo']];
let relojHud = null;
let toqueHud = null;
let ultimoToqueHud = 0;
function entrarHud() {
  estado.hud = true;
  cerrarHoja();
  $('#hud').hidden = false;
  aplicarEspejoHud();
  pantalla.pedir('hud');
  actualizarHud();
  clearInterval(relojHud);
  relojHud = setInterval(actualizarHud, 1000);
  avisar('HUD: deja el iPhone bajo el parabrisas con el brillo al máximo. Toca dos veces para cambiar el espejo; mantén el dedo para salir.', { duracion: 7000 });
}
function salirHud() {
  estado.hud = false;
  $('#hud').hidden = true;
  pantalla.soltar('hud');
  clearInterval(relojHud);
}
function aplicarEspejoHud() {
  const [t] = ESPEJOS[estado.hudEspejo % ESPEJOS.length];
  $('#hud-contenido').style.transform = t;
}
function actualizarHud() {
  if (!estado.hud) return;
  const c = gps.ultima?.coords;
  const kmh = c?.speed != null && c.speed >= 0 ? Math.round(c.speed * 3.6) : 0;
  $('#hud-vel').textContent = kmh;
  const lim = $('#limite');
  const max = !lim.hidden ? Number($('#limite-valor').textContent) : 0;
  $('#hud-limite').hidden = !max;
  $('#hud-limite').textContent = max || '';
  $('#hud-contenido').classList.toggle('exceso', !!max && kmh > max + 5);
  if (nav.navegando()) {
    $('#hud-flecha').innerHTML = $('#nav-icono').innerHTML;
    $('#hud-dist').textContent = $('#nav-distancia').textContent;
    $('#hud-texto').textContent = $('#nav-texto').textContent;
  } else {
    const r = rumboActual();
    $('#hud-flecha').innerHTML = '';
    $('#hud-dist').textContent = r != null ? `${Math.round(r)}° ${geo.cardinal(r)}` : '';
    $('#hud-texto').textContent = 'Sin ruta: muestra velocidad y rumbo';
  }
}
gps.addEventListener('posicion', actualizarHud);
$('#hud').addEventListener('pointerdown', () => {
  const ahora = Date.now();
  if (ahora - ultimoToqueHud < 350) {
    estado.hudEspejo = (estado.hudEspejo + 1) % ESPEJOS.length;
    ajustes.escribir('hudEspejo', estado.hudEspejo);
    aplicarEspejoHud();
  }
  ultimoToqueHud = ahora;
  clearTimeout(toqueHud);
  toqueHud = setTimeout(salirHud, 1000);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('#hud').addEventListener(ev, () => clearTimeout(toqueHud)));

// ---------- Dificultad de senderos ----------
// Escala SAC de OpenStreetMap: verde fácil, azul montaña, rojo montaña exigente, negro alta montaña.
const DIFICULTADES = ['', 'Fácil (senderismo)', 'Montaña', 'Montaña exigente', 'Alta montaña', 'Alta montaña exigente', 'Alta montaña difícil'];
async function pintarSenderos() {
  const fuente = mapa.getSource('senderos-dif');
  if (!fuente) return;
  const datos = estado.mostrarDificultad ? await nav.senderos().catch(() => null) : null;
  fuente.setData(datos || { type: 'FeatureCollection', features: [] });
}
mapa.on('click', 'senderos-dif', (e) => {
  if (herramientaActiva() || nav.estaEligiendo()) return;
  const p = e.features[0].properties;
  avisar(`${p.n || 'Sendero'} · ${DIFICULTADES[p.d] || ''}`, { duracion: 5000 });
});

// ---------- Notas de voz en el track ----------
let grabacionVoz = null;
function tipoAudio() {
  const tipos = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
  return tipos.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}
function terminarFlujo(g) {
  clearInterval(g.reloj);
  clearTimeout(g.limite);
  g.flujo?.getTracks().forEach((t) => t.stop()); // suelta el micrófono siempre
}
async function iniciarNotaVoz() {
  if (grabador.estado !== 'grabando') return avisar('Las notas de voz se graban mientras grabas un track.');
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return avisar('Este iPhone no permite grabar audio desde la app. Actualiza iOS.');
  if (grabacionVoz) return detenerNotaVoz();
  let flujo;
  try {
    flujo = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (_) {
    return avisar('No pude usar el micrófono. Revisa en Ajustes que Rumbo (o Safari) tenga permiso.', { duracion: 7000 });
  }
  const p = gps.ultima;
  const tipo = tipoAudio();
  const rec = new MediaRecorder(flujo, tipo ? { mimeType: tipo } : undefined);
  const trozos = [];
  const g = { rec, flujo, inicio: Date.now(), lon: p?.coords.longitude, lat: p?.coords.latitude };
  grabacionVoz = g;
  rec.ondataavailable = (e) => { if (e.data?.size) trozos.push(e.data); };
  rec.onstop = async () => {
    terminarFlujo(g);
    grabacionVoz = null;
    const blob = new Blob(trozos, { type: rec.mimeType || tipo || 'audio/mp4' });
    if (blob.size && g.lon != null) {
      grabador.agregarNota({ lon: g.lon, lat: g.lat, t: g.inicio, dur: Math.round((Date.now() - g.inicio) / 1000), blob });
      avisar(`Nota de voz guardada en el track (${grabador.track?.notas?.length || 1}).`);
    } else avisar('La nota de voz quedó vacía o sin posición GPS.');
    if (hojaAbierta === 'voz') hojaTracks();
  };
  rec.onerror = () => { try { rec.stop(); } catch (_) { terminarFlujo(g); grabacionVoz = null; } };
  rec.start();
  g.limite = setTimeout(detenerNotaVoz, 60000); // máximo 1 minuto
  abrirHoja('voz', 'Nota de voz', `<div class="voz-grabando"><div class="voz-punto"></div><div id="voz-tiempo" class="voz-tiempo">0:00</div>
    <p class="nota">Habla cerca del iPhone. Máximo 1 minuto.</p>
    <div class="fila-botones"><button class="boton rojo" data-accion="nota-voz"><span data-icono="detener"></span>Detener y guardar</button></div></div>`);
  g.reloj = setInterval(() => {
    const s = Math.round((Date.now() - g.inicio) / 1000);
    const el = document.getElementById('voz-tiempo');
    if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}
function detenerNotaVoz() {
  const g = grabacionVoz;
  if (!g) return;
  try { if (g.rec.state !== 'inactive') g.rec.stop(); else { terminarFlujo(g); grabacionVoz = null; } } catch (_) { terminarFlujo(g); grabacionVoz = null; }
}
// Si se cierra la hoja o la app pasa a segundo plano, se detiene y se guarda (el micrófono nunca queda tomado).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') detenerNotaVoz(); });
const urlsNotas = new Map();
function urlNota(t, n) {
  const k = `${t.id}|${n.t}`;
  if (!urlsNotas.has(k)) urlsNotas.set(k, URL.createObjectURL(n.blob));
  return urlsNotas.get(k);
}

// ---------- Tarjeta para compartir el track ----------
async function tarjetaTrack(t) {
  const coords = t.segmentos.flat().map((p) => [p[0], p[1]]);
  if (coords.length < 2) return avisar('Este track tiene muy pocos puntos para armar la tarjeta.');
  avisar('Armando la tarjeta…', { duracion: 8000 });
  cerrarHoja();
  estado.trackVisto = t;
  pintarTrackVisto();
  fijarModo('libre');
  const lon = coords.map((c) => c[0]);
  const lat = coords.map((c) => c[1]);
  mapa.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  mapa.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]], { padding: 70, duration: 0, bearing: 0, pitch: 0, maxZoom: 16 });
  // En la tarjeta el recorrido va grueso y naranjo para que destaque.
  const ancho = mapa.getPaintProperty('track-visto', 'line-width');
  const color = mapa.getPaintProperty('track-visto', 'line-color');
  mapa.setPaintProperty('track-visto', 'line-width', 7);
  mapa.setPaintProperty('track-visto', 'line-color', '#ff7a00');
  await new Promise((res) => { mapa.once('idle', res); setTimeout(res, 8000); });
  const W = 1080, H = 1350, ALTO_MAPA = 900;
  const lienzo = document.createElement('canvas');
  lienzo.width = W;
  lienzo.height = H;
  const g = lienzo.getContext('2d');
  g.fillStyle = '#101418';
  g.fillRect(0, 0, W, H);
  // Mapa: se copia el lienzo del mapa justo después de dibujarse (recortado para llenar el área).
  await new Promise((res) => {
    mapa.once('render', () => {
      try {
        const m = mapa.getCanvas();
        const k = Math.max(W / m.width, ALTO_MAPA / m.height);
        const sw = W / k, sh = ALTO_MAPA / k;
        g.drawImage(m, (m.width - sw) / 2, (m.height - sh) / 2, sw, sh, 0, 0, W, ALTO_MAPA);
      } catch (_) { /* si el mapa no se puede copiar, queda el fondo */ }
      res();
    });
    mapa.triggerRepaint();
  });
  mapa.setPaintProperty('track-visto', 'line-width', ancho);
  mapa.setPaintProperty('track-visto', 'line-color', color);
  const deg = g.createLinearGradient(0, ALTO_MAPA - 160, 0, ALTO_MAPA + 10);
  deg.addColorStop(0, 'rgba(16,20,24,0)');
  deg.addColorStop(1, 'rgba(16,20,24,1)');
  g.fillStyle = deg;
  g.fillRect(0, ALTO_MAPA - 160, W, 170);
  // Mejor foto (la primera del track) en un círculo.
  const foto = t.fotos?.[0]?.blob;
  if (foto) {
    try {
      const bmp = await createImageBitmap(foto);
      const r = 150, cx = W - 60 - r, cy = 60 + r;
      g.save();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.closePath(); g.clip();
      const k = Math.max((2 * r) / bmp.width, (2 * r) / bmp.height);
      g.drawImage(bmp, cx - (bmp.width * k) / 2, cy - (bmp.height * k) / 2, bmp.width * k, bmp.height * k);
      g.restore();
      g.lineWidth = 10; g.strokeStyle = '#fff'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    } catch (_) { /* foto ilegible */ }
  }
  // Textos y cifras
  g.fillStyle = '#ffffff';
  g.font = '700 58px -apple-system, system-ui, sans-serif';
  const titulo = t.nombre.length > 30 ? `${t.nombre.slice(0, 29)}…` : t.nombre;
  g.fillText(titulo, 60, ALTO_MAPA + 40);
  g.fillStyle = '#a1a1aa';
  g.font = '400 34px -apple-system, system-ui, sans-serif';
  g.fillText(new Date(t.inicio).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), 60, ALTO_MAPA + 92);
  const cifras = [['Distancia', geo.fmtDistancia(t.distancia)], ['Desnivel', `+${geo.fmtAltitud(t.subida)}`], ['Tiempo', geo.fmtFalta(duracion(t))]];
  cifras.forEach(([etq, v], i) => {
    const x = 60 + i * 340;
    g.fillStyle = '#a1a1aa'; g.font = '500 30px -apple-system, system-ui, sans-serif'; g.fillText(etq.toUpperCase(), x, ALTO_MAPA + 170);
    g.fillStyle = '#ffffff'; g.font = '700 62px -apple-system, system-ui, sans-serif'; g.fillText(v, x, ALTO_MAPA + 240);
  });
  // Perfil de elevación
  const pf = perfil(t);
  if (pf.length > 1) {
    const x0 = 60, x1 = W - 60, y0 = H - 50, y1 = H - 120;
    const dMax = pf.at(-1)[0] || 1;
    const aMin = Math.min(...pf.map((p) => p[1])), aMax = Math.max(...pf.map((p) => p[1]));
    const rango = Math.max(aMax - aMin, 10);
    g.beginPath();
    pf.forEach(([d, a], i) => { const x = x0 + (d / dMax) * (x1 - x0); const y = y0 - ((a - aMin) / rango) * (y0 - y1); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.lineTo(x1, y0); g.lineTo(x0, y0); g.closePath();
    g.fillStyle = 'rgba(240,138,36,.35)'; g.fill();
    g.strokeStyle = '#f08a24'; g.lineWidth = 5; g.stroke();
  }
  g.fillStyle = '#71717a'; g.font = '600 28px -apple-system, system-ui, sans-serif'; g.textAlign = 'right';
  g.fillText('Rumbo GPS', W - 60, ALTO_MAPA + 40);
  const blob = await new Promise((res) => lienzo.toBlob(res, 'image/jpeg', 0.9));
  estado.tarjeta = new File([blob], `${t.nombre.replace(/[^\w\- ]+/g, '').trim() || 'track'}.jpg`, { type: 'image/jpeg' });
  $('#aviso').hidden = true;
  abrirHoja('tarjeta', 'Tarjeta para compartir', `<img class="foto-lugar" src="${URL.createObjectURL(blob)}" alt="Tarjeta del track">
    <div class="fila-botones"><button class="boton primario" data-accion="tarjeta-compartir"><span data-icono="compartir"></span>Compartir</button></div>
    <p class="nota">WhatsApp, Instagram, correo o «Guardar imagen» para dejarla en Fotos.</p>`);
}

// ---------- Desinstalar: borra todo lo guardado ----------
// Una app web no puede quitar su propio ícono de la pantalla de inicio (eso lo hace iOS), pero sí borrar
// todo lo que guardó. Después se explica cómo quitar el ícono.
async function desinstalar() {
  if (!confirm('¿Borrar TODO lo que Rumbo guardó en este iPhone?\n\nMapas, rutas, satélite, lugares, tracks, fotos, notas de voz, ficha médica y ajustes. No se puede deshacer.')) return;
  if (!confirm('Última confirmación: se borrará todo. ¿Continuar?')) return;
  avisar('Borrando todo…', { duracion: 60000 });
  try { if (estado.hud) salirHud(); if (estado.bolsillo) salirBolsillo(); } catch (_) { /* nada */ }
  try { nav.detenerGuia(); } catch (_) { /* nada */ }
  gps.detener?.();
  // Archivos grandes (mapas, rutas, relieve) en el almacenamiento privado de la app
  try {
    const raiz = await navigator.storage.getDirectory();
    for await (const nombre of raiz.keys()) await raiz.removeEntry(nombre, { recursive: true }).catch(() => {});
  } catch (_) { /* sin almacenamiento privado */ }
  // Base de datos (lugares, tracks, fotos, satélite, ajustes)
  try { await db.cerrar?.(); } catch (_) { /* nada */ }
  await new Promise((res) => { const r = indexedDB.deleteDatabase('rumbo'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  // Caché de la app y servicio sin conexión
  try { for (const k of await caches.keys()) await caches.delete(k); } catch (_) { /* nada */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch (_) { /* nada */ }
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) { /* nada */ }
  document.body.innerHTML = `<div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:28px;text-align:center;font:17px -apple-system,system-ui,sans-serif;background:#f2f2f7;color:#1c1c1e">
    <div style="font-size:54px">✓</div>
    <div style="font-size:22px;font-weight:700">Rumbo borró todo lo que tenía guardado</div>
    <div style="line-height:1.5">Para quitar el ícono: ve a la pantalla de inicio, <b>mantén el dedo sobre el ícono de Rumbo</b> y toca <b>«Eliminar app»</b> (o «Eliminar marcador»).</div>
    <div style="color:#6e6e73;font-size:15px">Si vuelves a abrirla, empezará desde cero y descargará la app de nuevo.</div></div>`;
}

// ---------- Respaldo liviano ----------
async function crearRespaldo() {
  pantalla.pedir('paquete');
  try {
    estado.respaldo = await paquete.crearPaquete({ soloDatos: true,
      alProgreso: (etapa) => avisar(`Preparando el respaldo: ${etapa}`, { duracion: 60000 }) });
    $('#aviso').hidden = true;
  } catch (e) {
    avisar(`No se pudo crear el respaldo: ${e.message}`, { duracion: 8000 });
  } finally {
    pantalla.soltar('paquete');
  }
  hojaMapas();
}

Object.assign(acciones, {
  hud: () => entrarHud(),
  'dificultad-senderos': async () => {
    estado.mostrarDificultad = !estado.mostrarDificultad;
    await ajustes.escribir('mostrarDificultad', estado.mostrarDificultad);
    pintarSenderos();
    if (hojaAbierta === 'mapas') hojaMapas(); else hojaCapas();
  },
  'nota-voz': () => (grabacionVoz ? detenerNotaVoz() : iniciarNotaVoz()),
  'tarjeta-track': async (id) => { const t = await db.obtener('tracks', id); if (t) tarjetaTrack(t); },
  'tarjeta-compartir': async () => {
    const f = estado.tarjeta;
    if (!f) return;
    try { await compartirArchivo(f.name, f, 'image/jpeg'); } catch (e) { avisar(`No se pudo compartir (${e.name}).`); }
  },
  'crear-respaldo': () => crearRespaldo(),
  'dictado-descargar': () => descargarDictado(),
  'dictado-hoja': () => hojaDictado(),
  'dictado-borrar': async () => {
    await dictado.borrar();
    estado.dictadoListo = false;
    await ajustes.escribir('dictadoListo', false);
    hojaMapas();
    avisar('Dictado sin conexión borrado.');
  },
  desinstalar: () => desinstalar(),
  'enviar-respaldo': async () => {
    const f = estado.respaldo?.archivo;
    if (!f) return;
    try { await navigator.share({ files: [f], title: f.name }); } catch (e) { if (e.name !== 'AbortError') avisar('No se pudo abrir Compartir. Usa «Guardar en Archivos».'); }
  },
  'guardar-respaldo': () => {
    const f = estado.respaldo?.archivo;
    if (!f) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
});

// ---------- Rutas y navegación ----------
const nav = crearNavegacion({
  mapa, gps, avisar, abrirHoja, cerrarHoja, fijarModo, centrarEnMiPosicion, pantalla, ajustes, mapas, esc, fila, mini, pintarIconos,
  hojaAbierta: () => hojaAbierta,
  lugares: () => estado.lugares,
  gpsEstado: () => estado.gps,
  relieve,
  refrescarMapas: () => hojaMapas(),
  alCargarRed: () => { pintarUtiles(); pintarSenderos(); },
  dibujarRuta: () => iniciarDibujo(),
  interruptor,
  alLlegarEnAuto: (p) => guardarAuto(p?.coords, { automatico: true }),
  pronostico: (p) => pedirPronostico(p),
  avisoSalida: (plan) => hojaAvisoSalida(plan),
});
iniciarCerros({ nav, relieve, brujula, gps, avisar, cerrarHoja, pantalla, esc });

// ---------- Service worker (funcionamiento sin conexión) ----------
// Actualizaciones: iOS "despierta" la app sin recargarla, así que se busca una versión nueva
// cada vez que vuelve a primer plano. Si llega una, se aplica sola cuando es seguro
// (sin navegar, sin grabar y sin una hoja abierta); si no, se ofrece con un aviso que no se va solo.
if ('serviceWorker' in navigator) {
  const habiaControlador = !!navigator.serviceWorker.controller;
  let registro = null;
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((r) => { registro = r; }).catch(() => {});
  const buscarVersion = () => { if (navigator.onLine) registro?.update().catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') buscarVersion(); });
  setInterval(buscarVersion, 30 * 60 * 1000);
  let pendiente = false;
  const aplicarSiSePuede = () => {
    if (!pendiente) return;
    if (!nav.navegando() && grabador.estado === 'detenido' && !hojaAbierta) location.reload();
    else avisar('Hay una versión nueva de Rumbo.', { accion: 'Actualizar', alAccion: () => location.reload(), duracion: 600000 });
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!habiaControlador) return;
    pendiente = true;
    aplicarSiSePuede();
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
  estado.ahorro = await ajustes.leer('ahorro', false);
  estado.mostrarRelieve = await ajustes.leer('mostrarRelieve', true);
  estado.mostrarCurvas = await ajustes.leer('mostrarCurvas', false);
  estado.alertasCercania = await ajustes.leer('alertasCercania', true);
  estado.salida = await ajustes.leer('salida', null);
  estado.luzEnMapa = await ajustes.leer('luzEnMapa', false);
  estado.vista3d = await ajustes.leer('vista3d', false);
  estado.pantallaSiempre = await ajustes.leer('pantallaSiempre', true);
  estado.dictadoListo = await ajustes.leer('dictadoListo', false);
  estado.mostrarDificultad = await ajustes.leer('mostrarDificultad', true);
  estado.hudEspejo = await ajustes.leer('hudEspejo', 0);
  if (estado.pantallaSiempre) pantalla.pedir('abierta');
  estado.auto = await ajustes.leer('autoEstacionado', null);
  estado.favoritos = await ajustes.leer('favoritos', {});
  estado.recientes = await ajustes.leer('recientes', []);
  estado.ficha = await ajustes.leer('fichaMedica', null);
  pintarAuto();
  if (estado.vista3d) { mapa.setMaxPitch(80); mapa.touchPitch.enable(); $('#btn-3d').classList.add('activo'); }
  actualizarChipLuz();
  gps.addEventListener('posicion', () => { if (estado.luzEnMapa && !estado.luzConGps) { estado.luzConGps = true; actualizarChipLuz(); } });
  aplicarAhorro();
  await relieve.cargar().catch(() => false);
  await mapas.limpiarHuerfanos();
  const lista = await mapas.listar();
  const idActivo = await ajustes.leer('mapaActivo', null);
  const activo = lista.find((m) => m.id === idActivo) || lista[0] || null;
  await activarMapa(activo, { encuadrar: !!activo && !vista });
  await cargarLugares();
  await grabador.restaurar();
  await nav.iniciarModulo();
  // Siempre te sigue desde que abres la app; la primera posición acerca el mapa a tu ubicación.
  estado.primeraPosicion = true;
  fijarModo('rumbo');
  gps.iniciar();
}
iniciar().catch((e) => avisar(`No se pudo iniciar: ${e.message}`, { duracion: 10000 }));
