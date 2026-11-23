# OpenGISEarth — Advanced tools

The toolbox (**🧰 Advanced** button) gathers 102 geoprocessing tools equivalent to those in QGIS (Processing) and ArcGIS Desktop (ArcToolbox).
They were chosen from the inventory of both installations: 286 native QGIS 3.40 algorithms (`qgis_process list`) and about 630 ArcPy 10.8 functions.

## How to use them

- Each tool asks for an **input layer** (a layer from Places or the current selection) and its parameters.
- The result goes to a **new layer** in Places, as in QGIS. Selection tools mark features; attribute and cartography tools edit in place.
- Everything can be undone with Ctrl+Z.
- `OGE.tools.selfTest()` in the console runs every tool that does not use the network on sample data.

## Catalog

### Geometry

| Tool | QGIS | ArcGIS |
|---|---|---|
| Buffer | native:buffer | Buffer |
| Multi-ring buffer | native:multiringconstantbuffer | MultipleRingBuffer |
| Single-sided buffer | native:singlesidedbuffer | Buffer (LEFT / RIGHT) |
| Wedge buffer (sector) | native:wedgebuffers | — |
| Centroids | native:centroids / pointonsurface | FeatureToPoint |
| Convex hull | native:convexhull | MinimumBoundingGeometry (CONVEX_HULL) |
| Concave hull | native:concavehull | AggregatePoints |
| Bounding boxes / layer extent | native:boundingboxes / polygonfromlayerextent | MinimumBoundingGeometry (ENVELOPE) |
| Minimum enclosing circle | native:minimumenclosingcircle | MinimumBoundingGeometry (CIRCLE) |
| Oriented minimum bounding rectangle | native:orientedminimumboundingbox | MinimumBoundingGeometry (RECTANGLE_BY_AREA) |
| Simplify | native:simplifygeometries | SimplifyLine / SimplifyPolygon / Generalize |
| Smooth | native:smoothgeometry | SmoothLine / SmoothPolygon |
| Densify by interval | native:densifygeometriesgivenaninterval | Densify |
| Polygons to lines | native:polygonstolines / boundary | PolygonToLine / FeatureToLine |
| Lines to polygons | qgis:linestopolygons | FeatureToPolygon |
| Polygonize (areas enclosed by lines) | native:polygonize | FeatureToPolygon |
| Extract vertices | native:extractvertices / extractspecificvertices | FeatureVerticesToPoints |
| Explode lines (one feature per segment) | native:explodelines | SplitLine |
| Dissolve | native:dissolve | Dissolve |
| Delete holes | native:deleteholes | EliminatePolygonPart |
| Reverse line direction | native:reverselinedirection | FlipLine |
| Offset line / array of offset lines | native:offsetline / arrayoffsetlines | Copy Parallel |
| Translate / array of copies | native:translategeometry / arraytranslatedfeatures | Move / Array |
| Rotate | native:rotatefeatures | Rotate |
| Scale | native:affinetransform | Scale |
| Swap X and Y | native:swapxy | — |
| Tessellate (triangulate polygons) | 3d:tessellate | — |
| Delaunay triangulation | native:delaunaytriangulation | CreateTin |
| Voronoi (Thiessen) polygons | native:voronoipolygons | CreateThiessenPolygons |
| Extend lines | native:extendlines | ExtendLine |
| Line substring | native:linesubstring | TrimLine |
| Split lines by length | native:splitlinesbylength | GeneratePointsAlongLines + SplitLineAtPoint |
| Split with lines | native:splitwithlines | Split / SplitLineAtPoint |
| Line intersections | native:lineintersections | Intersect (point output) |
| Merge lines | native:mergelines | UnsplitLine / Dissolve |
| Points to path | native:pointstopath | PointsToLine |
| Points along lines | native:pointsalonglines | GeneratePointsAlongLines |
| Transects (perpendicular lines) | native:transect | GenerateTransectsAlongLines |
| Geodesic line between points | native:pointstopath (geodesic) | XYToLine (GEODESIC) |
| Rectangles, ovals and diamonds | native:rectanglesovalsdiamonds | — |
| Fix geometries | native:fixgeometries / removeduplicatevertices / forcerhr | RepairGeometry |
| Check validity | qgis:checkvalidity | CheckGeometry |
| Delete duplicate geometries | native:deleteduplicategeometries | DeleteIdentical |
| Snap geometries to layer | native:snapgeometries | Snap / Integrate |
| Snap to grid | native:snappointstogrid | Integrate (XY tolerance) |

### Overlay

| Tool | QGIS | ArcGIS |
|---|---|---|
| Clip | native:clip | Clip |
| Difference (erase) | native:difference | Erase |
| Intersection | native:intersection | Intersect |
| Union (overlay) | native:union | Union |
| Symmetrical difference | native:symmetricaldifference | SymDiff |
| Identity | native:union (input part) | Identity |
| Update | native:difference + mergevectorlayers | Update |
| Extract or clip by the current view | native:extractbyextent | Clip (extent) |
| Overlap analysis | native:calculatevectoroverlaps | TabulateIntersection |
| Polygon neighbors | — | PolygonNeighbors |

### Selection

| Tool | QGIS | ArcGIS |
|---|---|---|
| Select by attribute | native:extractbyattribute | SelectLayerByAttribute / Select |
| Select by expression | native:extractbyexpression | SelectLayerByAttribute (SQL) |
| Select by location | native:extractbylocation / extractwithindistance | SelectLayerByLocation |
| Random selection | native:randomextract | SubsetFeatures |
| Filter by geometry type | native:filterbygeometry | Select (SHAPE) |

### Analysis

| Tool | QGIS | ArcGIS |
|---|---|---|
| Count points in polygons | native:countpointsinpolygon | SpatialJoin (COUNT) |
| Join attributes by location | native:joinattributesbylocation | SpatialJoin |
| Join to nearest (distance) | native:joinbynearest | Near / SpatialJoin (CLOSEST) |
| Distance matrix | qgis:distancematrix | PointDistance / GenerateNearTable |
| Shortest line between features | native:shortestline | Near (with lines) |
| Nearest neighbor analysis | native:nearestneighbouranalysis | AverageNearestNeighbor |
| Mean coordinates (mean center) | native:meancoordinates | MeanCenter |
| Standard deviational ellipse | — | DirectionalDistribution |
| Sum line lengths per polygon | native:sumlinelengths | SummarizeWithin |
| Basic statistics for a field | native:basicstatisticsforfields | Statistics |
| Unique values and frequency | qgis:listuniquevalues | Frequency |
| Statistics by categories | qgis:statisticsbycategories | Statistics (case field) |
| DBSCAN clustering | native:dbscanclustering | DensityBasedClustering |
| K-means clustering | native:kmeansclustering | MultivariateClustering |
| Aggregate points into hexagons | native:creategrid + countpointsinpolygon | AggregatePoints / GenerateTessellation |
| IDW interpolation | qgis:idwinterpolation | IDW |
| Isolines from points | Interpolation + gdal:contour | IDW + Contour |

### Creation

| Tool | QGIS | ArcGIS |
|---|---|---|
| Create grid (current view) | native:creategrid / regularpoints | CreateFishnet / GenerateTessellation |
| Random points (current view) | native:randompointsinextent | CreateRandomPoints |
| Random points in polygons | native:randompointsinpolygons | CreateRandomPoints (constraining) |
| Random points on lines | native:randompointsonlines | CreateRandomPoints (on lines) |
| Project points (bearing and distance) | native:projectpointcartesian | BearingDistanceToLine |
| View extent to polygon | native:extenttolayer | MapExtent → polygon |
| Download from OpenStreetMap (current view) | QuickOSM plugin | — |

### Attributes

| Tool | QGIS | ArcGIS |
|---|---|---|
| View attribute table | Attribute table / exporttospreadsheet | Attribute table / TableToExcel |
| Field calculator | native:fieldcalculator | CalculateField |
| Add geometry attributes | qgis:exportaddgeometrycolumns / addxyfields | AddGeometryAttributes / AddXY |
| Add auto-incremental field | native:addautoincrementalfield | CalculateField (sequence) |
| Delete field | native:deletecolumn | DeleteField |
| Rename field | native:renametablefield | AlterField |

### Terrain

| Tool | QGIS | ArcGIS |
|---|---|---|
| Elevation profile | Elevation profile / qgis:climbalongline | StackProfile / InterpolateShape |
| Sample elevation | native:rastersampling / setzfromraster / zonalstatisticsfb | ExtractValuesToPoints / AddSurfaceInformation / ZonalStatistics |
| Contour lines (current view) | gdal:contour | Contour |
| Hillshade (current view) | native:hillshade | Hillshade |
| Slope (current view) | native:slope | Slope |
| Viewshed | grass:r.viewshed | Viewshed (also in Earth Pro) |

### Cartography

| Tool | QGIS | ArcGIS |
|---|---|---|
| Categorized or graduated symbology | Categorized / graduated symbology | Symbology: Unique Values / Graduated Colors |
| Label by field | Layer labeling | Label Features |
| Topological coloring | qgis:topologicalcoloring | — |

### Topology

| Tool | QGIS | ArcGIS |
|---|---|---|
| Check topology (gaps and overlaps) | native:coveragevalidate / Topology checker | Topology: Must Not Overlap / Must Not Have Gaps |
| Eliminate slivers | qgis:eliminateselectedpolygons | Eliminate |

## Path operations (bottom bar, on the selection)

Union, Difference, Intersection, Exclusion, Division, Cut with line, Between lines, Transfer area and Close gaps. They replace the features in their own layer, in the style of Inkscape's Path menu.

## What was not implemented and why

| Family (QGIS / ArcGIS) | Reason |
|---|---|
| User rasters: map algebra, reclassify, cell statistics, GDAL, Spatial Analyst | OpenGISEarth does not load user rasters; it only uses the online terrain (profile, contours, hillshade, slope, viewshed). |
| Network analysis: shortest path, service areas, Network Analyst | Requires building and solving a network graph. |
| Point clouds (PDAL), meshes and 3D TINs (3D Analyst) | Out of scope for a globe viewer with vector data. |
| Server databases: PostGIS, SQL Server, enterprise geodatabases, versioning | The program has no component that speaks those protocols. It does open and save **GeoPackage** (.gpkg) and allows SQL queries on a layer. |
| Atlas, multiple pages and layout templates | There is a single-sheet print layout (🖨 Map: PDF, PNG or vector SVG with title, legend, scale and north arrow), without atlas or templates. |
| Reprojection and coordinate system definition | Everything works in WGS84; Shapefiles with a `.prj` are reprojected when opened. |
| GRASS (307) and SAGA (589) | They are external QGIS providers, not native tools. |
| ArcGIS cartographic generalization (resolve conflicts, merge divided roads, representations) | They depend on the ArcMap symbology engine. |
| Batch geocoding, linear referencing, parcel fabric, schematics | Specialized ArcGIS modules with no direct equivalent. |

## Known limits

- Calculations use turf.js in lon/lat: features that cross the antimeridian are not processed correctly.
- Very large layers (thousands of polygons) are slow: each feature is a globe entity.
- "Download from OpenStreetMap" depends on the public Overpass servers, which are often overloaded.

## Formats

- **Open:** KML, KMZ, GeoJSON, Shapefile (.zip or .shp), GeoPackage (.gpkg), SVG paths (their geographic extent is requested), GPX and CSV with lat/lon.
- **Save (💾 on each layer):** KMZ, KML, GeoJSON, Shapefile (.zip), GeoPackage, vector SVG and CSV.
- **Map (🖨):** PDF, PNG or vector SVG of the current view.
