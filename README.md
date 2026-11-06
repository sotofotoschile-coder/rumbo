# Rumbo GPS

GPS para iPhone que funciona sin conexión, hecho como app web instalable: sin App Store, sin suscripciones y sin fecha de caducidad.

- **Mapas offline** de OpenStreetMap (paquetes `.pmtiles` guardados en el iPhone).
- **GPS en vivo**: posición, precisión, altitud, velocidad y rumbo.
- **Brújula**, **lugares** con foto, nota y categoría, y **tracks** con perfil de elevación y exportación GPX.
- **Relieve y curvas de nivel** sin conexión: sombreado del terreno, curvas cada 20 m, altitud de cualquier punto y perfil de subida y bajada de cada ruta.
- **Navegación** con voz, límites de velocidad, aviso de ripio, modo noche automático y seguimiento de tracks GPX importados.
- **Búsqueda sin conexión** de calles, pueblos, bencineras, hospitales, refugios y campings; **botón SOS** por SMS; modo ahorro de batería.
- **Regiones**: Magallanes y Aysén, descargables desde **Mapas → Regiones disponibles**, con botón «Actualizar» cuando hay datos nuevos.

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

## Relieve, curvas y publicación de regiones
1. `python herramientas/generar_relieve.py herramientas/regiones/<region>.env todo` descarga el modelo de elevación
   (Terrain Tiles), arma `datos/relieve/<region>.relieve.pmtiles` (zoom 11, ~45 m por píxel) y las curvas de nivel `<region>.curvas.pmtiles`.
2. `python herramientas/publicar_datos.py magallanes aysen` parte mapa, relieve y curvas en trozos de 45 MB dentro de
   `app/datos/<region>/` y escribe `app/datos/catalogo.json` con la versión de cada archivo.
3. `python3 herramientas/preparar_app.py` y publicar: la app ofrece «Actualizar» en cada región cuya versión cambió.

Datos de mapa y de caminos © colaboradores de OpenStreetMap (licencia ODbL); teselas de Protomaps.
Elevación: Terrain Tiles (Mapzen, AWS Open Data; SRTM, GMTED, ETOPO1).
Imágenes satelitales: Sentinel-2 cloudless 2025 de EOX (CC BY-NC-SA 4.0) y, con clave propia, Esri World Imagery.
