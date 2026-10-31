"""Local-only frame extraction, coordinate grids, and small evaluation overlays."""
import argparse
import json
import subprocess
import struct
import zlib
from pathlib import Path
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("mode", choices=["extract", "overlay"])
ap.add_argument("--video", required=True)
ap.add_argument("--clip", required=True)
ap.add_argument("--tmp", default="/tmp/ppv4.7E984A/phone-child")
ap.add_argument("--report")
args = ap.parse_args()

def small_png(path, bgr):
    # Indexed RGB332 PNG keeps evidence small without another video decode.
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    index = ((rgb[:,:,0] >> 5) << 5) | ((rgb[:,:,1] >> 5) << 2) | (rgb[:,:,2] >> 6)
    palette = bytes(c for i in range(256) for c in
                    (round((i >> 5)*255/7),round(((i >> 2)&7)*255/7),round((i&3)*255/3)))
    def chunk(kind, data):
        return struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data))
    h,w = index.shape
    raw = b"".join(b"\0"+row.tobytes() for row in index)
    path.write_bytes(b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",w,h,8,3,0,0,0))+
                     chunk(b"PLTE",palette)+chunk(b"IDAT",zlib.compress(raw,9))+chunk(b"IEND",b""))
root = Path(args.tmp)
root.mkdir(parents=True, exist_ok=True)
cap = cv2.VideoCapture(args.video)
if args.mode == "extract":
    times = np.linspace(.5, 10.5 if args.clip == "cozza" else 21, 16)
    samples = []
    for i, t in enumerate(times):
        path = root / f"{args.clip}-{i:02}.png"
        if not path.exists():
            subprocess.run(["nice","-n","10","ffmpeg","-v","error","-threads","1","-ss",str(t),"-i",args.video,"-frames:v","1","-y",str(path)],check=True)
        im = cv2.imread(str(path))
        if im is None:
            raise RuntimeError(f"Cannot read {t}")
        x0, y0, x1, y1 = (0, 110, 1068, 560) if args.clip == "cozza" else (0, 500, 1080, 1550)
        crop = im[y0:y1, x0:x1].copy()
        for x in range(x0, x1, 50):
            cv2.line(crop, (x-x0, 0), (x-x0, y1-y0), (90, 90, 90), 1)
            cv2.putText(crop, str(x), (x-x0+2, 16), 0, .4, (0,255,255), 1)
        for y in range(y0, y1, 50):
            cv2.line(crop, (0, y-y0), (x1-x0, y-y0), (90,90,90), 1)
            cv2.putText(crop, str(y), (2,y-y0+15), 0,.45,(0,255,255),1)
        crop = cv2.resize(crop, None, fx=2, fy=2)
        cv2.putText(crop, f"{args.clip} {i:02} t={t:.6f}", (300,30),0,.8,(0,255,255),2)
        cv2.imwrite(str(root / f"{args.clip}-{i:02}-grid.jpg"),crop)
        samples.append({"i": i, "t": round(float(t),6)})
    print(json.dumps(samples))
else:
    report = json.loads(Path(args.report).read_text())
    for i in [0, 5, 10, 15]:
        row = report["rows"][i]
        im = cv2.imread(str(root / f"{args.clip}-{i:02}.png"))
        quad = np.array([[p["x"],p["y"]] for p in report["corners"]],np.int32)
        cv2.polylines(im,[quad],True,(255,210,0),3)
        for a,b in zip(row["trail"],row["trail"][1:]):
            cv2.line(im,(round(a["x"]),round(a["y"])),(round(b["x"]),round(b["y"])),(0,0,255),2)
        gt = row["gt"]
        if gt["ballVisible"]:
            cv2.circle(im,(gt["x"],gt["y"]),13,(0,255,0),3)
        if row["app"]:
            p = row["app"]
            cv2.drawMarker(im,(round(p["x"]),round(p["y"])),(0,0,255),cv2.MARKER_CROSS,24,3)
        scale = min(1,960/max(im.shape[:2]))
        im = cv2.resize(im,None,fx=scale,fy=scale)
        cv2.rectangle(im,(0,0),(im.shape[1],65),(0,0,0),-1)
        cv2.putText(im,f'{args.clip} t={row["t"]:.3f} {row["trackingState"]}',(10,24),0,.55,(255,255,255),1)
        cv2.putText(im,"GT green circle / app red cross",(10,49),0,.5,(255,255,255),1)
        out = Path(args.report).parent / f'{args.clip}-{row["t"]:.3f}.png'
        small_png(out,im)
        while out.stat().st_size > 150000:
            im = cv2.resize(im,None,fx=.85,fy=.85)
            small_png(out,im)
        print(out)
