// OpenGISEarth — idioma de la interfaz. El código está en español; en inglés, los textos se traducen al vuelo
// con el diccionario de i18n_en.js: exactos (OGE_EN.exact) y patrones para los que llevan números o nombres (OGE_EN.patterns).
// T(texto) traduce a mano lo que no pasa por el DOM (lo dibujado en lienzos: HUD del vuelo, hoja de impresión).
(() => {
  const saved = localStorage.getItem('oge.lang'), lang = saved || ((navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en');
  const D = window.OGE_EN || { exact: {}, patterns: [] };
  const tr = (s) => {
    if (lang !== 'en' || typeof s !== 'string') return s;
    const k = s.trim();
    if (!k) return s;
    let v = D.exact[k];
    if (v === undefined) for (const [re, rep] of D.patterns) if (re.test(k)) { v = k.replace(re, rep); break; }
    return v === undefined ? s : s.replace(k, v);
  };
  window.OGE_LANG = lang;
  window.T = tr;
  window.OGE_SETLANG = (l) => { localStorage.setItem('oge.lang', l); location.reload(); };
  if (lang !== 'en') return;
  document.documentElement.lang = 'en';
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const walk = (n) => {
    if (n.nodeType === 3) { const v = tr(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; return; }
    if (n.nodeType !== 1 || /^(SCRIPT|STYLE|CANVAS)$/.test(n.tagName)) return;
    for (const a of ATTRS) if (n.hasAttribute(a)) { const v = tr(n.getAttribute(a)); if (v !== n.getAttribute(a)) n.setAttribute(a, v); }
    n.childNodes.forEach(walk);
  };
  // Todo lo que la app escriba después (árbol, diálogos, avisos) pasa por aquí; un texto ya traducido no está en el diccionario y no se repite.
  new MutationObserver((ms) => ms.forEach((m) => (m.type === 'childList' ? m.addedNodes.forEach(walk) : walk(m.target))))
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  document.addEventListener('DOMContentLoaded', () => walk(document.body));
})();
