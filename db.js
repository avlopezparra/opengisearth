// OpenGISEarth — bases de datos: abre y guarda GeoPackage (.gpkg, la base de datos SIG abierta que usa QGIS)
// y permite consultar una capa con SQL. Usa SQLite compilado a WebAssembly (sql.js), todo dentro del programa.
// shortcut: no hay conexión a servidores (PostGIS, SQL Server): el visor no tiene un componente que hable esos protocolos.
(() => {
  const { geo } = OGE;
  let ready = null;
  const sqlite = () => ready || (ready = initSqlJs({ locateFile: (f) => 'vendor/' + f }));
  const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

  // ---------- WKB (geometría binaria) ----------
  function readWkb(dv, o) {
    const le = dv.getUint8(o.p) === 1;
    let t = dv.getUint32(o.p + 1, le), dims = 2;
    o.p += 5;
    if (t & 0x80000000) dims++;
    if (t & 0x40000000) dims++;
    if (t & 0x20000000) o.p += 4; // SRID de EWKB
    t &= 0xffff;
    if (t >= 3000) { dims = 4; t -= 3000; } else if (t >= 1000) { dims = 3; t %= 1000; }
    const n = () => { const v = dv.getUint32(o.p, le); o.p += 4; return v; };
    const pt = () => { const c = [dv.getFloat64(o.p, le), dv.getFloat64(o.p + 8, le)]; o.p += 8 * dims; return c; };
    const pts = () => Array.from({ length: n() }, pt), rings = () => Array.from({ length: n() }, pts), many = () => Array.from({ length: n() }, () => readWkb(dv, o));
    switch (t) {
      case 1: return { type: 'Point', coordinates: pt() };
      case 2: return { type: 'LineString', coordinates: pts() };
      case 3: return { type: 'Polygon', coordinates: rings() };
      case 4: return { type: 'MultiPoint', coordinates: many().map((g) => g.coordinates) };
      case 5: return { type: 'MultiLineString', coordinates: many().map((g) => g.coordinates) };
      case 6: return { type: 'MultiPolygon', coordinates: many().map((g) => g.coordinates) };
      case 7: return { type: 'GeometryCollection', geometries: many() };
      default: throw new Error('tipo de geometría WKB no soportado: ' + t);
    }
  }
  function writeWkb(g) { // 2D, little endian
    const out = [];
    const u8 = (v) => out.push(v), u32 = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v, true); out.push(...new Uint8Array(b.buffer)); };
    const f64 = (v) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); out.push(...new Uint8Array(b.buffer)); };
    const pts = (cs) => { u32(cs.length); cs.forEach((c) => { f64(c[0]); f64(c[1]); }); };
    u8(1);
    if (g.type === 'Point') { u32(1); f64(g.coordinates[0]); f64(g.coordinates[1]); }
    else if (g.type === 'LineString') { u32(2); pts(g.coordinates); }
    else { u32(3); u32(g.coordinates.length); g.coordinates.forEach(pts); }
    return out;
  }
  // Cabecera de GeoPackage: «GP», versión, banderas (bits 1-3 = tamaño del envolvente), SRID, envolvente y luego el WKB.
  const fromGpb = (b) => readWkb(new DataView(b.buffer, b.byteOffset + 8 + ([0, 32, 48, 48, 64][(b[3] >> 1) & 7] || 0)), { p: 0 });
  const toGpb = (g) => new Uint8Array([0x47, 0x50, 0, 1, 0xe6, 0x10, 0, 0, ...writeWkb(g)]); // SRID 4326

  // ---------- Abrir: cada tabla de objetos pasa a ser una capa ----------
  async function open(file) {
    const SQL = await sqlite(), db = new SQL.Database(new Uint8Array(await file.arrayBuffer())), layers = [];
    try {
      let tables;
      try { tables = db.exec("SELECT c.table_name, g.column_name, g.srs_id FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name WHERE c.data_type = 'features'"); }
      catch { throw new Error('no es un GeoPackage (faltan sus tablas gpkg_*)'); }
      for (const [table, geomCol, srs] of tables[0] ? tables[0].values : []) {
        if (srs !== 4326) OGE.toast(`«${table}» usa el sistema de coordenadas ${srs}, no WGS84 (4326): puede quedar fuera de lugar.`, true);
        const res = db.exec('SELECT * FROM ' + ident(table))[0], feats = [];
        if (!res) continue;
        const gi = res.columns.indexOf(geomCol);
        for (const row of res.values) {
          if (!row[gi]) continue;
          const p = {};
          res.columns.forEach((c, i) => { if (i !== gi && c !== 'fid' && row[i] != null && !(row[i] instanceof Uint8Array)) p[c] = row[i]; });
          try { feats.push({ type: 'Feature', geometry: fromGpb(row[gi]), properties: p }); } catch { /* geometría ilegible: se omite */ }
        }
        if (feats.length) layers.push(geo.addGroup(table, feats, { style: { marker: feats.length > 150 ? 'dot' : 'pin' } }));
      }
    } finally { db.close(); }
    if (!layers.length) throw new Error('no contiene capas de objetos');
    return layers;
  }

  // ---------- Guardar una capa como GeoPackage ----------
  async function save(ds) {
    const SQL = await sqlite(), db = new SQL.Database(), fs = geo.features(ds).filter((f) => f.oge.kind !== 'image');
    if (!fs.length) throw new Error('la capa no tiene geometrías');
    const table = ds.name.replace(/[^\w]+/g, '_').replace(/^(\d)/, '_$1') || 'capa';
    const keys = [...new Set(fs.flatMap((f) => Object.keys(f.properties)))].filter((k) => !/^(fid|geom|nombre)$/i.test(k));
    const type = (k) => (fs.every((f) => f.properties[k] == null || typeof f.properties[k] === 'number') ? 'REAL' : 'TEXT');
    const b = fs.reduce((a, f) => { const x = turf.bbox(f); return [Math.min(a[0], x[0]), Math.min(a[1], x[1]), Math.max(a[2], x[2]), Math.max(a[3], x[3])]; }, [180, 90, -180, -90]);
    db.run(`PRAGMA application_id = 1196444487; PRAGMA user_version = 10200;
      CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
      INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84 geodetic', 4326, 'EPSG', 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]', NULL),
        ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', NULL), ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', NULL);
      CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);
      CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, PRIMARY KEY (table_name, column_name));
      CREATE TABLE ${ident(table)} (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, nombre TEXT${keys.map((k) => ', ' + ident(k) + ' ' + type(k)).join('')});`);
    db.run('INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES (?, ?, ?, ?, ?, ?, ?, 4326)', [table, 'features', ds.name, ...b]);
    db.run("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', 'GEOMETRY', 4326, 0, 0)", [table]);
    const ins = db.prepare(`INSERT INTO ${ident(table)} (geom, nombre${keys.map((k) => ', ' + ident(k)).join('')}) VALUES (?, ?${keys.map(() => ', ?').join('')})`);
    for (const f of fs) ins.run([toGpb(f.geometry), f.oge.name, ...keys.map((k) => { const v = f.properties[k]; return v == null ? null : typeof v === 'object' ? JSON.stringify(v) : v; })]);
    ins.free();
    const bytes = db.export();
    db.close();
    return new Blob([bytes], { type: 'application/geopackage+sqlite3' });
  }

  // ---------- Consulta SQL sobre los objetos de una capa (tabla «capa») ----------
  async function query(fs, text) {
    const SQL = await sqlite(), db = new SQL.Database(), keys = [...new Set(fs.flatMap((f) => Object.keys(f.properties)))].filter((k) => !/^(nombre|tipo|area_m2|longitud_m|lon|lat)$/i.test(k));
    try {
      db.run(`CREATE TABLE capa (nombre TEXT, tipo TEXT, area_m2 REAL, longitud_m REAL, lon REAL, lat REAL${keys.map((k) => ', ' + ident(k)).join('')})`);
      const ins = db.prepare(`INSERT INTO capa VALUES (?, ?, ?, ?, ?, ?${keys.map(() => ', ?').join('')})`);
      for (const f of fs) {
        const poly = f.geometry.type === 'Polygon', c = f.geometry.type === 'Point' ? f.geometry.coordinates : turf.centroid(f).geometry.coordinates;
        ins.run([f.oge.name, f.oge.kind, poly ? turf.area(f) : 0, f.geometry.type === 'Point' ? 0 : turf.length(f) * 1000, c[0], c[1], ...keys.map((k) => { const v = f.properties[k]; return v == null ? null : typeof v === 'object' ? JSON.stringify(v) : v; })]);
      }
      ins.free();
      const res = db.exec(text)[0];
      return res ? [res.columns, res.values] : [['resultado'], [['La consulta no devolvió filas.']]];
    } finally { db.close(); }
  }
  OGE.db = { open, save, query };
})();
