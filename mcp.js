// OpenGISEarth — MCP server: lets an AI assistant (Claude Code, Gemini CLI, Codex CLI, OpenCode…) work this atlas through the Model Context Protocol.
// The desktop program listens on this computer only and hands every JSON-RPC message to this page (OGE.mcp.handle); the page answers.
// Nothing here runs code sent by the assistant: it can only call the tools listed below.
(() => {
  const C = Cesium, { viewer } = OGE, geo = OGE.geo, $ = (id) => document.getElementById(id), deg = C.Math.toDegrees;
  const tauri = window.__TAURI__ && window.__TAURI__.core, PORT = 47778, VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
  const group = (name) => geo.groups().find((d) => d.name === name);
  const need = (v, what) => { if (v == null || v === '') throw new Error('Missing argument: ' + what); return v; };
  const num = (v, what, lo, hi) => { const n = +v; if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} must be a number between ${lo} and ${hi}`); return n; };
  const layerBoxes = () => [...document.querySelectorAll('.layers input[type=checkbox][id]')];

  // Each tool: its name, what it is for (the assistant reads this), the JSON Schema of its arguments and what it does. It returns text, an object (sent as JSON) or { image }.
  const TOOLS = [
    { name: 'get_view', description: 'Where the map is looking now: the world shown (earth, moon, mars), the camera position, the visible bounding box and the layers that are on.',
      inputSchema: { type: 'object', properties: {} },
      run: () => { const c = viewer.camera.positionCartographic, at = OGE.lookAt();
        return { world: OGE.body || 'earth', camera: { lon: +deg(c.longitude).toFixed(5), lat: +deg(c.latitude).toFixed(5), height_m: Math.round(c.height), heading_deg: Math.round(deg(viewer.camera.heading)), pitch_deg: Math.round(deg(viewer.camera.pitch)) },
          looking_at: at ? { lon: +deg(at.carto.longitude).toFixed(5), lat: +deg(at.carto.latitude).toFixed(5) } : null, bbox_west_south_east_north: OGE.viewBbox(), layers_on: layerBoxes().filter((b) => b.checked).map((b) => b.id) }; } },
    { name: 'fly_to', description: 'Moves the camera over a place. height_m is the height of the eye above the ground (default 20000; a city fits at about 30000, a country at 1500000).',
      inputSchema: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' }, height_m: { type: 'number' } }, required: ['lon', 'lat'] },
      run: (a) => new Promise((done) => { const lon = num(a.lon, 'lon', -180, 180), lat = num(a.lat, 'lat', -90, 90), h = a.height_m == null ? 20000 : num(a.height_m, 'height_m', 50, 4e7);
        viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(lon, lat, h), duration: 1.5, complete: () => done(`The view is over ${lon}, ${lat} at ${h} m.`), cancel: () => done('The flight was interrupted.') }); }) },
    { name: 'search_place', description: 'Finds places by name or address (OpenStreetMap Nominatim) and returns their coordinates. It does not move the map: use fly_to with a result.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] },
      run: async (a) => { const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=' + Math.min(10, Math.max(1, a.limit | 0 || 5)) + '&accept-language=' + OGE_LANG + '&q=' + encodeURIComponent(String(need(a.query, 'query')).slice(0, 200)));
        if (!r.ok) throw new Error('The place search answered ' + r.status);
        return (await r.json()).map((p) => ({ name: p.display_name, lon: +p.lon, lat: +p.lat, kind: p.type })); } },
    { name: 'list_layers', description: 'The layers of the atlas that can be switched on and off (borders, names, clouds, relief, live satellites…), each with its id and whether it is on.',
      inputSchema: { type: 'object', properties: {} },
      run: () => layerBoxes().map((b) => ({ id: b.id, label: (b.closest('label') || b.parentElement).textContent.trim().slice(0, 90), on: b.checked })) },
    { name: 'set_layer', description: 'Switches one layer of the atlas on or off. Take the id from list_layers.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, on: { type: 'boolean' } }, required: ['id', 'on'] },
      run: (a) => { const b = layerBoxes().find((x) => x.id === a.id); if (!b) throw new Error('No layer with that id: see list_layers'); OGE.setCheck(b, !!a.on); return `${a.id} is now ${b.checked ? 'on' : 'off'}.`; } },
    { name: 'list_groups', description: 'The groups of drawn or imported objects on the map (the user\'s own places), with how many objects each holds.',
      inputSchema: { type: 'object', properties: {} },
      run: () => geo.groups().map((d) => ({ name: d.name, objects: d.entities.values.length, shown: d.show })) },
    { name: 'get_features', description: 'The objects of one group as GeoJSON (points, lines and polygons with their names and attributes). At most `limit` objects (default 200).',
      inputSchema: { type: 'object', properties: { group: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['group'] },
      run: (a) => { const ds = group(a.group); if (!ds) throw new Error('No group with that name: see list_groups');
        const fc = geo.exportFC(ds), n = fc.features.length, lim = Math.min(2000, Math.max(1, a.limit | 0 || 200)); fc.features = fc.features.slice(0, lim);
        return { total: n, returned: fc.features.length, geojson: fc }; } },
    { name: 'add_features', description: 'Draws GeoJSON on the map: a FeatureCollection, a Feature or a bare geometry, in longitude/latitude (WGS84). Points become placemarks; a "name" property labels each object. They go into the named group, created if it does not exist.',
      inputSchema: { type: 'object', properties: { geojson: { type: 'object', description: 'GeoJSON FeatureCollection, Feature or geometry' }, group: { type: 'string', description: 'Group to put them in (default "IA")' }, fly: { type: 'boolean', description: 'Move the view to them (default true)' } }, required: ['geojson'] },
      run: (a) => { let g = need(a.geojson, 'geojson'); if (typeof g === 'string') g = JSON.parse(g);
        const feats = (g.type === 'FeatureCollection' ? g.features : g.type === 'Feature' ? [g] : [{ type: 'Feature', properties: {}, geometry: g }]).filter((f) => f && f.geometry);
        if (!feats.length) throw new Error('The GeoJSON has no geometry'); if (feats.length > 5000) throw new Error('Too many objects at once (5000 at most)');
        const name = String(a.group || 'IA').slice(0, 60), ds = group(name), n0 = ds ? ds.entities.values.length : 0, to = ds || Object.assign(geo.addGroup(name, feats), { mcp: true });
        if (ds) geo.add(feats, ds);
        if (a.fly !== false) viewer.flyTo(to, { duration: 1.5 }).catch(() => {});
        return `${to.entities.values.length - n0} objects added to the group "${to.name}".`; } },
    { name: 'list_tools', description: 'The geoprocessing tools of the atlas (buffer, intersection, dissolve, centroids, statistics…). Without arguments: every tool with its id and group. With `id`: that tool\'s help and its parameters, to call run_tool.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, search: { type: 'string', description: 'Only the tools whose name has this text' } } },
      run: (a) => { const all = OGE.tools.list;
        if (a.id) { const t = all.find((x) => x.id === a.id); if (!t) throw new Error('No tool with that id');
          return { id: t.id, name: t.n, group: t.g, help: t.h || '', input: t.noIn ? 'none' : t.in ? t.in.join(' or ') : 'any objects', qgis: t.q, arcgis: t.a, params: (t.p || []).map((d) => ({ id: d.id, label: d.label, type: d.type === 'layer' ? 'group name' : d.type || 'text', default: d.value, options: d.options })) }; }
        const q = String(a.search || '').toLowerCase(); return all.filter((t) => !q || t.n.toLowerCase().includes(q)).map((t) => ({ id: t.id, name: t.n, group: t.g })); } },
    { name: 'run_tool', description: 'Runs one geoprocessing tool on a group of objects. `input` is the group to work on (not needed by tools without input); `params` are the tool\'s own parameters by id (see list_tools with its id), a parameter of type "group name" takes the name of another group. The result is a new group on the map.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' }, params: { type: 'object' } }, required: ['id'] },
      run: async (a) => { const t = OGE.tools.list.find((x) => x.id === a.id); if (!t) throw new Error('No tool with that id: see list_tools');
        if (!t.noIn && !group(a.input)) throw new Error('`input` must be the name of a group: see list_groups');
        const values = { _in: a.input }; for (const d of t.p || []) values[d.id] = d.type === 'select' ? (d.value ?? (Array.isArray(d.options[0]) ? d.options[0][0] : d.options[0])) : d.value;
        Object.assign(values, a.params || {});
        for (const d of t.p || []) if (d.type === 'layer' && !group(values[d.id])) throw new Error(`The parameter "${d.id}" must be the name of a group`);
        const before = new Set(geo.groups().map((d) => d.name)), said = [], toast = OGE.toast; OGE.toast = (m, err) => { said.push((err ? 'ERROR: ' : '') + m); toast(m, err); }; // what the tool tells the user is what it answers
        try { await OGE.tools.exec(t, values); } finally { OGE.toast = toast; }
        return { messages: said.slice(1), new_groups: geo.groups().filter((d) => !before.has(d.name)).map((d) => ({ name: (d.mcp = true) && d.name, objects: d.entities.values.length })) }; } },
    { name: 'remove_group', description: 'Removes a whole group of objects from the map. A group made through this server since the app was opened goes at once; for any other the user is asked in the app, and may refuse.',
      inputSchema: { type: 'object', properties: { group: { type: 'string' } }, required: ['group'] },
      run: async (a) => { const ds = group(a.group); if (!ds) throw new Error('No group with that name: see list_groups');
        if (!ds.mcp && !(await OGE.confirm(`${T('El asistente de IA quiere borrar el grupo')} «${ds.name}» (${ds.entities.values.length} ${T('objetos')}).`))) return 'The user did not allow it: the group is still there.'; // what the user drew is the user's to give up
        viewer.dataSources.remove(ds, true); return `The group "${a.group}" was removed.`; } },
    { name: 'screenshot', description: 'A picture of the map as it is on screen now (JPEG). Use it to check what the user sees.',
      inputSchema: { type: 'object', properties: { width: { type: 'integer', minimum: 200, maximum: 1600, description: 'Width in pixels (default 1024)' } } },
      run: (a) => { viewer.render(); const src = viewer.canvas, w = Math.min(1600, Math.max(200, a.width | 0 || 1024)), cv = Object.assign(document.createElement('canvas'), { width: w, height: Math.round((w * src.height) / src.width) });
        cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height); return { image: cv.toDataURL('image/jpeg', 0.82).split(',')[1], mimeType: 'image/jpeg' }; } },
  ];

  async function rpc(m) { // one JSON-RPC message in, its answer out (null for a notification, which has none)
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: (m && m.id) ?? null, error: { code: -32600, message: 'Invalid Request' } };
    if (m.id === undefined) return null;
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result }), p = m.params || {};
    if (m.method === 'initialize') return ok({ protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'opengisearth', title: 'OpenGISEarth', version: '1.0.0' },
      instructions: 'OpenGISEarth is a 3D atlas and GIS. Coordinates are longitude and latitude in degrees (WGS84). Call get_view first to see where the user is looking; draw results with add_features so the user sees them on the map.' });
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (m.method === 'tools/call') { const t = TOOLS.find((x) => x.name === p.name);
      if (!t) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool: ' + p.name } };
      try { const r = await t.run(p.arguments || {}); return ok({ content: [r && r.image ? { type: 'image', data: r.image, mimeType: r.mimeType } : { type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] }); }
      catch (e) { return ok({ content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true }); } } // a tool that fails says why: the assistant can correct itself
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } };
  }
  async function handle(id, hex) { // called by the desktop program with the body of an HTTP request (as hexadecimal: any text travels safely)
    let out = '';
    try { const msg = JSON.parse(new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16))));
      const res = Array.isArray(msg) ? (await Promise.all(msg.map(rpc))).filter(Boolean) : await rpc(msg);
      out = res && (!Array.isArray(res) || res.length) ? JSON.stringify(res) : ''; }
    catch { out = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    tauri.invoke('mcp_reply', { id, body: out });
  }

  // ---------- Switching it on: the token is made here once and kept, so the assistant's configuration stays valid ----------
  const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const token = () => { let t = localStorage.getItem('oge.mcpToken'); if (!/^[0-9a-f]{32}$/.test(t || '')) { t = newToken(); localStorage.setItem('oge.mcpToken', t); } return t; };
  let url = null; // the address it is listening on, while it is on
  const start = async () => { url = await tauri.invoke('mcp_start', { port: PORT, token: token() }); return url; };
  const stop = async () => { await tauri.invoke('mcp_stop'); url = null; };
  const paint = () => { $('mcpBtn').classList.toggle('active', !!url); };
  $('mcpBtn').onclick = async () => {
    if (!tauri) return OGE.toast(T('El servidor MCP funciona en la app de escritorio: descárgala con «App de escritorio».'), true);
    const box = document.createElement('div'), area = Object.assign(document.createElement('textarea'), { readOnly: true, rows: 9, style: 'width:100%;box-sizing:border-box;font:12px ui-monospace,monospace;margin-top:8px' });
    const write = () => { const u = url || `http://127.0.0.1:${PORT}/mcp`, t = token();
      area.value = `Claude Code:\nclaude mcp add --transport http opengisearth ${u} --header "Authorization: Bearer ${t}"\n\n` + JSON.stringify({ mcpServers: { opengisearth: { type: 'http', url: u, headers: { Authorization: 'Bearer ' + t } } } }, null, 2); };
    write(); box.append(area, Object.assign(document.createElement('button'), { type: 'button', textContent: T('Copiar'), style: 'margin-top:6px', onclick: () => { area.select(); navigator.clipboard.writeText(area.value).then(() => OGE.toast(T('Configuración copiada.'))); } }));
    const v = await OGE.ask({ title: 'Servidor MCP: conecta tu asistente de IA', ok: 'Aplicar',
      help: 'Con el servidor encendido, Claude Code, Gemini CLI, Codex CLI, OpenCode u otro asistente pueden mover el mapa, encender capas, dibujar GeoJSON y usar las herramientas SIG de este atlas. Solo escucha en este computador y pide el token.',
      fields: [{ id: 'on', label: 'Servidor MCP encendido', type: 'checkbox', value: !!url }, { id: 'auto', label: 'Encenderlo al abrir la app', type: 'checkbox', value: localStorage.getItem('oge.mcpAuto') === '1' },
        { id: 'fresh', label: 'Generar un token nuevo (el anterior deja de servir)', type: 'checkbox', value: false }], extra: box });
    if (!v) return;
    localStorage.setItem('oge.mcpAuto', v.auto ? '1' : '0');
    if (v.fresh) localStorage.setItem('oge.mcpToken', newToken());
    try { if (v.on) { await start(); OGE.toast(`${T('Servidor MCP encendido en')} ${url}`); } else if (url) { await stop(); OGE.toast(T('Servidor MCP apagado.')); } } catch (e) { OGE.toast(T('No se pudo encender el servidor MCP: ') + e, true); }
    paint();
  };
  OGE.mcp = { handle, tools: TOOLS, rpc };
  if (tauri) tauri.invoke('mcp_status').then((u) => { url = u || null; if (!url && localStorage.getItem('oge.mcpAuto') === '1') return start(); }).then(paint).catch(() => {}); // already on (started from the command line), or to be switched on by itself
})();
