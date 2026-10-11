#!/usr/bin/env python3
"""One-off: prepare the Earth textures in public/textures/ from the day and night maps (see ASSETS.md).

Usage: python3 tools/make-earth-textures.py <earth-day.jpg> <earth-night.jpg>
Inputs are the 4096x2048 Solar System Scope maps (CC BY 4.0) as shipped by three.js and akulbajpai-code/SkyLine.
Writes: earth-day-4096.jpg and earth-night-4096.jpg (byte copies), earth-day-2048.jpg and earth-night-2048.jpg
(Lanczos resize for small screens, JPEG quality 86) and ocean-mask-2048.png (sun-glint mask: white = water, picked out
by colour from the day map, then lightly blurred). Needs Pillow.
"""
import shutil, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter

out = Path(__file__).resolve().parent.parent / 'public' / 'textures'
day_src, night_src = map(Path, sys.argv[1:3])
for src, name in ((day_src, 'day'), (night_src, 'night')):
    im = Image.open(src).convert('RGB')
    assert im.size == (4096, 2048), f'{src}: expected 4096x2048, got {im.size}'
    shutil.copyfile(src, out / f'earth-{name}-4096.jpg')
    im.resize((2048, 1024), Image.LANCZOS).save(out / f'earth-{name}-2048.jpg', quality=86, optimize=True, progressive=True)

# water: blue clearly above both red and green. Land, ice and desert fail this test.
r, g, b = Image.open(day_src).convert('RGB').resize((2048, 1024), Image.LANCZOS).split()
rg = ImageChops.lighter(r, g)
blue_excess = ImageChops.subtract(b, rg)                   # max(0, b - max(r, g))
mask = blue_excess.point(lambda v: 0 if v < 8 else 255 if v > 28 else int((v - 8) * 255 / 20))
mask.filter(ImageFilter.GaussianBlur(1.2)).save(out / 'ocean-mask-2048.png', optimize=True)
print('wrote', *sorted(p.name for p in out.glob('earth-*-*.jpg')), 'ocean-mask-2048.png')
