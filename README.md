# Rumbo GPS

GPS para iPhone que funciona sin conexión, hecho como app web instalable: sin App Store, sin suscripciones y sin fecha de caducidad.

- **Mapas offline** de OpenStreetMap (paquetes `.pmtiles` guardados en el iPhone).
- **GPS en vivo**: posición, precisión, altitud, velocidad y rumbo.
- **Brújula**, **lugares** (waypoints) y **tracks** con perfil de elevación y exportación GPX.

## Instalar en el iPhone
1. Abre la dirección de la app en **Safari**.
2. Toca **Compartir → Agregar a inicio**.
3. Abre Rumbo desde la pantalla de inicio, ve a **Mapas → Importar desde Archivos** y elige el paquete `.pmtiles`.

## Estructura
- `app/`: la app web (se publica tal cual en GitHub Pages).
- `herramientas/`: scripts para instalar herramientas, generar mapas y preparar la publicación.

Antes de publicar cambios: `python3 herramientas/preparar_app.py` (actualiza la caché offline y la versión).

Datos de mapa © colaboradores de OpenStreetMap, teselas de Protomaps.
