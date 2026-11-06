# Rumbo GPS

GPS para iPhone que funciona sin conexión, hecho como app web instalable: sin App Store, sin suscripciones y sin fecha de caducidad.

- **Mapas offline** de OpenStreetMap (paquetes `.pmtiles` guardados en el iPhone).
- **GPS en vivo**: posición, precisión, altitud, velocidad y rumbo.
- **Brújula**, **lugares** (waypoints) y **tracks** con perfil de elevación y exportación GPX.

## Instalar en el iPhone
1. Abre la dirección de la app en **Safari**.
2. Toca **Compartir → Agregar a inicio**.
3. Abre Rumbo desde la pantalla de inicio, ve a **Mapas → Importar desde Archivos** y elige el paquete `.pmtiles`.

## Pasar Rumbo con todos los mapas a otro iPhone
1. En el iPhone que ya tiene todo: **Mapas → Crear paquete para otro iPhone → Enviar paquete**, y elige WhatsApp,
   Correo (Mail Drop), AirDrop o iCloud Drive. El paquete `.rumbo` trae mapas, rutas, satélite, lugares, tracks y la clave de ArcGIS (Satélite HD).
2. En el otro iPhone: guarda el archivo en **Archivos**, instala Rumbo desde Safari (Compartir → Agregar a inicio),
   ábrela y toca **Mapas → Importar desde Archivos** → elige el `.rumbo`.

## Estructura
- `app/`: la app web (se publica tal cual en GitHub Pages).
- `herramientas/`: scripts para instalar herramientas, generar mapas y preparar la publicación.

Antes de publicar cambios: `python3 herramientas/preparar_app.py` (actualiza la caché offline y la versión).

## Rutas sin conexión
`python herramientas/generar_rutas.py herramientas/regiones/magallanes.env` recorta los extractos de OpenStreetMap
(Geofabrik) a la región y genera `app/datos/<region>.rutas`, una red de caminos compacta que la app descarga una vez
y usa para calcular rutas en auto o a pie, con indicaciones por voz, sin internet.

Datos de mapa y de caminos © colaboradores de OpenStreetMap (licencia ODbL); teselas de Protomaps.
Imágenes satelitales: Sentinel-2 cloudless 2025 de EOX (CC BY-NC-SA 4.0) y, con clave propia, Esri World Imagery.
