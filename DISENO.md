# OpenGISEarth — Diseño

Reemplazo de código abierto de Google Earth Pro de escritorio, con edición GIS seria.
Basado en análisis estático (nombres de clases/funciones y strings; sin código decompilado copiado) de
Google Earth Pro, ArcGIS Desktop 10.8, QGIS 3.40 y el editor de regiones de making-history.

## Objetivo de producto
Tan intuitivo como Google Earth: globo 3D, nubes, imágenes superpuestas, trazados y polígonos,
simulador de vuelo, KML/KMZ. Más: edición con snapping, topología y deshacer.

## Stack
- Motor: **CesiumJS** (globo, terreno, quadtree+LOD, KML, cámara, modos de altitud).
- Escritorio: **Tauri** (o Electron).
- Geometría: turf.js / JSTS (equivalente a shapely/GEOS).
- Datos abiertos: Sentinel-2 cloudless (EOX), NASA GIBS (incluye nubes reales), Copernicus DEM GLO-30,
  OpenStreetMap, Natural Earth. **Nunca** imágenes/terreno de Google.

## Interfaz (como Google Earth)
- Buscador arriba-izquierda; panel "Mis lugares" (árbol de carpetas con casillas).
- Barra: Marca, Trazado, Polígono, Superposición de imagen, Regla, Tour, Simulador de vuelo.
- Controles de navegación en la esquina; diálogo de edición modal (Aceptar = confirma, Cancelar = restaura).
- Panel "Crear objetos" con plantillas (idea de ArcGIS): capa + estilo + atributos por defecto + herramienta.

## Arquitectura
### Modelo de objetos (de Google Earth)
Jerarquía tipo KML: Documento/Carpeta → Placemark (Punto, LineString, LinearRing, Polygon, Multi*),
GroundOverlay, vistas (Camera/LookAt), estilos, TimeSpan, ExtendedData.
Campos reflectivos: cada cambio es un registro `{objeto, campo, antes, después}` interpolable →
sirve igual para deshacer y para animar tours.

### Sesión de edición (de QGIS + ArcGIS)
- Un **EditorService** único: sesión, bus de eventos, plantilla activa, sketch en curso.
- **Buffer de cambios** en memoria (añadidos, borrados, geometrías, atributos); al leer se aplica sobre la fuente.
- **Deshacer**: pila de comandos (AddFeature, DeleteFeature, ChangeGeometry, ChangeAttribute);
  `beginEditCommand/endEditCommand` agrupa en un paso; `mergeWith` funde arrastres de vértice.
  Pila aparte, pequeña, para el sketch en curso.
- **Guardar**: por etapas, en lote, con lista de errores por etapa; validación antes de escribir
  (geometría válida, sin astillas, sin mallas rotas — de making-history).

### Herramientas
Marca, trazado, polígono, editar vértices (mover / insertar arrastrando desde arista / borrar con Alt+clic),
reformar, dividir, unir, cortar, rellenar hueco, crear región siguiendo bordes, borrar región uniéndola al vecino.
Restricciones de dibujo (ángulo, distancia) como módulo independiente.

### Snapping y topología
- Un índice espacial por capa; destinos: vértice, arista, medio de segmento, extremo, centroide.
- Tolerancia en **píxeles**, convertida a metros según el zoom.
- Dos clics sobre un borde = seguirlo nodo a nodo (making-history).
- Topología activable a nivel de proyecto: nodo compartido se mueve en todos sus objetos;
  grafo topológico temporal solo de la zona editada (ArcGIS); insertar vértices en vecinos (QGIS);
  opción "evitar intersecciones" que recorta polígonos nuevos.

### Globo y render
Cesium ya da: tiles en quadtree con LOD por error en pantalla, terreno, geometría pegada al suelo
re-teselada al refinar terreno, KML Region/Lod. Navegación como máquina de estados sobre modelos
de movimiento intercambiables (órbita, inclinación, nivel de suelo, vuelo "swoop", simulador).

### Funciones especiales
- **Nubes**: capa GIBS (real) + nubes procedurales de Cesium.
- **Superposición de imagen**: GroundOverlay con esquinas arrastrables y opacidad; se guarda en KML.
- **Simulador de vuelo**: modelo glTF, física simple (empuje, sustentación, alabeo), teclado/joystick, cámara de persecución.
- **KML/KMZ**: leer y escribir (KMZ = zip con doc.kml; reescribir rutas relativas al guardar).
- **Antimeridiano**: obligatorio desde el día 1 (making-history no lo soporta).

## Lecciones de making-history
- Reutilizar: set de herramientas, seguir bordes, topología, validación al guardar, copia en disco por guardado.
- Evitar: vista plana lon/lat, tope de 1.500 objetos y 20 s de precálculo (usar tiles vectoriales),
  archivos gigantes (separar en módulos desde el inicio).

## Fases
1. Globo + imágenes/terreno abiertos + búsqueda (Nominatim) + panel Mis lugares + KML/KMZ abrir/guardar.
2. Marca, trazado, polígono, superposición de imagen, regla; deshacer.
3. Edición GIS: vértices, snapping, topología, dividir/unir/cortar.
4. Nubes, tours, simulador de vuelo.
5. Modo editor de regiones (import/export making-history vía GeoJSON).

## Pendiente / no verificado
- Nada se decompiló: Ghidra no pudo con `googleearth_pro.dll` (40 MB) y la búsqueda en ArcGIS se cortó.
  Todo lo anterior se infiere de nombres de clases/funciones.
- Sin revisar: `EditTools.dll` de ArcGIS (deshacer/snapping/reshape), DLLs IG* de Google Earth, `transfer.py` de making-history.
