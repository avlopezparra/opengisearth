// Open 3D terrain: AWS Terrain Tiles (Terrarium format; SRTM, GMTED, ETOPO1 and others), no key.
// Each 256 px PNG tile is decoded to heights: h = R*256 + G + B/256 - 32768.
// It also exposes OGE.dem for the terrain tools (profile, contour lines, hillshade, viewshed).
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const scene = viewer.scene;
  const N = 65;          // samples per side of each terrain tile
  const MAX_LEVEL = 13;  // more detail adds nothing in the source data and wastes network
  const MAXLAT = 85.0511;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Web Mercator tiles decoded to whole meters (Int16: 128 KB each), with LRU cache.
  const cache = new Map(); // "z/x/y" -> Promise<Int16Array>
  function tile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let p = cache.get(key);
    if (p) { cache.delete(key); cache.set(key, p); return p; }
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    p = (async () => {
      // fetch + createImageBitmap: unlike img.decode(), it does not stall with the window hidden or minimized
      const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const img = await createImageBitmap(await res.blob());
      ctx.drawImage(img, 0, 0);
      img.close();
      const px = ctx.getImageData(0, 0, 256, 256).data, h = new Int16Array(65536);
      for (let i = 0; i < 65536; i++) h[i] = Math.round(px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768);
      return h;
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    return p;
  }
  // Position (in tiles, fractional) of a lon/lat at zoom z.
  const mercX = (lon, n) => ((lon + 180) / 360) * n;
  const mercY = (lat, n) => ((1 - Math.log(Math.tan(Math.PI / 4 + (Math.max(-MAXLAT, Math.min(MAXLAT, lat)) * Math.PI) / 360)) / Math.PI) / 2) * n;
  // Heights of a list of [lon, lat] at zoom z (nearest neighbor).
  async function sample(lls, z) {
    const n = 2 ** z, need = new Map(), refs = [];
    for (const [lon, lat] of lls) {
      const mx = mercX(((lon + 540) % 360) - 180, n), my = mercY(lat, n);
      const tx = Math.min(n - 1, Math.floor(mx)), ty = Math.min(n - 1, Math.max(0, Math.floor(my))), k = tx + ',' + ty;
      if (!need.has(k)) need.set(k, tile(z, tx, ty));
      refs.push([k, Math.min(255, Math.max(0, Math.floor((my - ty) * 256))) * 256 + Math.min(255, Math.floor((mx - tx) * 256))]);
    }
    const tiles = new Map(await Promise.all([...need].map(async ([k, p]) => [k, await p.catch(() => null)])));
    return refs.map(([k, o]) => { const t = tiles.get(k); return t ? t[o] : 0; });
  }
  // Zoom whose resolution is close to "meters per sample" at the given latitude (pixel = 156543 m · cos(lat) / 2^z).
  const zoomFor = (mps, lat) => Math.max(0, Math.min(14, Math.round(Math.log2((156543 * Math.cos((lat * Math.PI) / 180)) / Math.max(1, mps)))));
  OGE.dem = {
    sample, zoomFor,
    // nx × ny grid of heights over bbox [w, s, e, n]; row 0 is the north. Also returns the cell size in meters.
    async grid(bbox, nx, ny) {
      const [w, s, e, n] = bbox, lat = (s + n) / 2, dx = ((e - w) / (nx - 1)) * 111320 * Math.cos((lat * Math.PI) / 180), dy = ((n - s) / (ny - 1)) * 110540;
      const lls = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) lls.push([w + ((e - w) * i) / (nx - 1), n - ((n - s) * j) / (ny - 1)]);
      return { z: Float32Array.from(await sample(lls, zoomFor(Math.min(dx, dy), lat))), nx, ny, dx, dy, bbox };
    },
  };

  // Terrarium tiles are Web Mercator (no data beyond ±85°). The globe uses geographic tiles,
  // so it also covers the poles: each geographic tile is built by sampling the Mercator tiles it touches.
  const geoScheme = new C.GeographicTilingScheme();
  const terrain = new C.CustomHeightmapTerrainProvider({
    width: N, height: N, tilingScheme: geoScheme,
    credit: 'Relieve: AWS Terrain Tiles (Mapzen; SRTM, GMTED, ETOPO1 y otros)',
    callback: async (x, y, level) => {
      if (level > MAX_LEVEL) return undefined; // Cesium refines from the previous level
      const r = geoScheme.tileXYToRectangle(x, y, level), lls = [];
      for (let j = 0; j < N; j++) {
        const lat = C.Math.toDegrees(r.north - (j / (N - 1)) * r.height);
        for (let i = 0; i < N; i++) lls.push([C.Math.toDegrees(r.west + (i / (N - 1)) * r.width), lat]);
      }
      return Float32Array.from(await sample(lls, Math.min(level + 1, 15))); // same width in degrees as the geographic tile
    },
  });
  const flatTerrain = new C.EllipsoidTerrainProvider();

  scene.globe.depthTestAgainstTerrain = true; // clicks land on the terrain, not below it
  const cb = $('layerTerrain'), ex = $('exaggeration'), exVal = $('exaggerationVal');
  const reset = () => OGE.layers && OGE.layers.resetBuildings(); // buildings rest on the terrain height
  const setTerrain = () => { scene.terrainProvider = cb.checked ? terrain : flatTerrain; reset(); };
  const setEx = () => { scene.verticalExaggeration = Number(ex.value); exVal.textContent = Number(ex.value).toFixed(1) + '×'; };
  cb.onchange = setTerrain;
  ex.oninput = setEx;
  ex.onchange = reset;
  setTerrain();
  setEx();
  OGE.terrain = terrain;
})();
