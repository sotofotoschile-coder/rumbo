// Worker del dictado sin conexión: Whisper (modelo «base», multilingüe) ejecutado en el iPhone con ONNX Runtime.
// La primera vez descarga el modelo (~140 MB) desde Hugging Face y queda guardado; después funciona sin internet.
import { pipeline, env } from '../vendor/transformers/transformers.min.js';

const MODELO = 'onnx-community/whisper-base';
// El codificador va completo (fp32): comprimido entiende muy mal. El decodificador va comprimido (q8).
const PRECISION = { encoder_model: 'fp32', decoder_model_merged: 'q8' };

env.allowLocalModels = false;
env.useBrowserCache = true;
const base = new URL('../vendor/transformers/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${base}ort-wasm-simd-threaded.asyncify.wasm` };
env.backends.onnx.wasm.numThreads = 1;

let asr = null;
async function cargar(id) {
  if (asr) return asr;
  const vistos = {};
  asr = await pipeline('automatic-speech-recognition', MODELO, {
    dtype: PRECISION,
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        vistos[p.file] = [p.loaded, p.total];
        const hecho = Object.values(vistos).reduce((s, [l]) => s + l, 0);
        const total = Object.values(vistos).reduce((s, [, t]) => s + t, 0);
        self.postMessage({ id, tipo: 'progreso', hecho, total });
      }
    },
  });
  return asr;
}

self.onmessage = async (e) => {
  const { id, tipo } = e.data;
  try {
    if (tipo === 'cargar') {
      await cargar(id);
      self.postMessage({ id, tipo: 'listo' });
    } else if (tipo === 'transcribir') {
      const m = await cargar(id);
      const r = await m(e.data.audio, { language: 'es', task: 'transcribe' });
      self.postMessage({ id, tipo: 'texto', texto: (r.text || '').trim() });
    }
  } catch (err) {
    asr = null;
    self.postMessage({ id, tipo: 'error', error: err?.message || String(err) });
  }
};
