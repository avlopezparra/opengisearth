"""Turns a MIDI file into a music theme of the game (web/*_theme.js).

A theme is { title, bpm, unit: 24, beats, lead, harmony, bass, drums }: each part a flat list of start, length (both in 1/24 of a beat) and MIDI pitch.
The MIDI channels are dealt into the parts by hand, since only the composer knows which voice carries the tune; channel 10 is always the drums.

Run:  python -I tools/midi2theme.py song.mid web/moon_theme.js OGE_MOON_THEME "Title" --lead 6,1 --harmony 0,4,5 --bass 3 [--mix harmony=0.6]
"""
import json, struct, sys


def vlq(b, i):
    v = 0
    while True:
        c = b[i]; i += 1; v = (v << 7) | (c & 0x7F)
        if c < 0x80: return v, i


def notes_of(path):
    """(ticks per beat, bpm, [(start, length, pitch, channel)]) of a standard MIDI file; the first tempo is the tempo."""
    b = open(path, 'rb').read()
    assert b[:4] == b'MThd', 'not a MIDI file'
    _, ntr, div = struct.unpack('>HHH', b[8:14])
    i, bpm, notes = 14, 120.0, []
    for _ in range(ntr):
        assert b[i:i + 4] == b'MTrk'
        j, end = i + 8, i + 8 + struct.unpack('>I', b[i + 4:i + 8])[0]
        t, run, on, first = 0, 0, {}, bpm == 120.0
        while j < end:
            d, j = vlq(b, j); t += d
            if b[j] == 0xFF:
                typ = b[j + 1]; ln, k = vlq(b, j + 2)
                if typ == 0x51 and first: bpm, first = 60000000 / int.from_bytes(b[k:k + ln], 'big'), False
                j = k + ln
            elif b[j] in (0xF0, 0xF7):
                ln, k = vlq(b, j + 1); j = k + ln
            else:
                if b[j] & 0x80: run = b[j]; j += 1
                hi, ch = run & 0xF0, run & 0x0F
                if hi in (0x80, 0x90):
                    p, vel = b[j], b[j + 1]; j += 2
                    if hi == 0x90 and vel: on[(ch, p)] = t
                    elif (ch, p) in on: s = on.pop((ch, p)); notes.append((s, t - s, p, ch))
                else:
                    j += 1 if hi in (0xC0, 0xD0) else 2
        i = end
    return div, bpm, notes


def main():
    src, out, var, title = sys.argv[1:5]
    args, mix = sys.argv[5:], {}
    if '--mix' in args:  # --mix harmony=0.6: that part plays at 0.6 of its usual volume in this theme
        i = args.index('--mix'); mix = {k: float(v) for k, v in (x.split('=') for x in args[i + 1].split(','))}; del args[i:i + 2]
    opt = {args[k][2:]: [int(x) for x in args[k + 1].split(',') if x] for k in range(0, len(args) - 1, 2)}
    div, bpm, notes = notes_of(src)
    unit = lambda ticks: round(ticks * 24 / div)
    theme = {'title': title, 'bpm': round(bpm), 'unit': 24}
    last = max(s + ln for s, ln, _, _ in notes)
    theme['beats'] = -(-last // (div * 4)) * 4  # whole bars of four beats
    for part, chans in [('lead', opt.get('lead', [])), ('harmony', opt.get('harmony', [])), ('bass', opt.get('bass', [])), ('drums', [9])]:
        rows = sorted((unit(s), max(1, unit(ln)), p) for s, ln, p, ch in notes if ch in chans)
        theme[part] = [x for row in rows for x in row]
    if mix: theme['mix'] = mix
    with open(out, 'w', encoding='utf-8', newline='') as f:
        f.write(f"// {title}: note data converted from the user's own MIDI (tools/midi2theme.py). Per part: start, length (in 1/24 of a beat) and MIDI pitch, flattened.\n")
        f.write(f'window.{var} = ' + json.dumps(theme, ensure_ascii=False, separators=(',', ':')) + ';\n')
    print(out, {k: (len(v) // 3 if isinstance(v, list) else v) for k, v in theme.items()})


if __name__ == '__main__':
    main()
