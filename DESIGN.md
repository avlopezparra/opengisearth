# OpenGISEarth — Design

Open-source replacement for the Google Earth Pro desktop app, with serious GIS editing.
Based on static analysis (class/function names and strings; no decompiled code was copied) of
Google Earth Pro, ArcGIS Desktop 10.8, QGIS 3.40 and the making-history region editor.

## Product goal
As intuitive as Google Earth: 3D globe, clouds, image overlays, paths and polygons,
flight simulator, KML/KMZ. Plus: editing with snapping, topology and undo.

## Stack
- Engine: **CesiumJS** (globe, terrain, quadtree + LOD, KML, camera, altitude modes).
- Desktop: **Tauri** (or Electron).
- Geometry: turf.js / JSTS (equivalent to shapely/GEOS).
- Open data: Sentinel-2 cloudless (EOX), NASA GIBS (includes real clouds), Copernicus DEM GLO-30,
  OpenStreetMap, Natural Earth. **Never** Google imagery or terrain.

## Interface (like Google Earth)
- Search box at the top left; "My places" panel (folder tree with checkboxes).
- Toolbar: Placemark, Path, Polygon, Image overlay, Ruler, Tour, Flight simulator.
- Navigation controls in the corner; modal edit dialog (OK confirms, Cancel restores).
- "Create features" panel with templates (an ArcGIS idea): layer + style + default attributes + tool.

## Architecture
### Object model (from Google Earth)
KML-like hierarchy: Document/Folder → Placemark (Point, LineString, LinearRing, Polygon, Multi*),
GroundOverlay, views (Camera/LookAt), styles, TimeSpan, ExtendedData.
Reflective fields: every change is a record `{object, field, before, after}` that can be interpolated,
so it serves both undo and tour animation.

### Edit session (from QGIS + ArcGIS)
- A single **EditorService**: session, event bus, active template, sketch in progress.
- In-memory **change buffer** (additions, deletions, geometries, attributes); on read it is applied over the source.
- **Undo**: command stack (AddFeature, DeleteFeature, ChangeGeometry, ChangeAttribute);
  `beginEditCommand/endEditCommand` groups into one step; `mergeWith` merges vertex drags.
  A separate, small stack for the sketch in progress.
- **Save**: staged, batched, with an error list per stage; validation before writing
  (valid geometry, no slivers, no broken meshes — from making-history).

### Tools
Placemark, path, polygon, edit vertices (move / insert by dragging from an edge / delete with Alt+click),
reshape, split, merge, cut, fill gap, create a region by following borders, delete a region by merging it into its neighbor.
Drawing constraints (angle, distance) as an independent module.

### Snapping and topology
- One spatial index per layer; targets: vertex, edge, segment midpoint, endpoint, centroid.
- Tolerance in **pixels**, converted to meters according to the zoom.
- Two clicks on a border = follow it node by node (making-history).
- Topology can be switched on per project: a shared node moves in all its features;
  temporary topological graph of the edited area only (ArcGIS); insert vertices in neighbors (QGIS);
  "avoid intersections" option that clips new polygons.

### Globe and rendering
Cesium already provides: quadtree tiles with screen-space-error LOD, terrain, ground-clamped geometry
re-tessellated as terrain refines, KML Region/Lod. Navigation as a state machine over interchangeable
motion models (orbit, tilt, ground level, "swoop" flight, simulator).

### Special features
- **Clouds**: GIBS layer (real) + Cesium procedural clouds.
- **Image overlay**: GroundOverlay with draggable corners and opacity; saved in KML.
- **Flight simulator**: glTF model, simple physics (thrust, lift, roll), keyboard/joystick, chase camera.
- **KML/KMZ**: read and write (KMZ = zip with doc.kml; rewrite relative paths on save).
- **Antimeridian**: mandatory from day one (making-history does not support it).

## Lessons from making-history
- Reuse: tool set, border following, topology, validation on save, on-disk copy per save.
- Avoid: flat lon/lat view, the 1,500-object cap and 20 s precomputation (use vector tiles),
  giant files (split into modules from the start).

## Phases
1. Globe + open imagery/terrain + search (Nominatim) + My places panel + open/save KML/KMZ.
2. Placemark, path, polygon, image overlay, ruler; undo.
3. GIS editing: vertices, snapping, topology, split/merge/cut.
4. Clouds, tours, flight simulator.
5. Region editor mode (making-history import/export via GeoJSON).

## Pending / not verified
- Nothing was decompiled: Ghidra could not handle `googleearth_pro.dll` (40 MB) and the ArcGIS search was cut short.
  Everything above is inferred from class/function names.
- Not reviewed: ArcGIS `EditTools.dll` (undo/snapping/reshape), Google Earth IG* DLLs, making-history `transfer.py`.
