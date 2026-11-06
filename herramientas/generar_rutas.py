#!/usr/bin/env python3
"""Genera la red de rutas sin conexión de una región (archivo .rutas) para Rumbo.

Uso (con el entorno conda "rumbo"):
  python herramientas/generar_rutas.py herramientas/regiones/magallanes.env

Pasos:
  1. Recorta los extractos OSM (Chile, Argentina) al rectángulo de la región con osmium y los une.
  2. Lee calles, caminos, huellas, senderos y transbordadores; corta las vías en cada cruce.
  3. Escribe un archivo binario compacto que la app lee directamente (ver formato en escribir()).

Datos © colaboradores de OpenStreetMap, licencia ODbL.
"""
import array
import datetime
import json
import math
import pathlib
import shlex
import struct
import subprocess
import sys

import osmium

RAIZ = pathlib.Path(__file__).resolve().parent.parent

# Velocidad en auto (km/h) por tipo de vía. None = el auto no puede pasar.
VEL_AUTO = {
    'motorway': 100, 'motorway_link': 60, 'trunk': 90, 'trunk_link': 50,
    'primary': 80, 'primary_link': 50, 'secondary': 70, 'secondary_link': 45,
    'tertiary': 60, 'tertiary_link': 40, 'unclassified': 50, 'road': 40,
    'residential': 30, 'living_street': 10, 'service': 20, 'track': 25,
}
SOLO_PIE = {'footway', 'path', 'pedestrian', 'steps', 'bridleway', 'cycleway', 'corridor'}
SIN_PIE = {'motorway', 'motorway_link'}
CLASES = ['otro', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
          'living_street', 'service', 'track', 'path', 'ferry']
NO = {'no', 'private'}
SIN_PAVIMENTO = {'unpaved', 'gravel', 'dirt', 'ground', 'earth', 'fine_gravel', 'compacted', 'sand', 'grass', 'mud'}

F_ROTONDA, F_FERRY, F_RIPIO, F_SENDERO = 1, 2, 4, 8


def leer_env(ruta):
    cfg = {}
    for linea in pathlib.Path(ruta).read_text(encoding='utf-8').splitlines():
        linea = linea.strip()
        if linea and not linea.startswith('#') and '=' in linea:
            k, v = linea.split('=', 1)
            cfg[k.strip()] = shlex.split(v)[0] if v.strip() else ''
    return cfg


def recortar(cfg, carpeta):
    """Recorta cada extracto al bbox y los une en un solo .pbf."""
    bbox = cfg['BBOX']
    partes = []
    for url in cfg['OSM_FUENTES'].split():
        origen = carpeta / url.rsplit('/', 1)[1]
        if not origen.exists():
            sys.exit(f'Falta {origen}. Descárgalo primero de {url}')
        destino = carpeta / f"{cfg['REGION_ID']}-{origen.stem.split('-')[0]}.osm.pbf"
        print(f'Recortando {origen.name} …')
        subprocess.run(['osmium', 'extract', '--bbox', bbox, '--strategy', 'complete_ways',
                        '--overwrite', '-o', str(destino), str(origen)], check=True)
        partes.append(destino)
    unido = carpeta / f"{cfg['REGION_ID']}.osm.pbf"
    subprocess.run(['osmium', 'merge', '--overwrite', '-o', str(unido), *map(str, partes)], check=True)
    return unido


def velocidad_maxima(tags):
    v = tags.get('maxspeed', '')
    try:
        if v.endswith('mph'):
            return int(float(v[:-3]) * 1.609)
        return int(float(v))
    except ValueError:
        return None


class Vias(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.vias = []  # (nodos, coords, atributos)

    def way(self, w):
        t = w.tags
        hw = t.get('highway')
        ferry = t.get('route') == 'ferry'
        if not hw and not ferry:
            return
        if hw in ('construction', 'proposed', 'abandoned', 'platform', 'raceway', 'bus_guideway', 'elevator'):
            return
        if t.get('area') == 'yes':
            return
        acceso = t.get('access', '')
        if ferry:
            auto = t.get('motor_vehicle', t.get('motorcar', 'yes')) not in NO
            pie = t.get('foot', 'yes') not in NO
            vel = 15
            clase = 'ferry'
        else:
            vel = VEL_AUTO.get(hw)
            auto = vel is not None and acceso not in NO and t.get('motor_vehicle') not in NO and t.get('motorcar') not in NO
            pie = (hw in SOLO_PIE or hw in VEL_AUTO) and hw not in SIN_PIE and t.get('foot') not in NO and \
                (acceso not in NO or t.get('foot') in ('yes', 'designated', 'permissive'))
            clase = hw.replace('_link', '') if hw.replace('_link', '') in CLASES else ('path' if hw in SOLO_PIE else 'otro')
            mx = velocidad_maxima(t)
            if vel and mx:
                vel = min(vel * 1.2, mx)
            if vel and t.get('surface') in SIN_PAVIMENTO:
                vel = min(vel, 60 if hw not in ('track', 'service') else 20)
        if not auto and not pie:
            return
        sentido = 0  # 0 ambos, 1 solo hacia adelante, -1 solo al revés (para autos)
        ow = t.get('oneway', '')
        rotonda = t.get('junction') in ('roundabout', 'circular')
        if ow in ('yes', '1', 'true') or rotonda or (hw in ('motorway',) and ow != 'no'):
            sentido = 1
        elif ow == '-1':
            sentido = -1
        flags = (F_ROTONDA if rotonda else 0) | (F_FERRY if ferry else 0) | \
                (F_RIPIO if t.get('surface') in SIN_PAVIMENTO else 0) | (F_SENDERO if hw in SOLO_PIE else 0)
        nombre = t.get('name') or t.get('ref') or ''
        if t.get('ref') and t.get('name') and t.get('ref') not in nombre:
            nombre = f"{t.get('name')} ({t.get('ref')})"
        try:
            nodos = [n.ref for n in w.nodes]
            coords = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(nodos) < 2:
            return
        self.vias.append((nodos, coords, {
            'auto': auto, 'pie': pie, 'vel': int(round(vel or 0)), 'clase': CLASES.index(clase),
            'sentido': sentido, 'flags': flags, 'nombre': nombre,
        }))


def dist(a, b):
    r = 6371008.8
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla = la2 - la1
    dlo = math.radians(b[0] - a[0])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def construir(vias):
    uso = {}
    for nodos, _, _ in vias:
        for i, n in enumerate(nodos):
            uso[n] = uso.get(n, 0) + (2 if i in (0, len(nodos) - 1) else 1)
    indice = {}
    nodos_xy = []

    def id_nodo(osm_id, xy):
        if osm_id not in indice:
            indice[osm_id] = len(nodos_xy)
            nodos_xy.append(xy)
        return indice[osm_id]

    aristas = []  # (a, b, largo, geom_intermedia, attrs)
    for nodos, coords, at in vias:
        inicio = 0
        for i in range(1, len(nodos)):
            if uso[nodos[i]] > 1 or i == len(nodos) - 1:
                tramo = coords[inicio:i + 1]
                largo = sum(dist(tramo[k], tramo[k + 1]) for k in range(len(tramo) - 1))
                if largo > 0:
                    a = id_nodo(nodos[inicio], coords[inicio])
                    b = id_nodo(nodos[i], coords[i])
                    aristas.append((a, b, largo, tramo[1:-1], at))
                inicio = i
    return nodos_xy, aristas


def componentes(n, aristas):
    """Quita islas diminutas (calles sueltas mal conectadas) que harían fallar el cálculo."""
    padre = list(range(n))

    def raiz(x):
        while padre[x] != x:
            padre[x] = padre[padre[x]]
            x = padre[x]
        return x
    for a, b, *_ in aristas:
        ra, rb = raiz(a), raiz(b)
        if ra != rb:
            padre[ra] = rb
    tam = {}
    for a, *_ in aristas:
        r = raiz(a)
        tam[r] = tam.get(r, 0) + 1
    return [x for x in aristas if tam[raiz(x[0])] >= 15]


def escribir(destino, cfg, nodos_xy, aristas):
    # Renumera solo los nodos usados por aristas que quedaron.
    usados = sorted({a for a, *_ in aristas} | {b for _, b, *_ in aristas})
    nuevo = {v: i for i, v in enumerate(usados)}
    N, E = len(usados), len(aristas)
    nombres = ['']
    idx_nombre = {'': 0}
    nodos = array.array('i')
    for v in usados:
        lon, lat = nodos_xy[v]
        nodos.extend((round(lon * 1e6), round(lat * 1e6)))
    ea, eb, elen = array.array('I'), array.array('I'), array.array('f')
    evel, eclase, eflags, enombre = bytearray(), bytearray(), bytearray(), array.array('I')
    goff, geom = array.array('I', [0]), array.array('i')
    salida = [[] for _ in range(N)]  # (destino, arista, flags_sentido)
    for e, (a, b, largo, inter, at) in enumerate(aristas):
        a, b = nuevo[a], nuevo[b]
        ea.append(a); eb.append(b); elen.append(largo)
        evel.append(min(255, at['vel'])); eclase.append(at['clase']); eflags.append(at['flags'])
        nom = at['nombre']
        if nom not in idx_nombre:
            idx_nombre[nom] = len(nombres)
            nombres.append(nom)
        enombre.append(idx_nombre[nom])
        for lon, lat in inter:
            geom.extend((round(lon * 1e6), round(lat * 1e6)))
        goff.append(len(geom) // 2)
        auto_ab = at['auto'] and at['sentido'] in (0, 1)
        auto_ba = at['auto'] and at['sentido'] in (0, -1)
        salida[a].append((b, e, (1 if auto_ab else 0) | (2 if at['pie'] else 0)))
        salida[b].append((a, e, (1 if auto_ba else 0) | (2 if at['pie'] else 0)))
    aoff, ato, aedge, aflags = array.array('I', [0]), array.array('I'), array.array('I'), bytearray()
    for lista in salida:
        for d, e, f in lista:
            ato.append(d); aedge.append(e); aflags.append(f)
        aoff.append(len(ato))

    secciones = [
        ('nodos', nodos), ('adjOff', aoff), ('adjTo', ato), ('adjArista', aedge), ('adjFlags', aflags),
        ('aristaA', ea), ('aristaB', eb), ('aristaLargo', elen), ('aristaVel', evel), ('aristaClase', eclase),
        ('aristaFlags', eflags), ('aristaNombre', enombre), ('geomOff', goff), ('geom', geom),
    ]
    cuerpo = bytearray()
    offsets = {}
    for nombre, datos in secciones:
        while len(cuerpo) % 4:
            cuerpo.append(0)
        b = bytes(datos) if isinstance(datos, (bytes, bytearray)) else datos.tobytes()
        offsets[nombre] = [len(cuerpo), len(b)]
        cuerpo.extend(b)
    lons, lats = nodos[0::2], nodos[1::2]
    cabecera = {
        'formato': 1, 'region': cfg['REGION_ID'], 'nombre': cfg.get('REGION_NOMBRE', cfg['REGION_ID']),
        'generado': datetime.date.today().isoformat(), 'nodos': N, 'aristas': E, 'mediasAristas': len(ato),
        'limites': [min(lons) / 1e6, min(lats) / 1e6, max(lons) / 1e6, max(lats) / 1e6],
        'clases': CLASES, 'nombres': nombres, 'secciones': offsets,
        'atribucion': '© colaboradores de OpenStreetMap (ODbL)',
    }
    cab = json.dumps(cabecera, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    while (16 + len(cab)) % 4:
        cab += b' '
    with open(destino, 'wb') as f:
        f.write(b'RUMBORUT')
        f.write(struct.pack('<II', 1, len(cab)))
        f.write(cab)
        f.write(cuerpo)
    return N, E, len(cuerpo) + len(cab) + 16


def main():
    cfg = leer_env(sys.argv[1] if len(sys.argv) > 1 else RAIZ / 'herramientas/regiones/magallanes.env')
    carpeta = RAIZ / 'datos' / 'osm'
    unido = recortar(cfg, carpeta)
    print('Leyendo calles, caminos y senderos …')
    h = Vias()
    h.apply_file(str(unido), locations=True)
    print(f'  {len(h.vias):,} vías')
    nodos_xy, aristas = construir(h.vias)
    antes = len(aristas)
    aristas = componentes(len(nodos_xy), aristas)
    print(f'  {len(aristas):,} tramos (se quitaron {antes - len(aristas):,} tramos aislados)')
    destino = RAIZ / 'app' / 'datos' / f"{cfg['REGION_ID']}.rutas"
    destino.parent.mkdir(parents=True, exist_ok=True)
    n, e, tam = escribir(destino, cfg, nodos_xy, aristas)
    print(f'Listo: {destino} · {n:,} cruces · {e:,} tramos · {tam / 1e6:.1f} MB')
    if tam > 95e6:
        print('AVISO: supera el límite de 100 MB por archivo de GitHub; habrá que dividirlo o pasarlo por AirDrop.')
    # Catálogo que la app consulta para ofrecer la descarga con internet.
    catalogo_ruta = destino.parent / 'catalogo.json'
    catalogo = json.loads(catalogo_ruta.read_text(encoding='utf-8')) if catalogo_ruta.exists() else []
    catalogo = [c for c in catalogo if not (c.get('tipo') == 'rutas' and c.get('id') == cfg['REGION_ID'])]
    catalogo.append({'tipo': 'rutas', 'id': cfg['REGION_ID'], 'nombre': f"rutas de {cfg.get('REGION_NOMBRE', '').replace('Región de ', '')}",
                     'archivo': f"datos/{destino.name}", 'bytes': tam, 'generado': datetime.date.today().isoformat()})
    catalogo_ruta.write_text(json.dumps(catalogo, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
