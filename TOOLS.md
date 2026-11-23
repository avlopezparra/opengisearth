# OpenGISEarth — Herramientas avanzadas

La caja de herramientas (botón **🧰 Avanzado**) reúne 102 geoprocesos equivalentes a los de QGIS (Processing) y ArcGIS Desktop (ArcToolbox).
Se eligieron a partir del inventario de las dos instalaciones: 286 algoritmos propios de QGIS 3.40 (`qgis_process list`) y unas 630 funciones de ArcPy 10.8.

## Cómo se usan

- Cada herramienta pide una **capa de entrada** (una capa de Lugares o la selección actual) y sus parámetros.
- El resultado va a una **capa nueva** en Lugares, como en QGIS. Las de selección marcan objetos; las de atributos y cartografía editan en sitio.
- Todo se puede deshacer con Ctrl+Z.
- `OGE.tools.selfTest()` en la consola ejecuta todas las que no usan red con datos de muestra.

## Catálogo

### Geometría

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Buffer (área de influencia) | native:buffer | Buffer |
| Buffer de anillos múltiples | native:multiringconstantbuffer | MultipleRingBuffer |
| Buffer de un solo lado | native:singlesidedbuffer | Buffer (LEFT / RIGHT) |
| Buffer en cuña (sector) | native:wedgebuffers | — |
| Centroides | native:centroids / pointonsurface | FeatureToPoint |
| Envolvente convexa | native:convexhull | MinimumBoundingGeometry (CONVEX_HULL) |
| Envolvente cóncava | native:concavehull | AggregatePoints |
| Cajas delimitadoras / extensión de la capa | native:boundingboxes / polygonfromlayerextent | MinimumBoundingGeometry (ENVELOPE) |
| Círculo mínimo envolvente | native:minimumenclosingcircle | MinimumBoundingGeometry (CIRCLE) |
| Rectángulo mínimo orientado | native:orientedminimumboundingbox | MinimumBoundingGeometry (RECTANGLE_BY_AREA) |
| Simplificar | native:simplifygeometries | SimplifyLine / SimplifyPolygon / Generalize |
| Suavizar | native:smoothgeometry | SmoothLine / SmoothPolygon |
| Densificar por intervalo | native:densifygeometriesgivenaninterval | Densify |
| Polígonos a líneas | native:polygonstolines / boundary | PolygonToLine / FeatureToLine |
| Líneas a polígonos | qgis:linestopolygons | FeatureToPolygon |
| Poligonizar (áreas cerradas por líneas) | native:polygonize | FeatureToPolygon |
| Extraer vértices | native:extractvertices / extractspecificvertices | FeatureVerticesToPoints |
| Explotar líneas (un tramo por segmento) | native:explodelines | SplitLine |
| Disolver | native:dissolve | Dissolve |
| Eliminar agujeros | native:deleteholes | EliminatePolygonPart |
| Invertir dirección de línea | native:reverselinedirection | FlipLine |
| Línea paralela / matriz de paralelas | native:offsetline / arrayoffsetlines | Copy Parallel |
| Trasladar / matriz de copias | native:translategeometry / arraytranslatedfeatures | Move / Array |
| Rotar | native:rotatefeatures | Rotate |
| Escalar | native:affinetransform | Scale |
| Intercambiar X e Y | native:swapxy | — |
| Teselar (triangular polígonos) | 3d:tessellate | — |
| Triangulación de Delaunay | native:delaunaytriangulation | CreateTin |
| Polígonos de Voronoi (Thiessen) | native:voronoipolygons | CreateThiessenPolygons |
| Extender líneas | native:extendlines | ExtendLine |
| Subcadena de línea | native:linesubstring | TrimLine |
| Dividir líneas por longitud | native:splitlinesbylength | GeneratePointsAlongLines + SplitLineAtPoint |
| Dividir con líneas | native:splitwithlines | Split / SplitLineAtPoint |
| Intersecciones de líneas | native:lineintersections | Intersect (salida de puntos) |
| Unir líneas | native:mergelines | UnsplitLine / Dissolve |
| Puntos a ruta | native:pointstopath | PointsToLine |
| Puntos a lo largo de líneas | native:pointsalonglines | GeneratePointsAlongLines |
| Transectos (líneas perpendiculares) | native:transect | GenerateTransectsAlongLines |
| Línea geodésica entre puntos | native:pointstopath (geodésica) | XYToLine (GEODESIC) |
| Rectángulos, óvalos y rombos | native:rectanglesovalsdiamonds | — |
| Reparar geometrías | native:fixgeometries / removeduplicatevertices / forcerhr | RepairGeometry |
| Comprobar validez | qgis:checkvalidity | CheckGeometry |
| Eliminar geometrías duplicadas | native:deleteduplicategeometries | DeleteIdentical |
| Ajustar geometrías a capa | native:snapgeometries | Snap / Integrate |
| Ajustar a rejilla | native:snappointstogrid | Integrate (XY tolerance) |

### Superposición

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Recortar | native:clip | Clip |
| Diferencia (borrar) | native:difference | Erase |
| Intersección | native:intersection | Intersect |
| Unión (superposición) | native:union | Union |
| Diferencia simétrica | native:symmetricaldifference | SymDiff |
| Identidad | native:union (parte de la entrada) | Identity |
| Actualizar | native:difference + mergevectorlayers | Update |
| Extraer o recortar por la vista actual | native:extractbyextent | Clip (extensión) |
| Análisis de solape | native:calculatevectoroverlaps | TabulateIntersection |
| Vecinos de polígonos | — | PolygonNeighbors |

### Selección

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Seleccionar por atributo | native:extractbyattribute | SelectLayerByAttribute / Select |
| Seleccionar por expresión | native:extractbyexpression | SelectLayerByAttribute (SQL) |
| Seleccionar por localización | native:extractbylocation / extractwithindistance | SelectLayerByLocation |
| Selección aleatoria | native:randomextract | SubsetFeatures |
| Filtrar por tipo de geometría | native:filterbygeometry | Select (SHAPE) |

### Análisis

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Contar puntos en polígonos | native:countpointsinpolygon | SpatialJoin (COUNT) |
| Unir atributos por localización | native:joinattributesbylocation | SpatialJoin |
| Unir al más cercano (distancia) | native:joinbynearest | Near / SpatialJoin (CLOSEST) |
| Matriz de distancias | qgis:distancematrix | PointDistance / GenerateNearTable |
| Línea más corta entre objetos | native:shortestline | Near (con líneas) |
| Análisis de vecino más próximo | native:nearestneighbouranalysis | AverageNearestNeighbor |
| Coordenadas medias (centro medio) | native:meancoordinates | MeanCenter |
| Elipse de desviación estándar | — | DirectionalDistribution |
| Sumar longitudes de líneas por polígono | native:sumlinelengths | SummarizeWithin |
| Estadísticas básicas de un campo | native:basicstatisticsforfields | Statistics |
| Valores únicos y frecuencia | qgis:listuniquevalues | Frequency |
| Estadísticas por categorías | qgis:statisticsbycategories | Statistics (case field) |
| Agrupamiento DBSCAN | native:dbscanclustering | DensityBasedClustering |
| Agrupamiento K-medias | native:kmeansclustering | MultivariateClustering |
| Agregar puntos en hexágonos | native:creategrid + countpointsinpolygon | AggregatePoints / GenerateTessellation |
| Interpolación IDW | qgis:idwinterpolation | IDW |
| Isolíneas desde puntos | Interpolación + gdal:contour | IDW + Contour |

### Creación

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Crear rejilla (vista actual) | native:creategrid / regularpoints | CreateFishnet / GenerateTessellation |
| Puntos aleatorios (vista actual) | native:randompointsinextent | CreateRandomPoints |
| Puntos aleatorios en polígonos | native:randompointsinpolygons | CreateRandomPoints (constraining) |
| Puntos aleatorios sobre líneas | native:randompointsonlines | CreateRandomPoints (sobre líneas) |
| Proyectar puntos (rumbo y distancia) | native:projectpointcartesian | BearingDistanceToLine |
| Extensión de la vista a polígono | native:extenttolayer | MapExtent → polígono |
| Descargar de OpenStreetMap (vista actual) | Complemento QuickOSM | — |

### Atributos

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Ver tabla de atributos | Tabla de atributos / exporttospreadsheet | Tabla de atributos / TableToExcel |
| Calculadora de campos | native:fieldcalculator | CalculateField |
| Añadir atributos de geometría | qgis:exportaddgeometrycolumns / addxyfields | AddGeometryAttributes / AddXY |
| Añadir campo autoincremental | native:addautoincrementalfield | CalculateField (secuencia) |
| Eliminar campo | native:deletecolumn | DeleteField |
| Renombrar campo | native:renametablefield | AlterField |

### Terreno

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Perfil de elevación | Perfil de elevación / qgis:climbalongline | StackProfile / InterpolateShape |
| Muestrear elevación | native:rastersampling / setzfromraster / zonalstatisticsfb | ExtractValuesToPoints / AddSurfaceInformation / ZonalStatistics |
| Curvas de nivel (vista actual) | gdal:contour | Contour |
| Sombreado del relieve (vista actual) | native:hillshade | Hillshade |
| Pendiente (vista actual) | native:slope | Slope |
| Cuenca visual | grass:r.viewshed | Viewshed (también en Earth Pro) |

### Cartografía

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Simbología por categorías o graduada | Simbología categorizada / graduada | Simbología: Unique Values / Graduated Colors |
| Etiquetar por campo | Etiquetado de capa | Label Features |
| Coloreado topológico | qgis:topologicalcoloring | — |

### Topología

| Herramienta | QGIS | ArcGIS |
|---|---|---|
| Comprobar topología (huecos y solapes) | native:coveragevalidate / Comprobador de topología | Topología: Must Not Overlap / Must Not Have Gaps |
| Eliminar astillas | qgis:eliminateselectedpolygons | Eliminate |

## Operaciones de trayecto (barra inferior, sobre la selección)

Unión, Diferencia, Intersección, Exclusión, División, Cortar con línea, Entre líneas, Transferir área y Cerrar huecos. Reemplazan los objetos en su misma capa, al estilo del menú Trayecto de Inkscape.

## Lo que no se implementó y por qué

| Familia (QGIS / ArcGIS) | Motivo |
|---|---|
| Ráster propio: álgebra de mapas, reclasificar, estadísticas de celdas, GDAL, Spatial Analyst | OpenGISEarth no carga rásteres del usuario; solo usa el relieve en línea (perfil, curvas, sombreado, pendiente, cuenca visual). |
| Análisis de redes: ruta más corta, áreas de servicio, Network Analyst | Requiere construir y resolver un grafo de red. |
| Nubes de puntos (PDAL), mallas y TIN 3D (3D Analyst) | Fuera del alcance de un visor de globo con datos vectoriales. |
| Bases de datos en servidor: PostGIS, SQL Server, geodatabases corporativas, versiones | El programa no tiene un componente que hable esos protocolos. Sí abre y guarda **GeoPackage** (.gpkg) y permite consultas SQL sobre una capa. |
| Atlas, varias páginas y plantillas de diseño | Existe el diseño de impresión de una hoja (🖨 Mapa: PDF, PNG o SVG vectorial con título, leyenda, escala y norte), sin atlas ni plantillas. |
| Reproyección y definición de sistemas de coordenadas | Todo se trabaja en WGS84; los Shapefile con `.prj` se reproyectan al abrirlos. |
| GRASS (307) y SAGA (589) | Son proveedores externos de QGIS, no herramientas propias. |
| Generalización cartográfica de ArcGIS (resolver conflictos, fusionar vías divididas, representaciones) | Dependen del motor de simbología de ArcMap. |
| Geocodificación por lotes, referencias lineales, tejido parcelario, esquemáticos | Módulos especializados de ArcGIS sin equivalente directo. |

## Límites conocidos

- Los cálculos usan turf.js en lon/lat: los objetos que cruzan el antimeridiano no se procesan bien.
- Capas muy grandes (miles de polígonos) son lentas: cada objeto es una entidad del globo.
- «Descargar de OpenStreetMap» depende de los servidores públicos Overpass, que se saturan a menudo.

## Formatos

- **Abrir:** KML, KMZ, GeoJSON, Shapefile (.zip o .shp), GeoPackage (.gpkg), trazados SVG (se pide su extensión geográfica), GPX y CSV con lat/lon.
- **Guardar (💾 en cada capa):** KMZ, KML, GeoJSON, Shapefile (.zip), GeoPackage, SVG vectorial y CSV.
- **Mapa (🖨):** PDF, PNG o SVG vectorial de la vista actual.
