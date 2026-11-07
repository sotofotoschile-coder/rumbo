#!/usr/bin/env python3
"""Publica las regiones en app/datos/ para que la app las descargue con internet.

Uso:  python herramientas/publicar_datos.py magallanes aysen [--sin-relieve]

Por región toma (si existen):
  mapa     datos/mapas/<region>.pmtiles
  rutas    app/datos/<region>.rutas              (lo genera generar_rutas.py)
  relieve  datos/relieve/<region>.relieve.pmtiles (lo genera generar_relieve.py)
  curvas   datos/relieve/<region>.curvas.pmtiles

Los archivos de más de 45 MB se parten en trozos (GitHub Pages no acepta archivos de más de 100 MB)
y la app los vuelve a unir al descargarlos. Escribe app/datos/catalogo.json con la versión de cada
archivo, para que la app ofrezca «Actualizar» cuando cambien.
"""
import datetime
import hashlib
import json
import pathlib
import shlex
import shutil
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
DATOS = RAIZ / 'app' / 'datos'
TROZO = 45 * 1024 * 1024
# Los archivos grandes se descargan directo del repositorio (raw.githubusercontent.com, con CORS) y no desde
# GitHub Pages: así Pages publica solo la app (~3 MB) en segundos. «?v=» evita que un caché sirva una versión vieja.
RAW = 'https://raw.githubusercontent.com/sotofotoschile-coder/rumbo/main/app/'
NOMBRES = {'mapa': 'Mapa', 'rutas': 'Rutas sin conexión', 'relieve': 'Relieve del terreno', 'curvas': 'Curvas de nivel'}


def leer_env(region):
    cfg = {}
    for linea in (RAIZ / 'herramientas' / 'regiones' / f'{region}.env').read_text(encoding='utf-8').splitlines():
        linea = linea.strip()
        if linea and not linea.startswith('#') and '=' in linea:
            k, v = linea.split('=', 1)
            cfg[k.strip()] = shlex.split(v)[0] if v.strip() else ''
    return cfg


def huella(ruta):
    h = hashlib.sha1()
    with open(ruta, 'rb') as f:
        for bloque in iter(lambda: f.read(1 << 20), b''):
            h.update(bloque)
    return h.hexdigest()[:12]


def publicar(region, sin_relieve=False):
    cfg = leer_env(region)
    nombre_region = cfg.get('REGION_NOMBRE', region).replace('Región de ', '')
    fuentes = {
        'mapa': RAIZ / 'datos' / 'mapas' / f'{region}.pmtiles',
        'rutas': DATOS / f'{region}.rutas',
        'relieve': RAIZ / 'datos' / 'relieve' / f'{region}.relieve.pmtiles',
        'curvas': RAIZ / 'datos' / 'relieve' / f'{region}.curvas.pmtiles',
    }
    if sin_relieve:
        fuentes.pop('relieve')
    carpeta = DATOS / region
    entradas = []
    for tipo, origen in fuentes.items():
        if not origen.exists():
            continue
        tam = origen.stat().st_size
        version = huella(origen)
        if tipo == 'rutas':
            archivo = {'archivo': f'{RAW}datos/{origen.name}?v={version}'}  # un solo archivo
        else:
            carpeta.mkdir(parents=True, exist_ok=True)
            for viejo in carpeta.glob(f'{tipo}.*'):
                viejo.unlink()
            partes = []
            with open(origen, 'rb') as f:
                for i, bloque in enumerate(iter(lambda: f.read(TROZO), b''), start=1):
                    destino = carpeta / f'{tipo}.{i:03d}'
                    destino.write_bytes(bloque)
                    partes.append(f'{RAW}datos/{region}/{destino.name}?v={version}')
            archivo = {'partes': partes}
        entradas.append({'tipo': tipo, 'id': region, 'region': region, 'regionNombre': nombre_region,
                         'nombre': f'{NOMBRES[tipo]} de {nombre_region}' if tipo != 'rutas' else f'rutas de {nombre_region}',
                         **archivo, 'bytes': tam, 'version': version,
                         'generado': datetime.date.fromtimestamp(origen.stat().st_mtime).isoformat()})
        print(f'  {region:12s} {tipo:8s} {tam / 1e6:7.1f} MB  {len(archivo.get("partes", [1]))} parte(s)')
    return entradas


def main():
    regiones = [a for a in sys.argv[1:] if not a.startswith('--')]
    sin_relieve = '--sin-relieve' in sys.argv
    ruta_cat = DATOS / 'catalogo.json'
    catalogo = json.loads(ruta_cat.read_text(encoding='utf-8')) if ruta_cat.exists() else []
    for region in regiones:
        catalogo = [c for c in catalogo if c.get('region', c.get('id')) != region]
        catalogo += publicar(region, sin_relieve)
    ruta_cat.write_text(json.dumps(catalogo, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    total = sum(p.stat().st_size for p in DATOS.rglob('*') if p.is_file())
    print(f'Catálogo: {len(catalogo)} archivos · {total / 1e6:.0f} MB publicados en app/datos')


if __name__ == '__main__':
    main()
