import { pintarIconos, icono } from './iconos.js';
import { db, ajustes, nuevoId } from './db.js';
import * as geo from './geo.js';
import { Gps, Brujula, PantallaEncendida } from './sensores.js';
import * as mapas from './mapas.js';
import * as sat from './satelite.js';
import { crearNavegacion } from './navegacion.js';
import * as paquete from './paquete.js';
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
  paquete: null, // { archivo: File, resumen } listo para enviar a otro iPhone
  gps: 'buscando', // buscando | ok | denegado
  modo: 'rumbo', // rumbo: te sigue y gira con tu dirección | libre: pausa breve mientras miras otra zona
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
      layout: { 'text-field': ['get', 'nombre'], 'text-font': ['Noto Sans Medium'], 'text-size': 15, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#a8292d', 'text-halo-color': '#fff', 'text-halo-width': 2.2, 'text-halo-blur': 0.3 } });
  }
  pintarLugares();
  pintarTrackActual();
  pintarTrackVisto();
  nav.agregarCapas();
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
  const ms = ultimaFix ? Math.min(1200, Math.max(300, ahora - ultimaFix)) : 0;
  ultimaFix = ahora;
  moverPuck([lon, lat], ms);
  if (!puckEnMapa) { puck.addTo(mapa); puckEnMapa = true; }
  puckEl.classList.remove('sin-senal');
  mapa.getSource('precision')?.setData(geo.circulo(lon, lat, accuracy));
  $('#dato-altitud').textContent = geo.fmtAltitud(altitude);
  $('#dato-precision').textContent = `±${Math.round(accuracy)} m`;
  $('#velocimetro').hidden = false;
  $('#velocimetro-valor').textContent = speed == null || speed < 0.5 ? '0' : Math.round(speed * 3.6);
  actualizarRumbo();
  grabador.agregar(p);
  nav.alPosicion(p);
  if (estado.modo !== 'libre') {
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
      duration: estado.primeraPosicion ? 900 : ms || 600,
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
  pantalla.pedir('seguir');
  // Al ir a un lugar, track o zona se quita el margen de la vista conducción para centrarlo bien.
  if (modo === 'libre' && volverEn === VOLVER_TRAS_ACCION_MS) mapa.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  if (modo === 'libre') {
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
    features: estado.lugares.map((l) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon, l.lat] }, properties: { id: l.id, nombre: l.nombre } })),
  });
}

let pulsacion = null;
const cancelarPulsacion = () => { clearTimeout(pulsacion); pulsacion = null; };
mapa.on('touchstart', (e) => {
  cancelarPulsacion();
  if (e.originalEvent.touches.length !== 1) return;
  const { lng, lat } = e.lngLat;
  pulsacion = setTimeout(() => { pulsacion = null; if (nav.estaEligiendo()) return; navigator.vibrate?.(15); hojaNuevoLugar(lng, lat, null); }, 650);
});
['touchend', 'touchmove', 'touchcancel', 'movestart', 'zoomstart'].forEach((ev) => mapa.on(ev, cancelarPulsacion));
mapa.on('contextmenu', (e) => { if (!nav.estaEligiendo()) hojaNuevoLugar(e.lngLat.lng, e.lngLat.lat, null); });
mapa.on('click', 'lugares-punto', (e) => {
  if (nav.estaEligiendo() || nav.navegando()) return;
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
    avisar(geo.fmtCoordDecimal(c.lat, c.lon), { accion: 'Opciones', alAccion: () => hojaNuevoLugar(c.lon, c.lat, null), duracion: 8000 });
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
    <div class="grupo-titulo">Rutas sin conexión</div>
    ${redes.length ? `<div class="grupo">${redes.map((r) => fila({ icono: 'ruta', color: 'azul', titulo: esc(r.nombre),
      sub: `${geo.fmtBytes(r.bytes)} · caminos de OpenStreetMap del ${esc(r.generado || '')}`,
      extra: mini('borrar-red', 'basura', 'Borrar rutas sin conexión', r.id, true) })).join('')}</div>`
    : `<p class="nota">Descarga la red de caminos de tu región para calcular rutas y navegar sin internet.</p>
       <div class="fila-botones" style="margin-bottom:6px"><button class="boton" data-accion="abrir-ruta"><span data-icono="ruta"></span>Obtener rutas sin conexión</button></div>`}
    <div class="grupo-titulo">Satélite sin conexión</div>
    ${zonas.length ? `<div class="grupo">${filasZonas}</div>` : '<p class="nota">Descarga imágenes satelitales de las zonas que vas a recorrer para verlas sin señal.</p>'}
    <div class="fila-botones"><button class="boton" data-accion="abrir-descarga-sat"><span data-icono="globo"></span>${estado.descargaSat ? 'Ver descarga en curso' : 'Descargar satélite'}</button></div>
    <div class="grupo-titulo">Descargar con internet</div>
    <input class="campo" id="url-mapa" type="url" inputmode="url" placeholder="https://…/magallanes.pmtiles" autocapitalize="off" autocorrect="off">
    <div class="fila-botones"><button class="boton" data-accion="descargar-mapa"><span data-icono="descargar"></span>Descargar</button></div>
    <p class="nota">${esp ? `Usando ${geo.fmtBytes(esp.usado)} de ${geo.fmtBytes(esp.cuota)} disponibles. ` : ''}${esp?.persistente ? 'Almacenamiento protegido: iOS no borrará tus mapas por falta de espacio.' : 'Los mapas quedan guardados dentro de la app y no requieren conexión.'}</p>
    <div class="grupo-titulo">Pasar todo a otro iPhone</div>
    <p class="nota">Crea un solo archivo con todo lo descargado (mapas, rutas, satélite, lugares y tracks) y envíalo por WhatsApp, correo, AirDrop o iCloud Drive. En el otro iPhone se guarda en Archivos y se instala con «Importar desde Archivos», sin descargar nada.</p>
    ${estado.paquete
    ? `<p class="nota">Paquete listo: ${geo.fmtBytes(estado.paquete.archivo.size)} · ${estado.paquete.resumen.mapas} mapa(s), ${estado.paquete.resumen.rutas ? 'rutas, ' : ''}${estado.paquete.resumen.teselas.toLocaleString('es-CL')} imágenes satelitales, ${estado.paquete.resumen.lugares} lugares y ${estado.paquete.resumen.tracks} tracks${estado.paquete.resumen.clave ? ' y Satélite HD listo (incluye tu clave)' : ''}.</p>
       <div class="fila-botones" style="margin-bottom:6px"><button class="boton primario" data-accion="enviar-paquete"><span data-icono="compartir"></span>Enviar paquete (${geo.fmtBytes(estado.paquete.archivo.size)})</button></div>
       <div class="fila-botones" style="margin-bottom:6px"><button class="boton" data-accion="guardar-paquete"><span data-icono="importar"></span>Guardar en Archivos</button></div>
       <p class="nota">WhatsApp acepta archivos de hasta 2 GB. El correo normal admite unos 20 MB; con Mail Drop de iCloud (la app Correo lo ofrece sola) hasta 5 GB.</p>`
    : '<div class="fila-botones" style="margin-bottom:6px"><button class="boton" data-accion="crear-paquete"><span data-icono="importar"></span>Crear paquete para otro iPhone</button></div>'}
    <div class="grupo-titulo">Aplicación</div>
    <div class="grupo">${fila({ titulo: `Versión del ${esc(await versionApp())}`, sub: 'Rumbo se actualiza sola al abrirla con internet',
      extra: '<button class="boton chico" data-accion="buscar-actualizacion">Buscar</button>' })}</div>`);
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
    } else {
      await activarMapa(m, { encuadrar: true });
      avisar(`Mapa «${nombre}» listo para usar sin conexión.`);
    }
  } catch (e) {
    avisar(e.message, { duracion: 7000 });
  }
  if (hojaAbierta === 'mapas') hojaMapas();
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
    const cabeza = new TextDecoder().decode(await f.slice(0, 8).arrayBuffer());
    if (!cabeza.startsWith('PMTiles') && cabeza !== 'RUMBORUT') {
      return avisar(`«${f.name}» no es un paquete de Rumbo (.rumbo) ni un mapa (.pmtiles). Elige el archivo que te enviaron.`, { duracion: 10000 });
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
// Punto elegido en el mapa (dedo mantenido o búsqueda): ir, salir desde ahí o guardarlo.
function hojaNuevoLugar(lon, lat, ele) {
  estado.nuevoLugar = { lon, lat, ele };
  abrirHoja('nuevo-lugar', 'Punto elegido', `
    <p class="nota">${geo.fmtCoordDecimal(lat, lon)}${ele != null ? ` · ${geo.fmtAltitud(ele)}` : ''}</p>
    <div class="fila-botones" style="margin-bottom:16px">
      <button class="boton primario" data-accion="ir-aqui"><span data-icono="ruta"></span>Ir aquí</button>
      <button class="boton" data-accion="salir-desde-aqui"><span data-icono="seguir"></span>Salir desde aquí</button>
    </div>
    <div class="grupo-titulo">Guardar como lugar</div>
    <input class="campo" id="nombre-lugar" maxlength="60" value="Lugar ${estado.lugares.length + 1}" aria-label="Nombre del lugar">
    <div class="fila-botones"><button class="boton rojo" data-accion="confirmar-lugar"><span data-icono="pin"></span>Guardar lugar</button></div>`);
}
function hojaLugar(l) {
  abrirHoja('lugar', esc(l.nombre), `
    <div class="grupo">
      ${fila({ titulo: geo.fmtCoordDecimal(l.lat, l.lon), sub: geo.fmtCoordGMS(l.lat, l.lon) })}
      ${fila({ titulo: `<span data-dist="${l.id}">${subLugar(l)}</span>`, sub: 'Distancia y rumbo desde tu posición' })}
      ${l.ele != null ? fila({ titulo: geo.fmtAltitud(l.ele), sub: 'Altitud' }) : ''}
      ${fila({ titulo: new Date(l.creado).toLocaleString('es-CL', { dateStyle: 'long', timeStyle: 'short' }), sub: 'Guardado' })}
    </div>
    <div class="fila-botones" style="margin-bottom:10px">
      <button class="boton primario" data-accion="como-llegar" data-id="${l.id}"><span data-icono="ruta"></span>Cómo llegar</button>
      <button class="boton" data-accion="ir-lugar" data-id="${l.id}"><span data-icono="ver"></span>Ver en mapa</button>
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
  'abrir-ruta': () => nav.hojaRuta(),
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
  'ir-aqui': () => { const n = estado.nuevoLugar; if (n) nav.irA({ lon: n.lon, lat: n.lat }); },
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

// ---------- Rutas y navegación ----------
const nav = crearNavegacion({
  mapa, gps, avisar, abrirHoja, cerrarHoja, fijarModo, centrarEnMiPosicion, pantalla, ajustes, mapas, esc, fila, mini, pintarIconos,
  hojaAbierta: () => hojaAbierta,
  lugares: () => estado.lugares,
  gpsEstado: () => estado.gps,
});

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
