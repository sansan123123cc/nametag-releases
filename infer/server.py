# 이름표 정밀 검수 서버 (MK5)
# 편집기가 [파이썬 정밀] 을 켜면 껍데기(main.js)가 이 파일을 train\venv 파이썬으로 띄운다. 평소엔 안 돈다.
#   GET  /health                → GPU·모델 목록
#   POST /detect {path|png_b64, imgsz, tta, models, conf, want, min_votes, solo_min}
#                               → 모델별 결과 + 투표 결과 (마스크는 잘라서 PNG base64)
# TTA: ultralytics 가 이 모델에 augment 를 안 지원해서 직접 본다 — 원본 + 좌우 뒤집기 (+ 1.25배 크기), 모델별로 합친 뒤 모델끼리 투표.
import os, sys, json, time, glob, base64, io, threading, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np, cv2

PORT = int(sys.argv[sys.argv.index('--port')+1]) if '--port' in sys.argv else 17865
DATA = sys.argv[sys.argv.index('--data')+1] if '--data' in sys.argv else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LABELS = ['nipples','pussy','anus','penis','cross-section','x-ray','testicles']
_models = {}          # id → YOLO
_lock = threading.Lock()
_torch = None

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

def model_list():
    """models\\*.pt · train\\base\\*.pt · train\\runs\\*\\weights\\best.pt · train\\out\\*.pt (.onnx 도 되지만 느리고 뒤집기만)"""
    out, seen = [], set()
    cands = [('models', os.path.join(DATA,'models','*.pt')), ('base', os.path.join(DATA,'train','base','*.pt')),
             ('학습본', os.path.join(DATA,'train','runs','*','weights','best.pt')), ('학습본', os.path.join(DATA,'train','out','*.pt')),
             ('models', os.path.join(DATA,'models','*.onnx'))]
    for kind, pat in cands:
        for p in sorted(glob.glob(pat)):
            p = os.path.abspath(p)
            if p in seen: continue
            seen.add(p)
            name = os.path.basename(p)
            if kind == '학습본' and name == 'best.pt': name = os.path.basename(os.path.dirname(os.path.dirname(p))) + '/best.pt'
            out.append({'id': p, 'name': name, 'kind': kind, 'onnx': p.lower().endswith('.onnx'), 'mtime': int(os.path.getmtime(p))})
    return out

def get_model(path):
    with _lock:
        m = _models.get(path)
        if m is None:
            from ultralytics import YOLO
            log('모델 읽음', path)
            m = YOLO(path); _models[path] = m
        return m

def gpu_info():
    global _torch
    try:
        import torch; _torch = torch
        ok = torch.cuda.is_available()
        return {'cuda': ok, 'name': torch.cuda.get_device_name(0) if ok else 'CPU', 'torch': torch.__version__}
    except Exception as e:
        return {'cuda': False, 'name': 'CPU', 'err': str(e)}

def decode_image(req):
    if req.get('path'):
        p = req['path']
        buf = np.fromfile(p, dtype=np.uint8)
        im = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if im is None: raise ValueError('그림을 못 읽음: ' + p)
        return im
    if req.get('png_b64'):
        buf = np.frombuffer(base64.b64decode(req['png_b64']), np.uint8)
        im = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if im is None: raise ValueError('png_b64 못 읽음')
        return im
    raise ValueError('path 나 png_b64 가 필요')

def run_view(m, im, imgsz, conf, want_idx, device):
    """한 번 돌려서 [(label_idx, score, mask HxW uint8)]"""
    H, W = im.shape[:2]
    r = m.predict(im, imgsz=imgsz, conf=conf, classes=want_idx or None, verbose=False, device=device, retina_masks=True)[0]
    out = []
    if r.boxes is None or len(r.boxes) == 0: return out
    cls = r.boxes.cls.cpu().numpy().astype(int); sc = r.boxes.conf.cpu().numpy()
    if r.masks is not None and r.masks.data is not None:
        md = r.masks.data.cpu().numpy()                       # N × h × w (retina_masks → 원본 크기)
        for k in range(len(cls)):
            mk = md[k]
            if mk.shape[0] != H or mk.shape[1] != W: mk = cv2.resize(mk, (W, H), interpolation=cv2.INTER_LINEAR)
            out.append((int(cls[k]), float(sc[k]), (mk > 0.5).astype(np.uint8)))
    else:
        xy = r.boxes.xyxy.cpu().numpy()
        for k in range(len(cls)):
            mk = np.zeros((H, W), np.uint8); x1, y1, x2, y2 = [int(round(v)) for v in xy[k]]
            cv2.ellipse(mk, ((x1+x2)//2, (y1+y2)//2), (max(1,(x2-x1)//2), max(1,(y2-y1)//2)), 0, 0, 360, 1, -1)
            out.append((int(cls[k]), float(sc[k]), mk))
    return out

def iou_mask(a, b):
    i = np.logical_and(a, b).sum(); u = np.logical_or(a, b).sum()
    return float(i) / float(u) if u else 0.0

def merge_views(dets):
    """같은 모델의 여러 보기(원본·뒤집기·확대) → 같은 자리끼리 합침: 점수 최대, 모양은 합집합"""
    dets = sorted(dets, key=lambda d: -d[1]); groups = []
    for c, s, m in dets:
        for g in groups:
            if g['c'] == c and iou_mask(g['m'], m) >= 0.3:
                g['s'] = max(g['s'], s); g['m'] = np.logical_or(g['m'], m).astype(np.uint8); g['n'] += 1; break
        else:
            groups.append({'c': c, 's': s, 'm': m, 'n': 1})
    return groups

def vote(per_model, n_models, min_votes, solo_min):
    """모델끼리 투표. 있음 = 모델 min_votes 개 이상 (또는 혼자여도 점수 solo_min 이상). 모양 = 과반 픽셀(중간값)."""
    allg = []
    for mid, groups in per_model:
        for g in groups: allg.append((mid, g))
    allg.sort(key=lambda t: -t[1]['s']); clusters = []
    for mid, g in allg:
        for cl in clusters:
            if cl['c'] == g['c'] and mid not in cl['mids'] and iou_mask(cl['ref'], g['m']) >= 0.3:
                cl['members'].append((mid, g)); cl['mids'].add(mid); break
        else:
            clusters.append({'c': g['c'], 'ref': g['m'], 'members': [(mid, g)], 'mids': {mid}})
    out = []
    for cl in clusters:
        votes = len(cl['mids']); best = max(m[1]['s'] for m in cl['members'])
        if votes < min_votes and best < solo_min: continue
        if votes >= 2:
            stack = np.stack([m[1]['m'] for m in cl['members']]).astype(np.uint16)
            mask = (stack.sum(0) * 2 >= len(cl['members'])).astype(np.uint8)   # 과반
            if mask.sum() < 20: mask = np.logical_or.reduce([m[1]['m'] for m in cl['members']]).astype(np.uint8)
        else:
            mask = cl['members'][0][1]['m']
        out.append({'c': cl['c'], 's': best, 'votes': votes, 'mids': sorted(cl['mids']), 'm': mask})
    return out

def pack_mask(mask):
    ys, xs = np.where(mask)
    if len(xs) == 0: return None
    x1, x2, y1, y2 = int(xs.min()), int(xs.max())+1, int(ys.min()), int(ys.max())+1
    crop = (mask[y1:y2, x1:x2] * 255).astype(np.uint8)
    ok, png = cv2.imencode('.png', crop)
    return {'x': x1, 'y': y1, 'w': x2-x1, 'h': y2-y1, 'png_b64': base64.b64encode(png.tobytes()).decode('ascii')}

def detect(req):
    t0 = time.time(); im = decode_image(req); H, W = im.shape[:2]
    imgsz = int(req.get('imgsz') or 1280); tta = bool(req.get('tta', True)); conf = float(req.get('conf') or 0.3)
    want = req.get('want') or LABELS; want_idx = [LABELS.index(w) for w in want if w in LABELS]
    ids = req.get('models') or [m['id'] for m in model_list() if not m['onnx']][:3]
    min_votes = int(req.get('min_votes') or 1); solo_min = float(req.get('solo_min') or 0.0)
    info = gpu_info(); device = 0 if info['cuda'] else 'cpu'
    per_model = []; raw = []
    for mid in ids:
        m = get_model(mid); dets = []
        views = [('orig', im)]
        if tta: views.append(('flip', cv2.flip(im, 1)))
        for vname, vim in views:
            try:
                ds = run_view(m, vim, imgsz, conf, want_idx, device)
            except Exception as e:
                if 'out of memory' in str(e).lower() and imgsz > 640:
                    log('VRAM 부족 → 크기 줄임');
                    if _torch: _torch.cuda.empty_cache()
                    ds = run_view(m, vim, max(640, imgsz*3//4), conf, want_idx, device)
                else: raise
            if vname == 'flip': ds = [(c, s, cv2.flip(mk, 1)) for c, s, mk in ds]
            dets += ds
        if tta and max(H, W) * 1.25 <= 2048:                     # 1.25배 (작은 부위용)
            big = cv2.resize(im, (int(W*1.25), int(H*1.25)), interpolation=cv2.INTER_CUBIC)
            try:
                ds = run_view(m, big, int(imgsz*1.25), conf, want_idx, device)
                dets += [(c, s, cv2.resize(mk, (W, H), interpolation=cv2.INTER_NEAREST)) for c, s, mk in ds]
            except Exception as e:
                log('1.25배 실패', e)
        groups = merge_views(dets); per_model.append((mid, groups))
        raw.append({'id': mid, 'name': os.path.basename(mid), 'dets': [{'label': LABELS[g['c']], 'score': round(g['s'], 3), 'views': g['n'], **{k: v for k, v in (pack_mask(g['m']) or {}).items() if k != 'png_b64'}} for g in groups]})
    final = vote(per_model, len(ids), min_votes, solo_min)
    dets = []
    for f in final:
        pm = pack_mask(f['m'])
        if not pm: continue
        dets.append({'label': LABELS[f['c']], 'score': round(f['s'], 3), 'votes': f['votes'], 'of': len(ids), 'models': [os.path.basename(x) for x in f['mids']],
                     'x': pm['x'], 'y': pm['y'], 'w': pm['w'], 'h': pm['h'], 'mask': pm})
    return {'ok': True, 'w': W, 'h': H, 'imgsz': imgsz, 'tta': tta, 'models': [os.path.basename(x) for x in ids], 'per_model': raw, 'dets': dets, 'ms': int((time.time()-t0)*1000), 'device': info['name']}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self):
        self.send_response(204); self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Headers', 'Content-Type'); self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); self.end_headers()
    def do_GET(self):
        if self.path.startswith('/health'):
            self._send(200, {'ok': True, 'gpu': gpu_info(), 'models': model_list(), 'loaded': list(_models.keys()), 'port': PORT, 'data': DATA, 'pid': os.getpid()})
        elif self.path.startswith('/quit'):
            self._send(200, {'ok': True}); threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0))).start()
        else: self._send(404, {'ok': False, 'err': 'no'})
    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length') or 0); req = json.loads(self.rfile.read(n) or b'{}')
            if self.path.startswith('/detect'):
                self._send(200, detect(req))                                   # 모델 읽기만 잠금 · 추론은 GPU 가 알아서 줄 섬
            elif self.path.startswith('/unload'):
                with _lock: _models.clear()
                if _torch and _torch.cuda.is_available(): _torch.cuda.empty_cache()
                self._send(200, {'ok': True})
            else: self._send(404, {'ok': False, 'err': 'no'})
        except Exception as e:
            log('오류', traceback.format_exc()); self._send(500, {'ok': False, 'err': str(e)})

if __name__ == '__main__':
    log('정밀 검수 서버 시작 · 포트', PORT, '· 데이터', DATA, '·', gpu_info())
    log('모델:', [m['name'] for m in model_list()])
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
