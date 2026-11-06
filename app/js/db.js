// Base de datos local (IndexedDB): mapas instalados, lugares, tracks y ajustes.
const NOMBRE = 'rumbo';
const VERSION = 3;
// sat: teselas satelitales descargadas ({ id: 'z/x/y', blob }); zonas: áreas satelitales descargadas.
const ALMACENES = ['mapas', 'lugares', 'tracks', 'ajustes', 'sat', 'zonas', 'pronosticos'];
let promesa;

function abrir() {
  if (!promesa) {
    promesa = new Promise((resolver, rechazar) => {
      const r = indexedDB.open(NOMBRE, VERSION);
      r.onupgradeneeded = () => {
        for (const a of ALMACENES) {
          if (!r.result.objectStoreNames.contains(a)) r.result.createObjectStore(a, { keyPath: 'id' });
        }
      };
      r.onsuccess = () => resolver(r.result);
      r.onerror = () => rechazar(r.error);
    });
  }
  return promesa;
}

async function operar(almacen, modo, fn) {
  const base = await abrir();
  return new Promise((resolver, rechazar) => {
    const t = base.transaction(almacen, modo);
    const peticion = fn(t.objectStore(almacen));
    t.oncomplete = () => resolver(peticion ? peticion.result : undefined);
    t.onerror = () => rechazar(t.error);
    t.onabort = () => rechazar(t.error);
  });
}

export const db = {
  todos: (a) => operar(a, 'readonly', (o) => o.getAll()),
  obtener: (a, id) => operar(a, 'readonly', (o) => o.get(id)),
  guardar: (a, valor) => operar(a, 'readwrite', (o) => o.put(valor)),
  borrar: (a, id) => operar(a, 'readwrite', (o) => o.delete(id)),
  guardarVarios: (a, valores) => operar(a, 'readwrite', (o) => { valores.forEach((v) => o.put(v)); return null; }),
  borrarVarios: (a, ids) => operar(a, 'readwrite', (o) => { ids.forEach((id) => o.delete(id)); return null; }),
  contar: (a) => operar(a, 'readonly', (o) => o.count()),
  // Devuelve qué ids ya existen (consulta en una sola transacción).
  async existentes(a, ids) {
    const base = await abrir();
    return new Promise((resolver, rechazar) => {
      const t = base.transaction(a, 'readonly');
      const o = t.objectStore(a);
      const hay = new Set();
      ids.forEach((id) => { const r = o.getKey(id); r.onsuccess = () => { if (r.result !== undefined) hay.add(id); }; });
      t.oncomplete = () => resolver(hay);
      t.onerror = () => rechazar(t.error);
    });
  },
};

export const ajustes = {
  async leer(clave, porDefecto) {
    const r = await db.obtener('ajustes', clave);
    return r === undefined ? porDefecto : r.valor;
  },
  escribir: (clave, valor) => db.guardar('ajustes', { id: clave, valor }),
};

export function nuevoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
