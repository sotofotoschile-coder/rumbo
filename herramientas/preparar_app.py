#!/usr/bin/env python3
"""Prepara la app web para publicarla:
- genera los íconos PNG desde icons/icono.svg (requiere rsvg-convert del entorno "rumbo"),
- escribe app/precache.json con todos los archivos que la app guarda para funcionar sin conexión,
- actualiza VERSION en app/sw.js con un hash del contenido (así el iPhone detecta la versión nueva).
"""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess

APP = pathlib.Path(__file__).resolve().parent.parent / "app"
EXCLUIR = {"precache.json", "sw.js", ".DS_Store", ".nojekyll"}
EXCLUIR_EXT = {".map", ".pmtiles"}


def generar_iconos():
    svg = APP / "icons" / "icono.svg"
    rsvg = shutil.which("rsvg-convert") or str(pathlib.Path.home() / "miniforge3/envs/rumbo/bin/rsvg-convert")
    for nombre, lado in (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)):
        destino = APP / "icons" / nombre
        if not destino.exists() or destino.stat().st_mtime < svg.stat().st_mtime:
            subprocess.run([rsvg, "-w", str(lado), "-h", str(lado), "-o", str(destino), str(svg)], check=True)


def main():
    generar_iconos()
    archivos = sorted(
        p for p in APP.rglob("*")
        if p.is_file() and p.name not in EXCLUIR and p.suffix not in EXCLUIR_EXT and not p.name.startswith(".")
    )
    h = hashlib.sha256()
    rutas = []
    for p in archivos:
        rel = p.relative_to(APP).as_posix()
        rutas.append("./" if rel == "index.html" else rel)
        h.update(rel.encode())
        h.update(p.read_bytes())
    if "./" in rutas:
        rutas.append("index.html")
    (APP / "precache.json").write_text(json.dumps(rutas, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    version = h.hexdigest()[:10]
    sw = APP / "sw.js"
    texto = re.sub(r"const VERSION = '[^']*';", f"const VERSION = 'rumbo-{version}';", sw.read_text(encoding="utf-8"))
    sw.write_text(texto, encoding="utf-8")
    total = sum(p.stat().st_size for p in archivos)
    print(f"{len(rutas)} archivos en caché ({total / 1e6:.1f} MB), versión rumbo-{version}")


if __name__ == "__main__":
    main()
