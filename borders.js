// International borders and country names from the corrected Natural Earth fork (Chile–Argentina with LSIB).
// The fork's shapefiles are read live (there is no local copy); shpjs converts them to GeoJSON.
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const FORK = 'https://raw.githubusercontent.com/avlopezparra/natural-earth-vector/master/';

  async function loadShp(path) {
    const [shpBuf, dbfBuf] = await Promise.all(['.shp', '.dbf'].map((ext) => fetch(FORK + path + ext).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    })));
    return shp.combine([shp.parseShp(shpBuf), shp.parseDbf(dbfBuf)]);
  }
  // Loads a layer the first time it is switched on; if it fails, it is retried when the checkbox is ticked again.
  function lazy(cb, load, what) {
    let state = 0, prim = null; // 0 not loaded, 1 loading, 2 ready
    const sync = async () => {
      if (prim) prim.show = cb.checked;
      if (!cb.checked || state) return;
      state = 1;
      try { prim = await load(); prim.show = cb.checked; state = 2; } catch (e) { state = 0; OGE.toast(`No se pudieron cargar ${what}: ${e.message}`, true); }
    };
    cb.addEventListener('change', sync);
    sync();
  }

  // --- Borders: lines clamped to the ground (GroundPolyline), they follow the terrain instead of ending up under the mountains ---
  lazy($('borders'), async () => {
    const gj = await loadShp('10m_cultural/ne_10m_admin_0_boundary_lines_land'), instances = [];
    for (const f of gj.features) {
      const disputed = /Disputed|Indefinite|Line of control|Unrecognized/i.test(f.properties.FEATURECLA || '');
      for (const p of f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates) {
        if (p.length < 2) continue;
        instances.push(new C.GeometryInstance({
          geometry: new C.GroundPolylineGeometry({ positions: C.Cartesian3.fromDegreesArray(p.flatMap(([lon, lat]) => [lon, lat])), width: 2.5 }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(disputed ? C.Color.ORANGE : C.Color.YELLOW) }, // disputed: orange
        }));
      }
    }
    return viewer.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({ geometryInstances: instances, appearance: new C.PolylineColorAppearance() }));
  }, 'las fronteras');

  // Labels that are not clipped against the terrain (the mountains used to "eat" the letters);
  // the ones on the far side of the globe are hidden by hand every frame.
  const clean = (s) => String(s ?? '').replace(/\0/g, '').trim();
  function labelSet(color, px) {
    const labels = viewer.scene.primitives.add(new C.BillboardCollection());
    const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
    viewer.scene.preRender.addEventListener(() => {
      if (!labels.show) return;
      occluder.cameraPosition = viewer.camera.positionWC;
      for (let i = 0; i < labels.length; i++) { const l = labels.get(i); l.show = occluder.isPointVisible(l.position); }
    });
    labels.put = (lon, lat, text, near, far) => labels.add({
      position: C.Cartesian3.fromDegrees(lon, lat), image: OGE.textImage(text, `600 ${px}px sans-serif`, color), scale: 0.5,
      horizontalOrigin: C.HorizontalOrigin.CENTER, verticalOrigin: C.VerticalOrigin.CENTER,
      distanceDisplayCondition: new C.DistanceDisplayCondition(near, far), disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    return labels;
  }

  // --- Country names (same fork, 50m) ---
  lazy($('layerNames'), async () => {
    const gj = await loadShp('50m_cultural/ne_50m_admin_0_countries'), labels = labelSet(C.Color.WHITE, 15);
    for (const f of gj.features) {
      const p = f.properties;
      // smaller countries appear when zooming in (LABELRANK 2 = large … 10 = very small); very close up they get in the way
      if (p.LABEL_X != null) labels.put(p.LABEL_X, p.LABEL_Y, clean(OGE_LANG === 'en' ? p.NAME_EN : p.NAME_ES) || clean(p.NAME), 1.5e5, 2.2e7 / Math.max(1, (p.LABELRANK || 5) - 1));
    }
    return labels;
  }, 'los nombres de países');

  // --- Disputed areas (same fork): only their boundaries in orange, with no fill or name; clicking tells who administers and who claims ---
  lazy($('layerDisputed'), async () => {
    const gj = await loadShp('10m_cultural/ne_10m_admin_0_disputed_areas'); // no labels: the name appears when clicking the area
    const ds = new C.CustomDataSource('Áreas en disputa'), ORANGE = C.Color.fromCssColorString('#ff9800');
    ds.isLayer = true; // does not appear in Places and is not saved
    const pos = (r) => C.Cartesian3.fromDegreesArray(r.flatMap((c) => [c[0], c[1]]));
    for (const f of gj.features) {
      const p = f.properties, name = clean(OGE_LANG === 'en' ? p.NAME_EN : p.NAME_ES) || clean(p.BRK_NAME) || clean(p.NAME);
      const note = OGE_LANG === 'en' ? clean(p.NOTE_BRK) : clean(p.NOTE_BRK).replace(/Admin\. by/gi, 'Administrado por').replace(/Claimed by/gi, 'reclamado por').replace(/\band\b/gi, 'y').replace(/under survey/gi, 'en estudio');
      const sov = clean(p.SOVEREIGNT), own = [clean(p.BRK_NAME), clean(p.NAME)].includes(sov); // sometimes the "sovereignty" is the name of the area itself
      const description = `<p><b>${name}</b></p><p>${note || T('Área en disputa')}.</p>${own ? '' : `<p>${T('Soberanía según Natural Earth:')} ${sov}.</p>`}`;
      for (const rings of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) {
        if (rings[0].length < 4) continue;
        ds.entities.add({ name, description,
          polygon: { hierarchy: new C.PolygonHierarchy(pos(rings[0].slice(0, -1)), rings.slice(1).map((r) => new C.PolygonHierarchy(pos(r.slice(0, -1))))), material: ORANGE.withAlpha(0.01) } }); // no visible fill: it only serves so the click shows who administers and who claims
      }
    }
    // The edge is not the polygon outline (it would include the coast): it is only the disputed boundaries, from their own file in the fork.
    const lim = await loadShp('10m_cultural/ne_10m_admin_0_boundary_lines_disputed_areas'), inst = [];
    for (const f of lim.features) for (const p of !f.geometry ? [] : f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates) {
      if (p.length > 1) inst.push(new C.GeometryInstance({ geometry: new C.GroundPolylineGeometry({ positions: pos(p), width: 2.5 }), attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(ORANGE) } }));
    }
    const edges = viewer.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({ geometryInstances: inst, appearance: new C.PolylineColorAppearance() }));
    await viewer.dataSources.add(ds);
    return { set show(v) { ds.show = v; edges.show = v; } };
  }, 'las áreas en disputa');
})();
