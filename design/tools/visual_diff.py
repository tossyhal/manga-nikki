#!/usr/bin/env python3
"""Compare reference vs implementation (requires Pillow). No strict pass/fail threshold by default.
Usage:
python tools/visual_diff.py reference/browser_content/03.png path/to/actual.png --out visual_diff.png
"""
import argparse
from PIL import Image, ImageChops, ImageEnhance, ImageStat
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('reference');p.add_argument('actual');p.add_argument('--out',default='visual_diff.png');args=p.parse_args()
a=Image.open(args.reference).convert('RGB');b=Image.open(args.actual).convert('RGB')
if a.size!=b.size:raise SystemExit(f'Mismatched dimensions {a.size} vs {b.size}; capture at exactly {a.size}')
d=ImageChops.difference(a,b);st=ImageStat.Stat(d);mae=sum(st.mean)/3
# Difference ratio for 12/255 on any channel to ignore subtle anti-aliasing noise
from PIL import ImageOps
mask=d.convert('L').point(lambda v:255 if v>12 else 0)
ratio=mask.histogram()[255]/(a.width*a.height)
ImageEnhance.Contrast(d).enhance(3.2).save(args.out)
print(f'mean abs RGB diff: {mae:.2f}/255; pixels changed (>12/255 luminance): {ratio:.1%}; output: {args.out}')
print('Font rendering, illustrations, dynamic contents and browser chrome affect these values. Inspect visually; no universal auto-pass threshold.')
