"""Extract dense Cozza samples once; reuse source PNGs from the sparse pass."""
import json
import subprocess
from pathlib import Path
import cv2

root = Path("/tmp/ppv4.7E984A/phone-child")
dest = root / "dense"
dest.mkdir(exist_ok=True)
video = str(Path(__file__).resolve().parents[1] / "data/videos/commons/cozza.webm")
probe = subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_packets","-of","json",video],
                       check=True,capture_output=True,text=True)
pts = [float(p["pts_time"]) for p in json.loads(probe.stdout)["packets"]]
indices = list(range(next(i for i,t in enumerate(pts) if t >= 1.5),len(pts),3))
indices = [i for i in indices if pts[i] <= 9.5]
old = json.loads(Path("evidence/r4/phone/cozza.json").read_text())["rows"]
cached = {r["frameIndex"]:root/f"cozza-{i:02}.png" for i,r in enumerate(old)}
missing = [i for i in indices if not (dest/f"source-{i:03}.png").exists() and i not in cached]
if missing:
    select = "+".join(f"eq(n\\,{i})" for i in missing)
    subprocess.run(["nice","-n","10","ffmpeg","-v","error","-threads","1","-i",video,
                    "-vf",f"select={select}","-filter_threads","1","-fps_mode","passthrough",
                    "-start_number","0",str(dest/"new-%03d.png")],check=True)
    for j,i in enumerate(missing):
        (dest/f"new-{j:03}.png").rename(dest/f"source-{i:03}.png")
for i in indices:
    path = dest/f"source-{i:03}.png"
    if not path.exists():
        path.write_bytes(cached[i].read_bytes())
    im = cv2.imread(str(path))
    x0,y0,x1,y1 = 240,90,820,360
    crop = im[y0:y1,x0:x1].copy()
    for x in range(250,x1,50):
        cv2.line(crop,(x-x0,0),(x-x0,y1-y0),(70,70,70),1)
        cv2.putText(crop,str(x),(x-x0+2,13),0,.38,(0,255,255),1)
    for y in range(100,y1,50):
        cv2.line(crop,(0,y-y0),(x1-x0,y-y0),(70,70,70),1)
        cv2.putText(crop,str(y),(2,y-y0+13),0,.38,(0,255,255),1)
    crop = cv2.resize(crop,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST)
    cv2.putText(crop,f"frame {i} PTS {pts[i]:.3f}",(400,30),0,.8,(0,255,255),2)
    cv2.imwrite(str(dest/f"grid-{i:03}.jpg"),crop)
print(json.dumps([{"frameIndex":i,"t":pts[i]} for i in indices]))
