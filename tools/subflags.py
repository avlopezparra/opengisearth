"""Builds web/data/subflags.json: the emblem of every first-level region (Natural Earth admin-1), from Wikidata.

For each region the first of these that Wikidata has: its flag (P41), its coat of arms (P94), its logo (P154),
the flag or coat of arms of its capital (P36), or those of the most populous place inside it (P131). Regions are matched by their Wikidata id (Natural Earth carries it),
or else by their ISO 3166-2 code, never by name. The game reads the table instead of asking Wikidata while flying.

In the countries of GROUPED the flag belongs to the larger region (Spain: autonomous communities, France and Italy: regions,
Slovenia: statistical regions): web/data/subregions.json says which region each unit is part of.

Run:  python -I tools/subflags.py [cache dir] [--groups-only]      (prints the coverage; the regions left without emblem go to <cache>/subflags_missing.txt)
"""
import json, os, struct, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else os.path.join(ROOT, 'tools', '.cache')
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
        v = {name: rec[o:o + l].decode('utf-8', 'replace').replace('\0', '').strip() for name, o, l in fields if name in ('adm1_code', 'iso_3166_2', 'wikidataid', 'name', 'iso_a2', 'region')}
        if v.get('adm1_code'):
            out.append({'code': v['adm1_code'], 'iso': v.get('iso_3166_2', ''), 'q': v.get('wikidataid', ''), 'name': v.get('name', ''), 'a2': v.get('iso_a2', ''), 'region': v.get('region', '')})
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


def towns(qids):
    """{qid: (5 flag | 6 arms, file)}: the most populous place located in each region (P131) that has a flag or a coat of arms; usually its capital."""
    out, pop = {}, {}
    for i in range(0, len(qids), 60):
        try:
            rows = sparql('SELECT ?c ?fl ?ca ?pop WHERE { VALUES ?c { ' + ' '.join('wd:' + q for q in qids[i:i + 60]) + ' } ?t wdt:P131 ?c. OPTIONAL { ?t wdt:P41 ?fl } OPTIONAL { ?t wdt:P94 ?ca } FILTER(BOUND(?fl) || BOUND(?ca)) OPTIONAL { ?t wdt:P1082 ?pop } }')
        except SystemExit:
            print('  towns: batch', i, 'skipped'); continue
        for b in rows:
            q, p = b['c']['value'].rsplit('/', 1)[-1], float(b.get('pop', {}).get('value', 0) or 0)
            if q not in out or p > pop[q]:
                kind = 'fl' if 'fl' in b else 'ca'
                out[q], pop[q] = (5 if kind == 'fl' else 6, urllib.parse.unquote(b[kind]['value'].rsplit('/', 1)[-1])), p
        time.sleep(3)
    return out


GROUPED = {'ES', 'FR', 'IT', 'SI'}  # countries whose Natural Earth units are below the largest subdivision: provinces, departments, municipalities


def groups(regs, table):
    """Adds to the table the emblem of each larger region ('ESP:Andalucía') and returns {adm1_code: region name} for the units inside one.

    The region's Wikidata item is the parent (P131, or P8138 for statistical regions) that most of its units share."""
    member, by_group = {}, {}
    for r in regs:
        if r['a2'] in GROUPED and r['region']:
            member[r['code']] = r['region']; by_group.setdefault(r['code'].split('-')[0] + ':' + r['region'], []).append(r)
    qids = sorted({r['q'] for rs in by_group.values() for r in rs if r['q'].startswith('Q')})
    parents, emblem = {}, {}
    for i in range(0, len(qids), 150):
        for b in sparql('SELECT ?c ?p ?fl ?ca ?lg WHERE { VALUES ?c { ' + ' '.join('wd:' + q for q in qids[i:i + 150]) + ' } { ?c wdt:P131 ?p } UNION { ?c wdt:P8138 ?p } OPTIONAL { ?p wdt:P41 ?fl } OPTIONAL { ?p wdt:P94 ?ca } OPTIONAL { ?p wdt:P154 ?lg } }'):
            p = b['p']['value'].rsplit('/', 1)[-1]
            parents.setdefault(b['c']['value'].rsplit('/', 1)[-1], set()).add(p)
            for kind in ('fl', 'ca', 'lg'):
                if kind in b and p not in emblem: emblem[p] = urllib.parse.unquote(b[kind]['value'].rsplit('/', 1)[-1]); break
        time.sleep(3)
    spread = {}  # a parent shared by several groups is the country or a wider grouping, not the region
    for g, rs in by_group.items():
        for p in {p for r in rs for p in parents.get(r['q'], ())}: spread[p] = spread.get(p, 0) + 1
    found = 0
    for g, rs in by_group.items():
        votes = {}
        for r in rs:
            for p in parents.get(r['q'], ()):
                if spread[p] == 1 and p in emblem: votes[p] = votes.get(p, 0) + 1
        if votes: table[g] = emblem[max(votes, key=votes.get)]; found += 1
        elif len(rs) == 1 and rs[0]['code'] in table: table[g] = table[rs[0]['code']]; found += 1  # a region of a single unit: that unit's own emblem
    print(f'{found}/{len(by_group)} larger regions with an emblem; without:', ', '.join(sorted(g for g in by_group if g not in table))[:400])
    return member


def save(out, table, member):
    json.dump(dict(sorted(table.items())), open(out, 'w', encoding='utf-8', newline=''), ensure_ascii=False, separators=(',', ':'))
    json.dump(dict(sorted(member.items())), open(os.path.join(os.path.dirname(out), 'subregions.json'), 'w', encoding='utf-8', newline=''), ensure_ascii=False, separators=(',', ':'))


def main():
    regs = regions()
    print(len(regs), 'regions')
    out = os.path.join(ROOT, 'web', 'data', 'subflags.json')
    if '--groups-only' in sys.argv:  # the table as it is, plus the larger regions
        table = json.load(open(out, encoding='utf-8'))
        return save(out, table, groups(regs, table))
    by_q, by_iso = best(sparql('SELECT ?c ?iso ?end ?fl ?ca ?lg ?cfl ?cca WHERE { ?c wdt:P300 ?iso. ' + EMBLEMS + ' }'))
    print(len(by_q), 'Wikidata subdivisions with an emblem (by ISO 3166-2)')
    rest = sorted({r['q'] for r in regs if r['q'].startswith('Q') and r['q'] not in by_q})
    for i in range(0, len(rest), 250):  # regions whose item has no ISO code in Wikidata: asked by id
        more, _ = best(sparql('SELECT ?c ?end ?fl ?ca ?lg ?cfl ?cca WHERE { VALUES ?c { ' + ' '.join('wd:' + q for q in rest[i:i + 250]) + ' } ' + EMBLEMS + ' }'))
        by_q.update(more); time.sleep(2)
    table, kinds, missing = {}, [0] * (len(KINDS) + 2), []
    for r in regs:
        got = by_q.get(r['q']) or by_iso.get(r['iso'])
        if got: table[r['code']] = got[1]; kinds[got[0] % 10] += 1
        else: missing.append(r)
    town = towns(sorted({r['q'] for r in missing if r['q'].startswith('Q')}))  # last resort: the emblem of the biggest town inside the region
    for r in missing[:]:
        if r['q'] in town: table[r['code']] = town[r['q']][1]; kinds[town[r['q']][0]] += 1; missing.remove(r)
    save(out, table, groups(regs, table))
    print(f'{len(table)}/{len(regs)} with an emblem:', dict(zip(['flag', 'arms', 'logo', 'capital flag', 'capital arms', 'town flag', 'town arms'], kinds)), '->', out, os.path.getsize(out), 'bytes')
    per = {}
    for r in missing: per.setdefault(r['a2'], []).append(r['name'])
    with open(os.path.join(CACHE, 'subflags_missing.txt'), 'w', encoding='utf-8') as f:
        for a2, names in sorted(per.items(), key=lambda x: -len(x[1])): f.write(f'{a2} ({len(names)}): ' + ', '.join(sorted(names)) + '\n')
    print(len(missing), 'without emblem in', len(per), 'countries; most:', ', '.join(f'{a2} {len(v)}' for a2, v in sorted(per.items(), key=lambda x: -len(x[1]))[:25]))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
