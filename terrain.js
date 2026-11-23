// Relieve 3D abierto: AWS Terrain Tiles (formato Terrarium; SRTM, GMTED, ETOPO1 y otros), sin clave.
// Cada tesela PNG de 256 px se decodifica a alturas: h = R*256 + G + B/256 - 32768.
// También expone OGE.dem para las herramientas de terreno (perfil, curvas de nivel, sombreado, cuenca visual).
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const scene = viewer.scene;
  const N = 65;          // muestras por lado de cada tesela de relieve
  const MAX_LEVEL = 13;  // más detalle no aporta en los datos de origen y gasta red
  const MAXLAT = 85.0511;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Teselas Web Mercator decodificadas a metros enteros (Int16: 128 KB cada una), con caché LRU.
  const cache = new Map(); // "z/x/y" -> Promise<Int16Array>
  function tile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let p = cache.get(key);
    if (p) { cache.delete(key); cache.set(key, p); return p; }
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    p = (async () => {
      // fetch + createImageBitmap: a diferencia de img.decode(), no se detiene con la ventana oculta o minimizada
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
  // Posición (en teselas, con decimales) de un lon/lat al zoom z.
  const mercX = (lon, n) => ((lon + 180) / 360) * n;
  const mercY = (lat, n) => ((1 - Math.log(Math.tan(Math.PI / 4 + (Math.max(-MAXLAT, Math.min(MAXLAT, lat)) * Math.PI) / 360)) / Math.PI) / 2) * n;
  // Alturas de una lista de [lon, lat] al zoom z (vecino más cercano).
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
  // Zoom cuya resolución se acerca a «metros por muestra» en la latitud dada (píxel = 156543 m · cos(lat) / 2^z).
  const zoomFor = (mps, lat) => Math.max(0, Math.min(14, Math.round(Math.log2((156543 * Math.cos((lat * Math.PI) / 180)) / Math.max(1, mps)))));
  OGE.dem = {
    sample, zoomFor,
    // Rejilla nx × ny de alturas sobre bbox [o, s, e, n]; la fila 0 es el norte. Devuelve también el tamaño de celda en metros.
    async grid(bbox, nx, ny) {
      const [w, s, e, n] = bbox, lat = (s + n) / 2, dx = ((e - w) / (nx - 1)) * 111320 * Math.cos((lat * Math.PI) / 180), dy = ((n - s) / (ny - 1)) * 110540;
      const lls = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) lls.push([w + ((e - w) * i) / (nx - 1), n - ((n - s) * j) / (ny - 1)]);
      return { z: Float32Array.from(await sample(lls, zoomFor(Math.min(dx, dy), lat))), nx, ny, dx, dy, bbox };
    },
  };

  // Las teselas Terrarium son Web Mercator (sin datos más allá de ±85°). El globo usa teselas geográficas,
  // así cubre también los polos: cada tesela geográfica se arma muestreando las teselas Mercator que toca.
  const geoScheme = new C.GeographicTilingScheme();
  const terrain = new C.CustomHeightmapTerrainProvider({
    width: N, height: N, tilingScheme: geoScheme,
    credit: 'Relieve: AWS Terrain Tiles (Mapzen; SRTM, GMTED, ETOPO1 y otros)',
    callback: async (x, y, level) => {
      if (level > MAX_LEVEL) return undefined; // Cesium refina a partir del nivel anterior
      const r = geoScheme.tileXYToRectangle(x, y, level), lls = [];
      for (let j = 0; j < N; j++) {
        const lat = C.Math.toDegrees(r.north - (j / (N - 1)) * r.height);
        for (let i = 0; i < N; i++) lls.push([C.Math.toDegrees(r.west + (i / (N - 1)) * r.width), lat]);
      }
      return Float32Array.from(await sample(lls, Math.min(level + 1, 15))); // mismo ancho en grados que la tesela geográfica
    },
  });
  const flatTerrain = new C.EllipsoidTerrainProvider();

  scene.globe.depthTestAgainstTerrain = true; // los clics caen sobre el relieve, no debajo
  const cb = $('layerTerrain'), ex = $('exaggeration'), exVal = $('exaggerationVal');
  const reset = () => OGE.layers && OGE.layers.resetBuildings(); // los edificios se apoyan en la altura del relieve
  const setTerrain = () => { scene.terrainProvider = cb.checked ? terrain : flatTerrain; reset(); };
  const setEx = () => { scene.verticalExaggeration = Number(ex.value); exVal.textContent = Number(ex.value).toFixed(1) + '×'; };
  cb.onchange = setTerrain;
  ex.oninput = setEx;
  ex.onchange = reset;
  setTerrain();
  setEx();
  OGE.terrain = terrain;
})();
