// Base de datos local (IndexedDB): mapas instalados, lugares, tracks y ajustes.
const NOMBRE = 'rumbo';
const VERSION = 1;
const ALMACENES = ['mapas', 'lugares', 'tracks', 'ajustes'];
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
