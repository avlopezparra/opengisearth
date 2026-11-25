"""Builds web/data/subflags.json: the emblem of every first-level region (Natural Earth admin-1), from Wikidata.

For each region the first of these that Wikidata has: its flag (P41), its coat of arms (P94), its logo (P154),
or the flag or coat of arms of its capital (P36). Regions are matched by their Wikidata id (Natural Earth carries it),
or else by their ISO 3166-2 code, never by name. The game reads the table instead of asking Wikidata while flying.

Run:  python -I tools/subflags.py [cache dir]      (prints the coverage; the regions left without emblem go to <cache>/subflags_missing.txt)
"""
import json, os, struct, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'tools', '.cache')
DBF = 'https://raw.githubusercontent.com/avlopezparra/natural-earth-vector/master/10m_cultural/ne_10m_admin_1_states_provinces.dbf'
UA = {'User-Agent': 'OpenGISEarth-subflags/1.0 (https://opengisearth.com)'}
KINDS = ['fl', 'ca', 'lg', 'cfl', 'cca']  # in order of preference
EMBLEMS = 'OPTIONAL { ?c wdt:P576 ?end } OPTIONAL { ?c wdt:P41 ?fl } OPTIONAL { ?c wdt:P94 ?ca } OPTIONAL { ?c wdt:P154 ?lg } OPTIONAL { ?c wdt:P36 ?cap. OPTIONAL { ?cap wdt:P41 ?cfl } OPTIONAL { ?cap wdt:P94 ?cca } }'


def regions():
    """[{code, iso, q, name, a2}] from the Natural Earth table (downloaded once)."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, 'admin1.dbf')
    if not os.path.exists(path):
        with urllib.request.urlopen(urllib.request.Request(DBF, headers=UA), timeout=300) as r, open(path, 'wb') as f:
            f.write(r.read())
    b = open(path, 'rb').read()
    n, head, size = struct.unpack('<IHH', b[4:12])
    fields, off, i = [], 1, 32
    while b[i] != 0x0D:
        name, length = b[i:i + 11].split(b'\0')[0].decode().lower(), b[i + 16]
        fields.append((name, off, length)); off += length; i += 32
    out = []
    for k in range(n):
        rec = b[head + k * size: head + (k + 1) * size]
        v = {name: rec[o:o + l].decode('utf-8', 'replace').replace('\0', '').strip() for name, o, l in fields if name in ('adm1_code', 'iso_3166_2', 'wikidataid', 'name', 'iso_a2')}
        if v.get('adm1_code'):
            out.append({'code': v['adm1_code'], 'iso': v.get('iso_3166_2', ''), 'q': v.get('wikidataid', ''), 'name': v.get('name', ''), 'a2': v.get('iso_a2', '')})
    return out


def sparql(query):
    for attempt in range(4):
        try:
            req = urllib.request.Request('https://query.wikidata.org/sparql', data=urllib.parse.urlencode({'query': query, 'format': 'json'}).encode(), headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)['results']['bindings']
        except Exception as e:  # busy or throttled: wait and try again
            print('  retry', attempt + 1, str(e)[:80]); time.sleep(10 * (attempt + 1))
    raise SystemExit('Wikidata did not answer')


def best(rows):
    """{qid: (rank, file)} and {iso: (rank, file)}: the preferred emblem; a dissolved entity ranks after a living one."""
    by_q, by_iso = {}, {}
    for b in rows:
        q = b['c']['value'].rsplit('/', 1)[-1]
        for rank, kind in enumerate(KINDS):
            if kind in b:
                file = urllib.parse.unquote(b[kind]['value'].rsplit('/', 1)[-1])
                got = (rank + (10 if 'end' in b else 0), file)
                if q not in by_q or got < by_q[q]: by_q[q] = got
                iso = b.get('iso', {}).get('value')
                if iso and (iso not in by_iso or got < by_iso[iso]): by_iso[iso] = got
                break
    return by_q, by_iso


def main():
    regs = regions()
    print(len(regs), 'regions')
    by_q, by_iso = best(sparql('SELECT ?c ?iso ?end ?fl ?ca ?lg ?cfl ?cca WHERE { ?c wdt:P300 ?iso. ' + EMBLEMS + ' }'))
    print(len(by_q), 'Wikidata subdivisions with an emblem (by ISO 3166-2)')
    rest = sorted({r['q'] for r in regs if r['q'].startswith('Q') and r['q'] not in by_q})
    for i in range(0, len(rest), 250):  # regions whose item has no ISO code in Wikidata: asked by id
        more, _ = best(sparql('SELECT ?c ?end ?fl ?ca ?lg ?cfl ?cca WHERE { VALUES ?c { ' + ' '.join('wd:' + q for q in rest[i:i + 250]) + ' } ' + EMBLEMS + ' }'))
        by_q.update(more); time.sleep(2)
    table, kinds, missing = {}, [0] * len(KINDS), []
    for r in regs:
        got = by_q.get(r['q']) or by_iso.get(r['iso'])
        if got: table[r['code']] = got[1]; kinds[got[0] % 10] += 1
        else: missing.append(r)
    out = os.path.join(ROOT, 'web', 'data', 'subflags.json')
    json.dump(dict(sorted(table.items())), open(out, 'w', encoding='utf-8', newline=''), ensure_ascii=False, separators=(',', ':'))
    print(f'{len(table)}/{len(regs)} with an emblem:', dict(zip(['flag', 'arms', 'logo', 'capital flag', 'capital arms'], kinds)), '->', out, os.path.getsize(out), 'bytes')
    per = {}
    for r in missing: per.setdefault(r['a2'], []).append(r['name'])
    with open(os.path.join(CACHE, 'subflags_missing.txt'), 'w', encoding='utf-8') as f:
        for a2, names in sorted(per.items(), key=lambda x: -len(x[1])): f.write(f'{a2} ({len(names)}): ' + ', '.join(sorted(names)) + '\n')
    print(len(missing), 'without emblem in', len(per), 'countries; most:', ', '.join(f'{a2} {len(v)}' for a2, v in sorted(per.items(), key=lambda x: -len(x[1]))[:25]))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
