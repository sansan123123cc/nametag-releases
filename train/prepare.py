# masks/<stem>/<k>_<cls>_<label>.png  →  YOLO seg 라벨 (labels/<stem>.txt, 다각형)  + images 복사/분할
import os, glob, random, shutil, cv2, numpy as np
HERE=os.path.dirname(os.path.abspath(__file__))
IMG=os.path.join(HERE,'images'); MSK=os.path.join(HERE,'masks'); DS=os.path.join(HERE,'dataset')
def polys(mask):
    cs,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE); out=[]
    for c in cs:
        if cv2.contourArea(c)<40: continue
        c=cv2.approxPolyDP(c,1.0,True)
        if len(c)<3: continue
        out.append(c.reshape(-1,2))
    return out
def main():
    random.seed(1)
    for d in ('images/train','images/val','labels/train','labels/val'): os.makedirs(os.path.join(DS,d),exist_ok=True)
    stems=[]
    for f in sorted(os.listdir(IMG)):
        stem,ext=os.path.splitext(f)
        if ext.lower() not in ('.png','.jpg','.jpeg','.webp'): continue
        md=os.path.join(MSK,stem)
        if not os.path.isdir(md): continue
        stems.append((f,stem,md))
    n=0; nl=0
    for f,stem,md in stems:
        img=cv2.imdecode(np.fromfile(os.path.join(IMG,f),dtype=np.uint8),cv2.IMREAD_COLOR)
        if img is None: continue
        H,W=img.shape[:2]; lines=[]
        for mf in sorted(glob.glob(os.path.join(md,'*.png'))):
            parts=os.path.basename(mf).split('_')
            try: cls=int(parts[1])
            except: continue
            m=cv2.imdecode(np.fromfile(mf,dtype=np.uint8),cv2.IMREAD_UNCHANGED)
            if m is None: continue
            if m.ndim==3: m=m[:,:,3] if m.shape[2]==4 else m[:,:,0]
            if m.shape[0]!=H or m.shape[1]!=W: m=cv2.resize(m,(W,H),interpolation=cv2.INTER_NEAREST)
            m=(m>127).astype(np.uint8)*255
            for p in polys(m):
                lines.append(str(cls)+' '+' '.join(f'{x/W:.5f} {y/H:.5f}' for x,y in p))
        # MK4: 학습 모드에서 "가릴 부위 없음"으로 확정한 사진(_배경.txt)은 빈 라벨로 넣는다 (배경 샘플 → 헛잡기 줄임)
        if not lines and not os.path.exists(os.path.join(md,'_배경.txt')): continue
        split='val' if random.random()<0.1 else 'train'
        out_img=os.path.join(DS,'images',split,stem+'.png')
        cv2.imencode('.png',img)[1].tofile(out_img)
        with open(os.path.join(DS,'labels',split,stem+'.txt'),'w',encoding='utf-8') as fh: fh.write(('\n'.join(lines)+'\n') if lines else '')
        n+=1; nl+=len(lines)
    with open(os.path.join(DS,'data.yaml'),'w',encoding='utf-8') as fh:
        fh.write(f"path: {DS}\ntrain: images/train\nval: images/val\nnames:\n  0: nipples\n  1: pussy\n  2: anus\n  3: penis\n  4: cross-section\n  5: x-ray\n  6: testicles\n")
    print(f'라벨 변환: 그림 {n}장 · 부위 {nl}개 → {DS}')
    return n
if __name__=='__main__': main()
