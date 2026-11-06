#!/usr/bin/env python3
"""Genera el relieve sin conexión de una región para Rumbo:
  1. descarga los modelos de elevación (Terrain Tiles, formato "terrarium", zoom 9–11) del rectángulo de la región,
  2. los empaqueta en app/datos/<region>.relieve.pmtiles (sombreado del terreno, altitud de cualquier punto y perfiles),
  3. arma un mosaico de elevación y genera curvas de nivel cada 20 m en app/datos/<region>.curvas.pmtiles.

Uso (entorno conda "rumbo"):  python herramientas/generar_relieve.py herramientas/regiones/magallanes.env [descargar|empaquetar|curvas|teselar|todo]

Datos de elevación: Terrain Tiles (Mapzen / AWS Open Data; fuentes SRTM, GMTED, ETOPO1 y otras).
"""
import concurrent.futures as cf
import json
import math
import pathlib
import shlex
import sqlite3
import subprocess
import sys
import urllib.request

RAIZ = pathlib.Path(__file__).resolve().parent.parent
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
ZMIN, ZMAX = 9, 11


def leer_env(ruta):
    cfg = {}
    for linea in pathlib.Path(ruta).read_text(encoding='utf-8').splitlines():
        linea = linea.strip()
        if linea and not linea.startswith('#') and '=' in linea:
            k, v = linea.split('=', 1)
            cfg[k.strip()] = shlex.split(v)[0] if v.strip() else ''
    return cfg


def tesela(lon, lat, z):
    n = 2 ** z
    r = math.radians(max(-85.05, min(85.05, lat)))
    return int((lon + 180) / 360 * n), int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)


def rango(bbox, z):
    o, s, e, n = bbox
    x0, y0 = tesela(o, n, z)
    x1, y1 = tesela(e, s, z)
    return x0, x1, y0, y1


def descargar(cfg, carpeta):
    bbox = [float(v) for v in cfg['BBOX'].split(',')]
    mbtiles = carpeta / f"{cfg['REGION_ID']}-relieve.mbtiles"
    db = sqlite3.connect(mbtiles)
    db.execute('CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row))')
    db.execute('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)')
    ya = {(z, x, (2 ** z - 1) - y) for z, x, y in db.execute('SELECT zoom_level, tile_column, tile_row FROM tiles')}
    pendientes = []
    for z in range(ZMIN, ZMAX + 1):
        x0, x1, y0, y1 = rango(bbox, z)
        pendientes += [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1) if (z, x, y) not in ya]
    print(f'{len(pendientes):,} teselas por descargar ({len(ya):,} ya estaban)')

    def bajar(t):
        z, x, y = t
        for _ in range(4):
            try:
                with urllib.request.urlopen(URL.format(z=z, x=x, y=y), timeout=60) as r:
                    return t, r.read()
            except Exception:
                pass
        return t, None

    hechas = 0
    with cf.ThreadPoolExecutor(8) as ex:
        for (z, x, y), datos in ex.map(bajar, pendientes):
            if datos:
                db.execute('INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)', (z, x, (2 ** z - 1) - y, datos))
            hechas += 1
            if hechas % 500 == 0:
                db.commit()
                print(f'  {hechas:,}/{len(pendientes):,}', flush=True)
    meta = {'name': f"Relieve {cfg.get('REGION_NOMBRE', '')}", 'format': 'png', 'type': 'baselayer', 'minzoom': ZMIN, 'maxzoom': ZMAX,
            'bounds': cfg['BBOX'], 'encoding': 'terrarium',
            'attribution': 'Elevación: Terrain Tiles (Mapzen, AWS Open Data; SRTM, GMTED, ETOPO1)'}
    for k, v in meta.items():
        db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', (k, str(v)))
    db.commit()
    db.close()
    empaquetar_relieve(cfg, mbtiles)
    return mbtiles


def empaquetar_relieve(cfg, mbtiles):
    """Empaqueta solo el zoom 11 (el detalle útil para trekking y la altitud): pesa menos de la mitad."""
    destino = RAIZ / 'datos' / 'relieve' / f"{cfg['REGION_ID']}.relieve.pmtiles"
    destino.parent.mkdir(parents=True, exist_ok=True)
    solo = mbtiles.with_name(mbtiles.stem + '-z11.mbtiles')
    solo.unlink(missing_ok=True)
    db = sqlite3.connect(solo)
    db.execute(f"ATTACH DATABASE '{mbtiles}' AS origen")
    db.execute('CREATE TABLE tiles AS SELECT * FROM origen.tiles WHERE zoom_level = ?', (ZMAX,))
    db.execute('CREATE TABLE metadata AS SELECT * FROM origen.metadata')
    db.execute("UPDATE metadata SET value = ? WHERE name = 'minzoom'", (str(ZMAX),))
    db.commit()
    db.close()
    pm = str(pathlib.Path.home() / 'Herramientas/bin/pmtiles')
    subprocess.run([pm, 'convert', str(solo), str(destino)], check=True)
    solo.unlink()
    print(f'Relieve: {destino} · {destino.stat().st_size / 1e6:.0f} MB')


def curvas(cfg, carpeta, mbtiles):
    """Mosaico de elevación (zoom 11) → curvas cada 20 m → teselas vectoriales."""
    import numpy as np
    from osgeo import gdal
    bbox = [float(v) for v in cfg['BBOX'].split(',')]
    z = ZMAX
    x0, x1, y0, y1 = rango(bbox, z)
    ancho, alto = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    dem = np.full((alto, ancho), -9999, dtype=np.float32)
    db = sqlite3.connect(mbtiles)
    for x, fila_tms, datos in db.execute('SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level=?', (z,)):
        y = (2 ** z - 1) - fila_tms
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            continue
        ruta = f'/vsimem/t_{x}_{y}.png'
        gdal.FileFromMemBuffer(ruta, datos)
        ds = gdal.Open(ruta)
        r, g, b = (ds.GetRasterBand(i).ReadAsArray().astype(np.float32) for i in (1, 2, 3))
        ds = None
        gdal.Unlink(ruta)
        dem[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = r * 256 + g + b / 256 - 32768
    db.close()
    dem[dem < -100] = -9999  # mar y huecos
    tam = 2 * math.pi * 6378137 / (2 ** z) / 256
    origen_x = -math.pi * 6378137 + x0 * 256 * tam
    origen_y = math.pi * 6378137 - y0 * 256 * tam
    tif = carpeta / f"{cfg['REGION_ID']}-dem.tif"
    ds = gdal.GetDriverByName('GTiff').Create(str(tif), ancho, alto, 1, gdal.GDT_Float32, ['COMPRESS=DEFLATE', 'TILED=YES'])
    ds.SetGeoTransform((origen_x, tam, 0, origen_y, 0, -tam))
    ds.SetProjection('EPSG:3857')
    banda = ds.GetRasterBand(1)
    banda.SetNoDataValue(-9999)
    banda.WriteArray(dem)
    ds = None
    print(f'Mosaico de elevación: {ancho}×{alto} px ({tam:.0f} m/px en el ecuador)')
    lineas = carpeta / f"{cfg['REGION_ID']}-curvas.geojsonl"
    tmp = carpeta / f"{cfg['REGION_ID']}-curvas-4326.geojsonl"
    shp = carpeta / f"{cfg['REGION_ID']}-curvas.gpkg"
    subprocess.run(['gdal_contour', '-q', '-i', '20', '-a', 'ele', '-f', 'GPKG', '-snodata', '-9999', str(tif), str(shp)], check=True)
    subprocess.run(['ogr2ogr', '-f', 'GeoJSONSeq', '-t_srs', 'EPSG:4326', '-lco', 'RS=NO', str(tmp), str(shp)], check=True)
    # Curvas maestras (cada 100 m) desde zoom 10; intermedias de 20 m desde zoom 13.
    with open(tmp, encoding='utf-8') as ent, open(lineas, 'w', encoding='utf-8') as sal:
        for linea in ent:
            f = json.loads(linea)
            ele = int(round(f['properties']['ele']))
            if ele <= 0:
                continue
            maestra = ele % 100 == 0
            f['properties'] = {'ele': ele, 'maestra': 1 if maestra else 0}
            f['tippecanoe'] = {'minzoom': 10 if maestra else 13}
            sal.write(json.dumps(f, separators=(',', ':')) + '\n')
    teselar_curvas(cfg, lineas)


def teselar_curvas(cfg, lineas):
    # Hasta zoom 13: el modelo de elevación (~45 m) no tiene más detalle; el mapa estira las líneas más allá.
    destino = RAIZ / 'datos' / 'relieve' / f"{cfg['REGION_ID']}.curvas.pmtiles"
    subprocess.run(['tippecanoe', '-q', '-f', '-o', str(destino), '-l', 'curvas', '-Z10', '-z13', '--simplification=4',
                    '--drop-densest-as-needed', '--no-tile-size-limit', '-P', str(lineas)], check=True)
    print(f'Curvas de nivel: {destino} · {destino.stat().st_size / 1e6:.0f} MB')


def main():
    cfg = leer_env(sys.argv[1] if len(sys.argv) > 1 else RAIZ / 'herramientas/regiones/magallanes.env')
    paso = sys.argv[2] if len(sys.argv) > 2 else 'todo'
    carpeta = RAIZ / 'datos' / 'relieve'
    carpeta.mkdir(parents=True, exist_ok=True)
    mbtiles = carpeta / f"{cfg['REGION_ID']}-relieve.mbtiles"
    if paso in ('descargar', 'todo'):
        mbtiles = descargar(cfg, carpeta)
    if paso == 'empaquetar':
        empaquetar_relieve(cfg, mbtiles)
    if paso == 'teselar':
        teselar_curvas(cfg, carpeta / f"{cfg['REGION_ID']}-curvas.geojsonl")
    if paso in ('curvas', 'todo'):
        curvas(cfg, carpeta, mbtiles)


if __name__ == '__main__':
    main()
