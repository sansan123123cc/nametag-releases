# 이름표 학습: ntd11 v5 를 내 자료로 이어서 학습 → ONNX(1024) → out/
EPOCHS=40      # 학습 횟수 (자료 많으면 60~100)
IMGSZ=1024     # 학습 크기 (VRAM 부족하면 640)
BATCH=4        # 한 번에 몇 장 (VRAM 8GB: 4 · 12GB: 8 · 부족하면 2)
LR=0.002       # 학습률 (이어서 학습이라 작게)
import os, sys, glob, shutil
HERE=os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
sys.path.insert(0,HERE)
import prepare
n=prepare.main()
if n<20: print('자료가 너무 적다 (20장 미만). 편집기에서 더 내보내라.'); sys.exit(1)
base=glob.glob(os.path.join(HERE,'base','*.pt'))
if not base: print('base\\ 폴더에 ntd11_anime_nsfw_segm_v5.pt 를 넣어라 (zip 안에 있음).'); sys.exit(1)
from ultralytics import YOLO
import torch
print('CUDA:',torch.cuda.is_available())
m=YOLO(base[0])
m.train(data=os.path.join(HERE,'dataset','data.yaml'),epochs=EPOCHS,imgsz=IMGSZ,batch=BATCH,lr0=LR,lrf=0.1,warmup_epochs=1,
        freeze=10,                    # 앞쪽 층은 고정 (그림체 적응만) · 자료 많으면 0으로
        device=0 if torch.cuda.is_available() else 'cpu',project=os.path.join(HERE,'runs'),name='finetune',exist_ok=True,
        plots=False,verbose=True,patience=15,close_mosaic=5)
best=os.path.join(HERE,'runs','finetune','weights','best.pt')
p=YOLO(best).export(format='onnx',imgsz=IMGSZ,opset=17,simplify=True,dynamic=False)
os.makedirs(os.path.join(HERE,'out'),exist_ok=True)
dst=os.path.join(HERE,'out','ntd11_seg_v5_%d.onnx'%IMGSZ); shutil.copy(p,dst)
print('완료 →',dst); print('이제 메뉴 [학습 → 3. 모델 넣기]')
