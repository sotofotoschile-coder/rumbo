// Dictado sin conexión: graba unos segundos con el micrófono, detecta cuando terminas de hablar y lo convierte
// en texto dentro del iPhone (Whisper). No usa el reconocimiento de voz del navegador, que puede colgarse en iOS.
let worker = null;
let seq = 0;
let apagar = null;
const pendientes = new Map();

function obtenerWorker() {
  clearTimeout(apagar);
  // Se apaga tras 90 s sin uso: el modelo ocupa bastante memoria y Rumbo no debe arriesgar el GPS.
  apagar = setTimeout(() => { worker?.terminate(); worker = null; }, 90000);
  if (worker) return worker;
  worker = new Worker(new URL('./dictado-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pendientes.get(e.data.id);
    if (!p) return;
    if (e.data.tipo === 'progreso') return p.alProgreso?.(e.data.hecho, e.data.total);
    pendientes.delete(e.data.id);
    if (e.data.tipo === 'error') p.rechazar(new Error(e.data.error)); else p.resolver(e.data);
  };
  worker.onerror = (e) => { for (const p of pendientes.values()) p.rechazar(new Error(e.message || 'falló el dictado')); pendientes.clear(); worker = null; };
  return worker;
}
function pedir(msg, alProgreso, transferir = []) {
  return new Promise((resolver, rechazar) => {
    const id = ++seq;
    pendientes.set(id, { resolver, rechazar, alProgreso });
    obtenerWorker().postMessage({ ...msg, id }, transferir);
  });
}

// La librería Transformers.js no va en el repositorio (el detector de claves de GitHub la marca por error):
// se baja una vez de jsdelivr, versión fija, se verifica su huella SHA-256 y se guarda en el iPhone bajo la
// ruta local que importa el worker (el service worker la entrega desde ahí, también sin internet).
const URL_LIBRERIA = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const HUELLA = '8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743';
const RUTA_LOCAL = new URL('../vendor/transformers/transformers.min.js', import.meta.url).href;
async function asegurarLibreria() {
  const cache = await caches.open('rumbo-dictado');
  if (await cache.match(RUTA_LOCAL)) return;
  if (!navigator.serviceWorker?.controller) throw new Error('cierra y vuelve a abrir Rumbo, y prueba de nuevo');
  const r = await fetch(URL_LIBRERIA, { cache: 'no-store' });
  if (!r.ok) throw new Error(`no se pudo bajar el motor (${r.status})`);
  const datos = await r.arrayBuffer();
  const huella = [...new Uint8Array(await crypto.subtle.digest('SHA-256', datos))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (huella !== HUELLA) throw new Error('el motor descargado no es el esperado');
  await cache.put(RUTA_LOCAL, new Response(datos, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }));
}

// Descarga y prepara el motor y el modelo (la primera vez, con internet).
export async function preparar(alProgreso) {
  await asegurarLibreria();
  return pedir({ tipo: 'cargar' }, alProgreso);
}

// Graba hasta que dejas de hablar (o 8 s). Devuelve el audio a 16 kHz para Whisper.
// «ctx» se crea en el mismo toque del usuario (iOS solo deja iniciar audio así).
export async function grabar({ alNivel, senal, ctx } = {}) {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  let flujo;
  try { flujo = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); } catch (e) { ctx.close().catch(() => {}); throw e; }
  try {
    await ctx.resume();
    const fuente = ctx.createMediaStreamSource(flujo);
    const analizador = ctx.createAnalyser();
    analizador.fftSize = 2048;
    fuente.connect(analizador);
    const tipo = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    const rec = new MediaRecorder(flujo, tipo ? { mimeType: tipo } : undefined);
    const trozos = [];
    rec.ondataavailable = (e) => { if (e.data?.size) trozos.push(e.data); };
    const fin = new Promise((res) => { rec.onstop = res; });
    rec.start();
    const datos = new Float32Array(analizador.fftSize);
    const inicio = Date.now();
    let hablo = false;
    let ultimaVoz = Date.now();
    await new Promise((res) => {
      const revisar = () => {
        if (senal?.detener || rec.state === 'inactive') return res();
        analizador.getFloatTimeDomainData(datos);
        let suma = 0;
        for (const v of datos) suma += v * v;
        const nivel = Math.sqrt(suma / datos.length);
        alNivel?.(nivel);
        if (nivel > 0.02) { hablo = true; ultimaVoz = Date.now(); }
        const t = Date.now() - inicio;
        if (t > 8000 || (hablo && Date.now() - ultimaVoz > 1300) || (!hablo && t > 5000)) return res();
        setTimeout(revisar, 80);
      };
      revisar();
    });
    if (rec.state !== 'inactive') rec.stop();
    await fin;
    if (!hablo) return null;
    const blob = new Blob(trozos, { type: rec.mimeType || tipo });
    const crudo = await ctx.decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.ceil(crudo.duration * 16000), 16000);
    const s = off.createBufferSource();
    s.buffer = crudo;
    s.connect(off.destination);
    s.start();
    return (await off.startRendering()).getChannelData(0);
  } finally {
    flujo.getTracks().forEach((t) => t.stop()); // el micrófono se suelta siempre
    ctx.close().catch(() => {});
  }
}

export async function transcribir(audio) {
  const copia = new Float32Array(audio);
  const r = await pedir({ tipo: 'transcribir', audio: copia }, null, [copia.buffer]);
  return r.texto.replace(/[.。]+$/, '').trim();
}

// Borra el modelo y el motor guardados.
export async function borrar() {
  worker?.terminate();
  worker = null;
  for (const k of ['transformers-cache', 'rumbo-dictado']) await caches.delete(k).catch(() => {});
}
