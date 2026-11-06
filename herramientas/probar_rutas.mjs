// Prueba el motor de rutas (app/js/enrutador.js) con la red generada, fuera del navegador.
// Uso: node herramientas/probar_rutas.mjs app/datos/magallanes.rutas
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archivoRed = process.argv[2] || path.join(raiz, 'app/datos/magallanes.rutas');
const codigo = readFileSync(path.join(raiz, 'app/js/enrutador.js'), 'utf8');

// Simula el entorno del worker.
const respuestas = [];
const self = { postMessage: (m) => respuestas.push(m) };
new Function('self', codigo)(self);
const pedir = async (msg) => { respuestas.length = 0; await self.onmessage({ data: { ...msg, id: 1 } }); return respuestas[0]; };

const buf = readFileSync(archivoRed);
const t0 = performance.now();
const carga = await pedir({ tipo: 'cargar', archivo: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } });
console.log('Carga:', carga.ok ? `${carga.info.nodos.toLocaleString()} nodos en ${Math.round(performance.now() - t0)} ms` : carga.error);

const casosAysen = [
  ['Coyhaique → Cochrane (Carretera Austral)', [-72.0662, -45.5712], [-72.5740, -47.2540], 'auto', [300, 380]],
  ['Coyhaique → Puerto Aysén', [-72.0662, -45.5712], [-72.6950, -45.4030], 'auto', [55, 80]],
  ['Coyhaique → Chile Chico', [-72.0662, -45.5712], [-71.7300, -46.5400], 'auto', [180, 420]],
];
const casos = archivoRed.includes('aysen') ? casosAysen : [
  ['Punta Arenas centro → Puerto Natales', [-70.9095, -53.1625], [-72.5065, -51.7290], 'auto', [230, 270]],
  ['Punta Arenas → Aeropuerto', [-70.9095, -53.1625], [-70.8546, -53.0058], 'auto', [17, 30]],
  ['Plaza de Armas → Cerro de la Cruz (a pie)', [-70.9095, -53.1625], [-70.9150, -53.1600], 'pie', [0.3, 1.5]],
  ['Puerto Natales → Torres del Paine (Laguna Amarga)', [-72.5065, -51.7290], [-72.8560, -50.9790], 'auto', [100, 150]],
  ['Punta Arenas → Porvenir (con transbordador)', [-70.9095, -53.1625], [-70.3690, -53.2950], 'auto', [30, 260]],
];
for (const [nombre, desde, hasta, perfil, [min, max]] of casos) {
  const t = performance.now();
  const r = await pedir({ tipo: 'ruta', desde, hasta, perfil });
  const ms = Math.round(performance.now() - t);
  if (!r.ok) { console.log(`✗ ${nombre}: ${r.error}`); continue; }
  const km = r.ruta.distancia / 1000;
  const ok = km >= min && km <= max;
  console.log(`${ok ? '✓' : '?'} ${nombre}: ${km.toFixed(1)} km, ${Math.round(r.ruta.duracion / 60)} min, ${r.ruta.pasos.length} indicaciones (${ms} ms)`);
  for (const p of r.ruta.pasos.slice(0, 6)) console.log(`     · ${(p.distancia / 1000).toFixed(2)} km  ${p.texto}`);
  if (r.ruta.pasos.length > 6) console.log(`     · … ${r.ruta.pasos.at(-1).texto}`);
}
