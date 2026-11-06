// Rutas y navegación paso a paso sin conexión.
// Usa el motor de rutas (enrutador.js, en segundo plano) sobre la red .rutas instalada.
import * as geo from './geo.js';

const $ = (s) => document.querySelector(s);

// Íconos de maniobra (24×24, trazo).
const MANIOBRAS = {
  recto: '<path d="M12 21V5M6 11l6-6 6 6"/>',
  salida: '<path d="M12 21V5M6 11l6-6 6 6"/>',
  derecha: '<path d="M7 21v-8a4 4 0 0 1 4-4h8M15 5l4 4-4 4"/>',
  izquierda: '<path d="M17 21v-8a4 4 0 0 0-4-4H5M9 5L5 9l4 4"/>',
  'leve-derecha': '<path d="M9 21v-7l7-7M10 6h7v7"/>',
  'leve-izquierda': '<path d="M15 21v-7L8 7M14 6H7v7"/>',
  'cerrada-derecha': '<path d="M7 21V9a4 4 0 0 1 8 0v9M11 14l4 4 4-4"/>',
  'cerrada-izquierda': '<path d="M17 21V9a4 4 0 0 0-8 0v9M13 14l-4 4-4-4"/>',
  rotonda: '<circle cx="12" cy="9" r="4.5"/><path d="M12 21v-7.5M16.5 9H21M18.5 6.5 21 9l-2.5 2.5"/>',
  ferry: '<path d="M3 16l2 4h14l2-4zM6 16V9h12v7M12 4v5"/>',
  llegada: '<path d="M6 21V4M6 4h12l-3 4 3 4H6"/>',
  track: '<path d="M4 19c3-7 6 1 8-6s5-2 8-8"/><circle cx="4" cy="19" r="1.8" fill="currentColor"/><circle cx="20" cy="5" r="1.8" fill="currentColor"/>',
};
const iconoManiobra = (tipo) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${MANIOBRAS[tipo] || MANIOBRAS.recto}</svg>`;

function fmtTiempo(seg) {
  const min = Math.max(1, Math.round(seg / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
const fmtHora = (ms) => new Date(ms).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function distanciaHablada(m) {
  if (m >= 1000) return `${(Math.round(m / 100) / 10).toLocaleString('es-CL')} kilómetros`;
  const r = m >= 200 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10;
  return `${r} metros`;
}
const minuscula = (t) => t.charAt(0).toLowerCase() + t.slice(1);

export function crearNavegacion(ctx) {
  const { mapa, gps } = ctx;
  const st = {
    worker: null, listo: false, info: null, pendientes: new Map(), seq: 0,
    desde: { tipo: 'yo' }, hasta: null, perfil: 'auto',
    ruta: null, calculando: false, error: null, eligiendo: null,
    nav: null, voz: true, catalogo: null, descargando: null,
  };

  // ---------- Motor de rutas ----------
  function pedir(msg) {
    return new Promise((resolver, rechazar) => {
      const id = ++st.seq;
      st.pendientes.set(id, { resolver, rechazar });
      st.worker.postMessage({ ...msg, id });
    });
  }
  // Carga la red de rutas de la región que contiene el punto (o la primera instalada).
  async function cargarRed(punto = null) {
    const redes = await ctx.mapas.listarRutas();
    if (!redes.length) { st.listo = false; return false; }
    const dentro = (lim, p) => lim && p && p[0] >= lim[0] && p[0] <= lim[2] && p[1] >= lim[1] && p[1] <= lim[3];
    const red = redes.find((r) => dentro(r.limites, punto)) || redes.find((r) => r.id === st.redId) || redes[0];
    if (st.listo && red.id === st.redId) return true;
    st.listo = false;
    if (!st.worker) {
      st.worker = new Worker(new URL('./enrutador.js', import.meta.url));
      st.worker.onmessage = (e) => {
        const p = st.pendientes.get(e.data.id);
        if (!p) return;
        st.pendientes.delete(e.data.id);
        if (e.data.ok) p.resolver(e.data); else p.rechazar(new Error(e.data.error));
      };
    }
    const r = await pedir({ tipo: 'cargar', archivo: await ctx.mapas.archivoDe(red) });
    st.info = r.info;
    st.redId = red.id;
    st.listo = true;
    ctx.alCargarRed?.();
    return true;
  }

  async function catalogo() {
    if (st.catalogo) return st.catalogo;
    try {
      const r = await fetch('./datos/catalogo.json', { cache: 'no-store' });
      if (r.ok) st.catalogo = await r.json();
    } catch (_) { /* sin internet */ }
    return st.catalogo;
  }

  // ---------- Capas del mapa ----------
  const vacia = { type: 'FeatureCollection', features: [] };
  function agregarCapas() {
    if (!mapa.getSource('ruta')) mapa.addSource('ruta', { type: 'geojson', data: vacia });
    if (!mapa.getSource('ruta-puntos')) mapa.addSource('ruta-puntos', { type: 'geojson', data: vacia });
    const antes = mapa.getLayer('lugares-punto') ? 'lugares-punto' : undefined;
    mapa.addLayer({ id: 'ruta-borde', type: 'line', source: 'ruta', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1a4fbf', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 10, 18, 16] } }, antes);
    mapa.addLayer({ id: 'ruta', type: 'line', source: 'ruta', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#4f8dff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 6.5, 18, 11] } }, antes);
    mapa.addLayer({ id: 'ruta-puntos', type: 'circle', source: 'ruta-puntos',
      paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } }, antes);
    pintar();
  }
  function pintar() {
    const r = st.nav ? st.nav.ruta : st.ruta;
    let coords = r ? r.coords : [];
    if (st.nav && r && st.nav.enRuta) {
      const n = st.nav;
      const i = n.idxSeg;
      coords = [n.puntoActual, ...r.coords.slice(i + 1)];
    }
    mapa.getSource('ruta')?.setData(coords.length > 1
      ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} } : vacia);
    const pts = [];
    if (r) {
      if (!st.nav) pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: r.coords[0] }, properties: { color: '#30a46c' } });
      pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: r.coords[r.coords.length - 1] }, properties: { color: '#e5484d' } });
    }
    mapa.getSource('ruta-puntos')?.setData({ type: 'FeatureCollection', features: pts });
  }

  // ---------- Planificación ----------
  const etiqueta = (p) => {
    if (!p) return '';
    if (p.tipo === 'yo') return 'Mi ubicación';
    return p.nombre || geo.fmtCoordDecimal(p.lat, p.lon);
  };
  function coordsDe(p) {
    if (!p) return null;
    if (p.tipo === 'yo') {
      const c = gps.ultima?.coords;
      return c ? [c.longitude, c.latitude] : null;
    }
    return [p.lon, p.lat];
  }

  async function calcular({ encuadrar = true } = {}) {
    st.error = null;
    st.ruta = null;
    pintar();
    if (!st.hasta) return refrescar();
    const desde = coordsDe(st.desde);
    const hasta = coordsDe(st.hasta);
    if (!desde) {
      st.error = ctx.gpsEstado() === 'denegado'
        ? 'Rumbo no tiene permiso para usar tu ubicación. Actívala (botón de abajo) o elige otro punto de partida.'
        : 'Esperando señal GPS para usar tu ubicación como partida. Si tarda, revisa el permiso de ubicación (botón de abajo).';
      st.errorGps = true;
      ctx.gps.iniciar();
      return refrescar();
    }
    st.errorGps = false;
    if (!(await cargarRed(desde).catch(() => false))) { st.error = 'Primero instala las rutas sin conexión de tu región.'; return refrescar(); }
    st.calculando = true;
    refrescar();
    try {
      const r = await pedir({ tipo: 'ruta', desde, hasta, perfil: st.perfil });
      st.ruta = r.ruta;
      st.alturas = null;
      pintar();
      // Perfil de subidas y bajadas desde el relieve guardado (se calcula aparte para no demorar la ruta).
      if (ctx.relieve?.disponible()) {
        const ruta = st.ruta;
        ctx.relieve.perfil(ruta.coords, ruta.acum).then((p) => { if (st.ruta === ruta) { st.alturas = p; refrescar(); } }).catch(() => {});
      }
      if (encuadrar) verRutaCompleta(st.ruta, { abajo: Math.round(window.innerHeight * 0.55) });
    } catch (e) {
      st.error = e.message;
    } finally {
      st.calculando = false;
      refrescar();
    }
  }

  function verRutaCompleta(r, { abajo = 200 } = {}) {
    if (!r) return;
    const lon = r.coords.map((c) => c[0]);
    const lat = r.coords.map((c) => c[1]);
    ctx.fijarModo('libre', st.nav ? 15000 : 60000);
    mapa.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    mapa.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]],
      { padding: { top: 90, bottom: abajo, left: 40, right: 40 }, duration: 800, maxZoom: 16, bearing: 0 });
  }

  function refrescar() { if (ctx.hojaAbierta() === 'ruta') hojaRuta(); }

  // Horas de luz: avisa si llegarías (o, a pie, volverías) después de la puesta de sol.
  function notaLuz(r) {
    const [lon, lat] = r.coords[0];
    const ahora = new Date();
    const l = geo.luz(lon, lat, ahora);
    const llegada = new Date(ahora.getTime() + r.duracion * 1000);
    const vuelta = new Date(ahora.getTime() + 2 * r.duracion * 1000);
    if (!l.dia) {
      return `<p class="nota aviso-luz">Ya es de noche${l.salida ? `: el sol sale a las ${geo.fmtHora(l.salida)}` : ''}.</p>`;
    }
    if (!l.puesta) return '';
    const texto = `Quedan ${geo.fmtFalta(l.puesta - ahora)} de luz (puesta de sol ${geo.fmtHora(l.puesta)}).`;
    if (llegada > l.puesta) return `<p class="nota aviso-luz">⚠︎ Llegarías a las ${geo.fmtHora(llegada)}, después de la puesta de sol (${geo.fmtHora(l.puesta)}).</p>`;
    if (st.perfil === 'pie' && vuelta > l.puesta) {
      return `<p class="nota aviso-luz">${texto} Si vuelves por el mismo camino terminarías a las ${geo.fmtHora(vuelta)}, ya de noche.</p>`;
    }
    return `<p class="nota">☀︎ ${texto}</p>`;
  }

  async function hojaRuta() {
    const fila = ctx.fila;
    const mini = ctx.mini;
    if (!st.listo) await cargarRed().catch(() => false);
    if (!st.listo) {
      const cat = await catalogo();
      const paquete = cat?.find((p) => p.tipo === 'rutas');
      ctx.abrirHoja('ruta', 'Rutas', `
        <p class="nota">Para calcular rutas sin internet necesitas la red de caminos de tu región. Se descarga una vez y funciona en modo avión.</p>
        ${paquete ? `<div class="fila-botones"><button class="boton primario" data-accion="nav-descargar-red" data-id="${ctx.esc(paquete.archivo)}">
          <span data-icono="descargar"></span>Descargar ${ctx.esc(paquete.nombre)} (${geo.fmtBytes(paquete.bytes)})</button></div>`
        : '<p class="nota">Conéctate a internet para descargarla, o impórtala desde Mapas → Importar desde Archivos.</p>'}
        <div id="progreso-red" hidden><div class="barra-progreso"><div></div></div><div class="nota" id="progreso-red-texto"></div></div>`);
      return;
    }
    const perfilBtn = (p, ic, t) => `<button class="boton ${st.perfil === p ? 'primario' : ''}" data-accion="nav-perfil" data-id="${p}"><span data-icono="${ic}"></span>${t}</button>`;
    let resultado = '';
    if (st.calculando) resultado = '<p class="nota">Calculando la ruta…</p>';
    else if (st.error) {
      resultado = `<p class="nota" style="color:var(--rojo)">${ctx.esc(st.error)}</p>${st.errorGps
        ? '<div class="fila-botones"><button class="boton" data-accion="gps-ayuda">Activar la ubicación</button><button class="boton" data-accion="nav-recalcular">Reintentar</button></div>' : ''}`;
    }
    else if (st.ruta) {
      const r = st.ruta;
      const pasos = r.pasos.map((p) => fila({
        titulo: ctx.esc(p.texto),
        sub: p.tipo === 'salida' ? 'Inicio' : geo.fmtDistancia(p.distancia),
        extra: '',
        icono: null,
      }).replace('<div class="fila-texto">', `<span class="maniobra-mini">${iconoManiobra(p.tipo)}</span><div class="fila-texto">`)).join('');
      resultado = `
        <div class="estadisticas">
          <div class="estadistica"><div class="etiqueta">Distancia</div><div class="valor">${geo.fmtDistancia(r.distancia)}</div></div>
          <div class="estadistica"><div class="etiqueta">Tiempo</div><div class="valor">${fmtTiempo(r.duracion)}</div></div>
          <div class="estadistica"><div class="etiqueta">Llegada</div><div class="valor">${fmtHora(Date.now() + r.duracion * 1000)}</div></div>
        </div>
        ${st.alturas ? `<div class="grupo" style="padding:10px 12px;margin-bottom:10px">
          <div class="etiqueta">Subida ${geo.fmtAltitud(st.alturas.subida)} · Bajada ${geo.fmtAltitud(st.alturas.bajada)} · entre ${geo.fmtAltitud(st.alturas.min)} y ${geo.fmtAltitud(st.alturas.max)}</div>
          ${ctx.relieve.svgPerfil(st.alturas)}</div>` : ''}
        ${(() => {
    const ripio = (r.tramos || []).filter((t) => t[2] & 4).reduce((s, t) => s + (r.acum[t[1]] - r.acum[t[0]]), 0);
    return ripio > 200 ? `<p class="nota">Incluye ${geo.fmtDistancia(ripio)} de camino de ripio.</p>` : '';
  })()}
        ${notaLuz(r)}
        <div class="fila-botones" style="margin-bottom:6px">
          <button class="boton primario" data-accion="nav-iniciar"><span data-icono="rumbo"></span>Iniciar</button>
          <button class="boton" data-accion="nav-ver"><span data-icono="mapa"></span>Ver ruta</button>
        </div>
        <div class="fila-botones" style="margin-bottom:6px">
          <button class="boton" data-accion="nav-aviso-salida"><span data-icono="compartir"></span>Avisar mi salida por SMS</button>
        </div>
        ${st.desde.tipo !== 'yo' ? '<p class="nota">La guía empieza cuando llegues al punto de partida (verde).</p>' : ''}
        <div class="grupo-titulo">Indicaciones</div><div class="grupo">${pasos}</div>`;
    }
    ctx.abrirHoja('ruta', 'Ruta', `
      <div class="grupo">
        ${fila({ icono: 'ubicacion', color: 'verde', titulo: ctx.esc(etiqueta(st.desde)), sub: 'Desde',
          extra: `${mini('nav-desde-yo', 'seguir', 'Desde mi ubicación')}${mini('nav-elegir', 'pin', 'Elegir partida en el mapa', 'desde')}${mini('nav-lugares', 'mas', 'Partir desde un lugar guardado', 'desde')}` })}
        ${fila({ icono: 'pin', color: 'rojo', titulo: st.hasta ? ctx.esc(etiqueta(st.hasta)) : '<span style="color:var(--texto-2)">Elige el destino</span>', sub: 'Hasta',
          extra: `${mini('nav-elegir', 'pin', 'Elegir destino en el mapa', 'hasta')}${mini('nav-lugares', 'mas', 'Ir a un lugar guardado', 'hasta')}` })}
      </div>
      <div class="fila-botones" style="margin-bottom:12px">${perfilBtn('auto', 'auto', 'Auto')}${perfilBtn('pie', 'caminar', 'A pie')}
        <button class="boton chico" data-accion="nav-invertir" aria-label="Invertir partida y destino"><span data-icono="intercambiar"></span></button></div>
      ${st.hasta ? resultado : '<p class="nota">Toca el alfiler rojo para elegir el destino en el mapa, o el + para elegir uno de tus lugares. También puedes mantener el dedo sobre el mapa y tocar «Ir aquí».</p>'}`);
  }

  function hojaLugaresPara(cual) {
    const lugares = ctx.lugares();
    ctx.abrirHoja('ruta-lugar', cual === 'desde' ? 'Partir desde' : 'Ir a', lugares.length
      ? `<div class="grupo">${lugares.map((l) => ctx.fila({ icono: 'pin', color: 'rojo', titulo: ctx.esc(l.nombre), sub: geo.fmtCoordDecimal(l.lat, l.lon),
        accion: 'nav-elegir-lugar', id: `${cual}|${l.id}` })).join('')}</div>`
      : '<p class="nota">Aún no tienes lugares guardados.</p>');
  }

  function elegirEnMapa(cual) {
    st.eligiendo = cual;
    ctx.cerrarHoja();
    ctx.fijarModo('libre', 120000);
    ctx.avisar(cual === 'desde' ? 'Toca el mapa en el punto de partida' : 'Toca el mapa en tu destino', {
      accion: 'Cancelar', alAccion: () => { st.eligiendo = null; hojaRuta(); }, duracion: 120000,
    });
  }
  mapa.on('click', (e) => {
    if (!st.eligiendo) return;
    const cual = st.eligiendo;
    st.eligiendo = null;
    $('#aviso').hidden = true;
    st[cual] = { tipo: 'punto', lon: e.lngLat.lng, lat: e.lngLat.lat };
    hojaRuta();
    calcular();
  });

  // ---------- Navegación ----------
  function iniciar({ esTrack = false } = {}) {
    if (!st.ruta) return;
    st.nav = { ruta: st.ruta, idxSeg: 0, progreso: 0, enRuta: !esTrack && st.desde.tipo === 'yo', fuera: 0, ultimoRecalculo: 0,
      anunciados: new Set(), puntoActual: st.ruta.coords[0], llegado: false, hora0: Date.now(), esTrack, excesos: 0, ultimoAvisoVel: 0 };
    document.body.classList.add('navegando');
    $('#nav-banner').hidden = false;
    $('#nav-panel').hidden = false;
    ctx.cerrarHoja();
    ctx.pantalla.pedir('navegacion');
    ctx.fijarModo('rumbo');
    // Acerca a nivel de calle (escala ~30 m) para ver bien dónde estás.
    ctx.centrarEnMiPosicion({ silencioso: true });
    actualizarBotonVoz();
    const primero = st.nav.ruta.pasos[0];
    hablar(esTrack ? 'Siguiendo el track.' : st.nav.enRuta ? `${primero.texto}.` : 'Dirígete al punto de partida de la ruta.');
    if (gps.ultima) alPosicion(gps.ultima); else actualizarPantalla();
    pintar();
  }

  function terminar({ silencioso = false } = {}) {
    st.nav = null;
    document.body.classList.remove('navegando');
    $('#nav-banner').hidden = true;
    $('#nav-panel').hidden = true;
    $('#limite').hidden = true;
    $('#nav-aviso').hidden = true;
    $('#velocimetro').classList.remove('exceso');
    ctx.pantalla.soltar('navegacion');
    if (!silencioso && 'speechSynthesis' in window) speechSynthesis.cancel();
    st.ruta = null;
    st.hasta = null;
    st.desde = { tipo: 'yo' };
    pintar();
  }

  function proyectar(r, lon, lat, i0, i1) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180);
    let mejor = { i: i0, t: 0, d: Infinity };
    for (let i = Math.max(0, i0); i <= Math.min(r.coords.length - 2, i1); i++) {
      const a = r.coords[i], b = r.coords[i + 1];
      const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * 110540;
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * 110540;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < mejor.d) mejor = { i, t, d };
    }
    return mejor;
  }

  function alPosicion(p) {
    const n = st.nav;
    if (!n || n.llegado) return;
    const r = n.ruta;
    const { longitude: lon, latitude: lat, accuracy } = p.coords;
    const umbral = n.esTrack ? Math.max(25, Math.min(60, (accuracy || 15) * 1.5)) : Math.max(30, Math.min(80, (accuracy || 20) * 1.5));
    let pr = proyectar(r, lon, lat, n.idxSeg - 3, n.idxSeg + 400);
    if (pr.d > umbral && !(n.esTrack && n.enRuta)) pr = proyectar(r, lon, lat, 0, r.coords.length - 2);
    n.distTrack = pr.d;
    n.puntoCercano = pr;
    if (pr.d <= umbral) {
      if (!n.enRuta && !n.esTrack) hablar(`${r.pasos[0].texto}.`);
      if (n.esTrack && n.fueraAvisado) { hablar('De vuelta en el track.'); n.fueraAvisado = false; }
      if (n.esTrack && !n.enRuta) hablar('Estás sobre el track. Síguelo.');
      n.enRuta = true;
      n.fuera = 0;
      n.idxSeg = pr.i;
      const a = r.coords[pr.i], b = r.coords[pr.i + 1];
      n.puntoActual = [a[0] + pr.t * (b[0] - a[0]), a[1] + pr.t * (b[1] - a[1])];
      n.progreso = r.acum[pr.i] + pr.t * (r.acum[pr.i + 1] - r.acum[pr.i]);
    } else if (n.enRuta) {
      n.fuera++;
      if (n.esTrack) {
        // En un track no se recalcula: se avisa que te saliste y hacia dónde volver.
        if (n.fuera >= 2 && !n.fueraAvisado) {
          n.fueraAvisado = true;
          navigator.vibrate?.([200, 100, 200]);
          hablar(`Te saliste del track. Vuelve hacia el ${nombreRumbo(rumboHacia(p, r, pr))}.`);
        }
      } else if (n.fuera >= 3 && Date.now() - n.ultimoRecalculo > 8000) recalcular([lon, lat]);
    }
    if (n.enRuta && r.distancia - n.progreso < (n.esTrack ? 30 : 20) && n.fuera === 0) return llegar();
    actualizarPantalla(p);
    anunciar(p);
    revisarTramo(p);
    pintar();
  }

  // Rumbo desde tu posición hasta el punto más cercano del track.
  function rumboHacia(p, r, pr) {
    const a = r.coords[pr.i], b = r.coords[pr.i + 1] || a;
    const destino = [a[0] + pr.t * (b[0] - a[0]), a[1] + pr.t * (b[1] - a[1])];
    return geo.azimut(p.coords.longitude, p.coords.latitude, destino[0], destino[1]);
  }
  const nombreRumbo = (g) => ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'][Math.round(((g % 360) + 360) % 360 / 45) % 8];

  // Tramo actual de la ruta: límite de velocidad y ripio (si la red de caminos lo trae).
  function tramoEn(r, idx) {
    if (!r.tramos) return null;
    return r.tramos.find((t) => idx >= t[0] && idx < t[1]) || null;
  }
  function revisarTramo(p) {
    const n = st.nav;
    if (!n || n.esTrack || !n.enRuta) return;
    const r = n.ruta;
    const t = tramoEn(r, n.idxSeg);
    // Límite de velocidad
    const max = t && t[3] ? t[3] : 0;
    $('#limite').hidden = !max;
    if (max) $('#limite-valor').textContent = max;
    const kmh = (p.coords.speed || 0) * 3.6;
    const exceso = max && kmh > max + 5;
    n.excesos = exceso ? n.excesos + 1 : 0;
    $('#velocimetro').classList.toggle('exceso', n.excesos >= 2);
    if (n.excesos === 2 && Date.now() - n.ultimoAvisoVel > 60000) {
      n.ultimoAvisoVel = Date.now();
      hablar(`Cuidado: el límite es ${max} kilómetros por hora.`);
    }
    // Ripio: aviso al entrar y cartel mientras dure
    const enRipio = t && (t[2] & 4);
    $('#nav-aviso').hidden = !enRipio;
    if (enRipio) $('#nav-aviso').textContent = 'Camino de ripio';
    if (!enRipio && r.tramos) {
      const prox = r.tramos.find((x) => (x[2] & 4) && x[0] > n.idxSeg && r.acum[x[0]] - n.progreso < 400);
      if (prox && !n.anunciados.has(`ripio:${prox[0]}`)) {
        n.anunciados.add(`ripio:${prox[0]}`);
        hablar(`Atención: en ${distanciaHablada(r.acum[prox[0]] - n.progreso)} comienza un tramo de ripio.`);
      }
    }
  }

  // Seguir un track (por ejemplo, un GPX importado): guía por el camino y avisa si te sales.
  function seguirTrack(coords, nombre) {
    if (coords.length < 2) return ctx.avisar('Ese track no tiene suficientes puntos para seguirlo.');
    const acum = [0];
    for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + geo.distancia(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    const distancia = acum[acum.length - 1];
    st.ruta = {
      coords, acum, distancia, duracion: distancia / (4.2 / 3.6), perfil: 'pie', tramos: null,
      pasos: [
        { tipo: 'salida', idx: 0, distancia: 0, texto: `Sigue el track ${nombre}` },
        { tipo: 'llegada', idx: coords.length - 1, distancia, texto: 'Fin del track' },
      ],
    };
    st.desde = { tipo: 'punto', lon: coords[0][0], lat: coords[0][1], nombre: 'Inicio del track' };
    st.hasta = { tipo: 'punto', lon: coords.at(-1)[0], lat: coords.at(-1)[1], nombre: `Fin de ${nombre}` };
    iniciar({ esTrack: true });
  }

  async function recalcular(desde) {
    const n = st.nav;
    n.ultimoRecalculo = Date.now();
    hablar('Recalculando.');
    $('#nav-texto').textContent = 'Recalculando…';
    try {
      const res = await pedir({ tipo: 'ruta', desde, hasta: coordsDe(st.hasta), perfil: st.perfil });
      if (st.nav !== n) return;
      Object.assign(n, { ruta: res.ruta, idxSeg: 0, progreso: 0, enRuta: true, fuera: 0, anunciados: new Set(), puntoActual: res.ruta.coords[0] });
      st.ruta = res.ruta;
      pintar();
      actualizarPantalla();
    } catch (e) {
      ctx.avisar(`No se pudo recalcular: ${e.message}`, { duracion: 5000 });
    }
  }

  function llegar() {
    const n = st.nav;
    n.llegado = true;
    hablar(n.esTrack ? 'Llegaste al final del track.' : 'Llegaste a tu destino.');
    $('#nav-icono').innerHTML = iconoManiobra('llegada');
    $('#nav-distancia').textContent = 'Llegaste';
    $('#nav-texto').textContent = etiqueta(st.hasta) || 'Tu destino';
    $('#nav-luego').hidden = true;
    setTimeout(() => { if (st.nav === n) terminar({ silencioso: true }); }, 6000);
  }

  function siguientePaso() {
    const n = st.nav;
    const pasos = n.ruta.pasos;
    for (let i = 0; i < pasos.length; i++) {
      if (pasos[i].tipo === 'salida') continue;
      if (pasos[i].distancia > n.progreso + 3) return i;
    }
    return pasos.length - 1;
  }

  function actualizarPantalla(p) {
    const n = st.nav;
    if (!n) return;
    const r = n.ruta;
    if (n.esTrack && (!n.enRuta || n.fuera >= 2)) {
      // Fuera del track: distancia y dirección para volver (o para llegar a él al empezar).
      const c = p?.coords || gps.ultima?.coords;
      $('#nav-icono').innerHTML = iconoManiobra('track');
      $('#nav-distancia').textContent = n.distTrack != null && isFinite(n.distTrack) ? geo.fmtDistancia(n.distTrack) : '—';
      $('#nav-texto').textContent = c && n.puntoCercano
        ? `${n.enRuta ? 'Te saliste: vuelve' : 'Ve'} al track hacia el ${nombreRumbo(rumboHacia({ coords: c }, r, n.puntoCercano))}`
        : 'Buscando tu posición…';
      $('#nav-luego').hidden = true;
    } else if (n.esTrack) {
      $('#nav-icono').innerHTML = iconoManiobra('track');
      $('#nav-distancia').textContent = geo.fmtDistancia(Math.max(0, r.distancia - n.progreso));
      $('#nav-texto').textContent = 'Sigue el track hasta el final';
      $('#nav-luego').hidden = true;
    } else if (!n.enRuta) {
      const c = p?.coords || gps.ultima?.coords;
      const d = c ? geo.distancia(c.longitude, c.latitude, r.coords[0][0], r.coords[0][1]) : null;
      $('#nav-icono').innerHTML = iconoManiobra('salida');
      $('#nav-distancia').textContent = d != null ? geo.fmtDistancia(d) : '—';
      $('#nav-texto').textContent = 'Dirígete al inicio de la ruta (punto verde)';
      $('#nav-luego').hidden = true;
    } else {
      const i = siguientePaso();
      const paso = r.pasos[i];
      $('#nav-icono').innerHTML = iconoManiobra(paso.tipo);
      $('#nav-distancia').textContent = geo.fmtDistancia(Math.max(0, paso.distancia - n.progreso));
      $('#nav-texto').textContent = paso.texto;
      const luego = r.pasos[i + 1];
      const verLuego = luego && luego.distancia - paso.distancia < 400;
      $('#nav-luego').hidden = !verLuego;
      if (verLuego) $('#nav-luego').innerHTML = `Luego ${iconoManiobra(luego.tipo)}`;
    }
    const restante = Math.max(0, r.distancia - n.progreso);
    const segs = r.duracion * (restante / (r.distancia || 1));
    $('#nav-restante').textContent = geo.fmtDistancia(restante);
    $('#nav-tiempo').textContent = fmtTiempo(segs);
    $('#nav-llegada').textContent = fmtHora(Date.now() + segs * 1000);
    $('#nav-progreso').style.width = `${Math.round((n.progreso / (r.distancia || 1)) * 100)}%`;
  }

  // Avisos por voz antes de cada maniobra (lejos, cerca y en el momento).
  function anunciar(p) {
    const n = st.nav;
    if (!n || !n.enRuta) return;
    const i = siguientePaso();
    const paso = n.ruta.pasos[i];
    const d = paso.distancia - n.progreso;
    const v = p?.coords?.speed || 0;
    const niveles = st.perfil === 'pie' ? [[150, 'lejos'], [25, 'ahora']]
      : [[v > 20 ? 1500 : 800, 'lejos'], [v > 14 ? 400 : 250, 'cerca'], [v > 14 ? 90 : 45, 'ahora']];
    let nivel = null;
    for (const [m, nombre] of niveles) if (d <= m) nivel = nombre;
    if (!nivel) return;
    const k = `${i}:${nivel}`;
    if (n.anunciados.has(k)) return;
    // Al llegar a un nivel se dan por hechos los anteriores.
    for (const [, nombre] of niveles) { n.anunciados.add(`${i}:${nombre}`); if (nombre === nivel) break; }
    if (paso.tipo === 'llegada') hablar(nivel === 'ahora' ? 'Estás llegando a tu destino.' : `En ${distanciaHablada(d)}, llegarás a tu destino.`);
    else if (nivel === 'ahora') hablar(`${paso.texto}.`);
    else hablar(`En ${distanciaHablada(d)}, ${minuscula(paso.texto)}.`);
  }

  // ---------- Voz ----------
  function vozEspanol() {
    const vs = 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
    return vs.find((v) => v.lang === 'es-CL') || vs.find((v) => /^es-(419|MX|US|AR|CO)/.test(v.lang)) || vs.find((v) => v.lang.startsWith('es'));
  }
  function hablar(texto) {
    if (!st.voz || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = 'es-CL';
    const v = vozEspanol();
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
  function actualizarBotonVoz() {
    const b = $('#nav-voz');
    if (b) b.innerHTML = `<span data-icono="${st.voz ? 'voz' : 'silencio'}"></span>${st.voz ? 'Voz' : 'Silencio'}`;
    ctx.pintarIconos(b?.parentElement || document);
  }

  // ---------- Descarga de la red ----------
  async function descargarRed(ruta) {
    if (st.descargando) return;
    st.descargando = true;
    const caja = $('#progreso-red');
    if (caja) caja.hidden = false;
    try {
      const nombre = 'rutas';
      await ctx.mapas.instalar({ url: new URL(ruta, document.baseURI).href }, nombre, (hecho, total) => {
        const barra = $('#progreso-red .barra-progreso > div');
        const txt = $('#progreso-red-texto');
        if (barra && total) barra.style.width = `${Math.round((hecho / total) * 100)}%`;
        if (txt) txt.textContent = `Descargando: ${geo.fmtBytes(hecho)}${total ? ` de ${geo.fmtBytes(total)}` : ''}…`;
      });
      await ctx.mapas.pedirPersistencia();
      await cargarRed();
      ctx.avisar('Rutas sin conexión listas.');
    } catch (e) {
      ctx.avisar(e.message, { duracion: 7000 });
    } finally {
      st.descargando = false;
      refrescar();
      if (ctx.hojaAbierta() === 'mapas') ctx.refrescarMapas?.();
    }
  }

  // ---------- Acciones (botones con data-accion="nav-…") ----------
  async function accion(nombre, id) {
    switch (nombre) {
      case 'nav-descargar-red': return descargarRed(id);
      case 'nav-perfil': st.perfil = id; await ctx.ajustes.escribir('perfil', id); return calcular();
      case 'nav-desde-yo': st.desde = { tipo: 'yo' }; return calcular();
      case 'nav-elegir': return elegirEnMapa(id);
      case 'nav-lugares': return hojaLugaresPara(id);
      case 'nav-elegir-lugar': {
        const [cual, lid] = id.split('|');
        const l = ctx.lugares().find((x) => x.id === lid);
        if (l) st[cual] = { tipo: 'punto', lon: l.lon, lat: l.lat, nombre: l.nombre };
        hojaRuta();
        return calcular();
      }
      case 'nav-invertir': {
        if (!st.hasta) return undefined;
        [st.desde, st.hasta] = [st.hasta, st.desde];
        if (st.hasta.tipo === 'yo') { const c = gps.ultima?.coords; st.hasta = c ? { tipo: 'punto', lon: c.longitude, lat: c.latitude, nombre: 'Mi ubicación al planificar' } : null; }
        return calcular();
      }
      case 'nav-iniciar': return iniciar();
      case 'nav-aviso-salida': {
        const r = st.ruta;
        return ctx.avisoSalida(r ? { destino: etiqueta(st.hasta), lon: r.coords.at(-1)[0], lat: r.coords.at(-1)[1], duracion: r.duracion } : null);
      }
      case 'nav-recalcular': return calcular();
      case 'nav-ver': ctx.cerrarHoja(); return verRutaCompleta(st.ruta);
      case 'nav-general': return verRutaCompleta(st.nav?.ruta, { abajo: 220 });
      case 'nav-terminar': return terminar();
      case 'nav-voz':
        st.voz = !st.voz;
        await ctx.ajustes.escribir('voz', st.voz);
        if (!st.voz && 'speechSynthesis' in window) speechSynthesis.cancel();
        return actualizarBotonVoz();
      default: return undefined;
    }
  }

  return {
    async iniciarModulo() {
      st.perfil = await ctx.ajustes.leer('perfil', 'auto');
      st.voz = await ctx.ajustes.leer('voz', true);
      cargarRed().catch(() => {});
    },
    cargarRed,
    agregarCapas,
    hojaRuta,
    accion,
    alPosicion,
    estaEligiendo: () => !!st.eligiendo,
    perfil: () => st.perfil,
    navegando: () => !!st.nav,
    seguirTrack,
    catalogo,
    tieneRed: () => st.listo,
    utiles: () => (st.listo && st.info?.utiles) || [],
    hablar: (texto) => hablar(texto),
    // Ruta planificada (para el aviso de salida y las horas de luz).
    rutaPlanificada: () => (st.ruta && st.hasta ? { destino: etiqueta(st.hasta), lon: st.ruta.coords.at(-1)[0], lat: st.ruta.coords.at(-1)[1],
      duracion: st.ruta.duracion, perfil: st.perfil } : null),
    async buscar(texto, cerca) {
      if (!(await cargarRed(cerca).catch(() => false))) return [];
      return (await pedir({ tipo: 'buscar', texto, cerca })).resultados;
    },
    irA(punto) { st.hasta = { tipo: 'punto', ...punto }; if (!st.desde) st.desde = { tipo: 'yo' }; hojaRuta(); calcular(); },
    salirDesde(punto) { st.desde = { tipo: 'punto', ...punto }; hojaRuta(); calcular(); },
  };
}
