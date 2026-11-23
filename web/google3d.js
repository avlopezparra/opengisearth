// Google's photorealistic 3D cities (Map Tiles API), the official route: requires the user's own
// Google Maps Platform key (free quota, then paid). The key is stored only on this computer.
(() => {
  const { viewer, $ } = OGE;
  const KEY = 'oge.googleKey', cb = $('layerGoogle3d');
  let tileset = null;

  async function askKey() {
    const v = await OGE.ask({ title: 'Clave de Google Maps Platform', help: 'Debe tener activada la «Map Tiles API». Se guarda solo en este equipo; déjala vacía para borrarla.',
      fields: [{ id: 'k', label: 'Clave de API', value: localStorage.getItem(KEY) || '' }] });
    if (!v) return null;
    const k = v.k.trim();
    if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY);
    if (tileset) { viewer.scene.primitives.remove(tileset); tileset = null; } // use the new key
    return k || null;
  }
  async function show(on) {
    if (!on) { if (tileset) tileset.show = false; return; }
    const key = localStorage.getItem(KEY) || await askKey();
    if (!key) return OGE.setCheck(cb, false);
    if (!tileset) {
      try {
        Cesium.GoogleMaps.defaultApiKey = key;
        tileset = await Cesium.createGooglePhotorealistic3DTileset();
        viewer.scene.primitives.add(tileset);
      } catch (e) {
        OGE.setCheck(cb, false);
        return OGE.toast('Google rechazó la clave o la Map Tiles API no está activada (' + (e.message || 'HTTP ' + (e.statusCode ?? '?')) + ').', true);
      }
    }
    tileset.show = cb.checked;
  }
  cb.addEventListener('change', () => show(cb.checked));
  $('googleKeyBtn').onclick = async () => { await askKey(); if (cb.checked) show(true); };
  if (cb.checked) show(true);
})();
