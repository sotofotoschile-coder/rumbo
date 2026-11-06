// Lectura de rutas KML y KMZ (Wikiloc, Google Earth, Gaia, etc.) sin internet.
// KMZ es un ZIP: se busca el .kml adentro y se descomprime con DecompressionStream del propio navegador.

export const esZip = (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

async function inflar(datos) {
  const flujo = new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(flujo).arrayBuffer());
}

// Extrae el primer .kml de un KMZ (o doc.kml si existe).
export async function kmlDeKmz(buffer) {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  // Directorio central: se busca el registro de fin («PK\x05\x06») desde el final.
  let fin = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw new Error('el KMZ está dañado');
  const total = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const entradas = [];
  for (let n = 0; n < total; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const metodo = v.getUint16(p + 10, true);
    const comprimido = v.getUint32(p + 20, true);
    const largoNombre = v.getUint16(p + 28, true);
    const largoExtra = v.getUint16(p + 30, true);
    const largoComentario = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nombre = new TextDecoder().decode(b.subarray(p + 46, p + 46 + largoNombre));
    entradas.push({ nombre, metodo, comprimido, local });
    p += 46 + largoNombre + largoExtra + largoComentario;
  }
  const e = entradas.find((x) => /(^|\/)doc\.kml$/i.test(x.nombre)) || entradas.find((x) => /\.kml$/i.test(x.nombre));
  if (!e) throw new Error('el KMZ no trae ningún .kml');
  const inicio = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
  const datos = b.subarray(inicio, inicio + e.comprimido);
  const crudo = e.metodo === 0 ? datos : e.metodo === 8 ? await inflar(datos) : null;
  if (!crudo) throw new Error('el KMZ usa una compresión que no conozco');
  return new TextDecoder().decode(crudo);
}

const coords = (texto) => texto.trim().split(/\s+/).map((t) => t.split(',').map(Number))
  .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
  .map((c) => [c[0], c[1], Number.isFinite(c[2]) ? c[2] : null, 0]);

// Devuelve { nombre, segmentos: [[[lon, lat, ele, tiempo], ...]], puntos: [{ nombre, desc, lon, lat, ele }] }.
export function leerKml(texto) {
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('el KML está dañado');
  const porNombre = (raiz, local) => [...raiz.getElementsByTagName('*')].filter((el) => el.localName === local);
  const segmentos = [];
  // gx:Track (Wikiloc, Google): <when> y <gx:coord>lon lat ele</gx:coord>
  for (const t of porNombre(doc, 'Track')) {
    const cuando = porNombre(t, 'when').map((w) => Date.parse(w.textContent) || 0);
    const pts = porNombre(t, 'coord').map((c, i) => {
      const [lon, lat, ele] = c.textContent.trim().split(/\s+/).map(Number);
      return [lon, lat, Number.isFinite(ele) ? ele : null, cuando[i] || 0];
    }).filter((x) => Number.isFinite(x[0]) && Number.isFinite(x[1]));
    if (pts.length > 1) segmentos.push(pts);
  }
  for (const l of porNombre(doc, 'LineString')) {
    const c = porNombre(l, 'coordinates')[0];
    const pts = c ? coords(c.textContent) : [];
    if (pts.length > 1) segmentos.push(pts);
  }
  const puntos = [];
  for (const pm of porNombre(doc, 'Placemark')) {
    const pt = porNombre(pm, 'Point')[0];
    if (!pt) continue;
    const c = coords(porNombre(pt, 'coordinates')[0]?.textContent || '')[0];
    if (!c) continue;
    const hijo = (n) => [...pm.children].find((el) => el.localName === n)?.textContent.trim() || '';
    puntos.push({ nombre: hijo('name'), desc: hijo('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500), lon: c[0], lat: c[1], ele: c[2] });
  }
  const nombre = [...doc.getElementsByTagName('*')].find((el) => el.localName === 'Document')?.querySelector(':scope > name')?.textContent.trim()
    || porNombre(doc, 'name')[0]?.textContent.trim() || '';
  return { nombre, segmentos, puntos };
}
