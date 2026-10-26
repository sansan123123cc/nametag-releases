/* 이름표 v4 preload — Electron엔 File System Access API(showDirectoryPicker 등)가 없다.
   같은 모양의 핸들을 Node fs로 만들어 준다 (MK1: 편집기 코드는 그대로, MK2에서 경로 기반 API로 바꿈). */
const { ipcRenderer, webUtils } = require('electron');
const fs = require('fs'); const fsp = fs.promises; const path = require('path');

const MIME = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif', bmp:'image/bmp', mp4:'video/mp4', m4v:'video/mp4', mov:'video/quicktime', webm:'video/webm', json:'application/json', txt:'text/plain', onnx:'application/octet-stream' };
const mimeOf = n => MIME[(n.split('.').pop()||'').toLowerCase()] || 'application/octet-stream';
const same = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const FILE_LRU=new Map();     /* 같은 파일 다시 안 읽기 (최근 120개) */
class NFileHandle {
  constructor(p){ this.kind='file'; this.name=path.basename(p); Object.defineProperty(this,'__p',{value:p,enumerable:true,writable:true}); }
  async getFile(){ const st=await fsp.stat(this.__p); const key=this.__p+'|'+st.size+'|'+st.mtimeMs; const c=FILE_LRU.get(key); if(c){ FILE_LRU.delete(key); FILE_LRU.set(key,c); return c }
    const buf=await fsp.readFile(this.__p);
    const f=new File([buf], this.name, { type:mimeOf(this.name), lastModified:Math.round(st.mtimeMs) }); try{ Object.defineProperty(f,'path',{value:this.__p}) }catch(e){}
    FILE_LRU.set(key,f); if(FILE_LRU.size>120){ FILE_LRU.delete(FILE_LRU.keys().next().value) } return f; }
  async stat(){ const st=await fsp.stat(this.__p); return {size:st.size,lastModified:Math.round(st.mtimeMs)} }
  async createWritable(opts){ const tmp=this.__p+'.쓰는중'; const chunks=[]; let pos=0; const self=this;
    return { async write(d){ if(d&&d.type==='write'&&d.data!==undefined)d=d.data; if(d instanceof Blob)d=Buffer.from(await d.arrayBuffer()); else if(d instanceof ArrayBuffer)d=Buffer.from(d); else if(ArrayBuffer.isView(d))d=Buffer.from(d.buffer,d.byteOffset,d.byteLength); else if(typeof d==='string')d=Buffer.from(d,'utf8'); chunks.push(d); pos+=d.length; },
      async truncate(n){ /* 통째로 쓰는 용도만 */ }, async seek(n){ },
      async close(){ await fsp.writeFile(tmp, Buffer.concat(chunks)); await fsp.rename(tmp, self.__p); },
      async abort(){ try{ await fsp.unlink(tmp) }catch(e){} } }; }
  async queryPermission(){ return 'granted' } async requestPermission(){ return 'granted' }
  async isSameEntry(o){ return !!(o&&o.__p&&same(o.__p,this.__p)) }
  async move(a,b){ let dst; if(typeof a==='string')dst=path.join(path.dirname(this.__p),a); else dst=path.join(a.__p, b||this.name);
    await fsp.rename(this.__p,dst); this.__p=dst; this.name=path.basename(dst); }
}
class NDirHandle {
  constructor(p){ this.kind='directory'; this.name=path.basename(p)||p; Object.defineProperty(this,'__p',{value:p,enumerable:true,writable:true}); }
  async getFileHandle(name,o){ const p=path.join(this.__p,name); try{ const st=await fsp.stat(p); if(!st.isFile())throw Object.assign(new Error('TypeMismatchError'),{name:'TypeMismatchError'}); }
    catch(e){ if(e.code==='ENOENT'){ if(o&&o.create){ await fsp.writeFile(p,Buffer.alloc(0)) } else throw Object.assign(new Error('NotFoundError: '+name),{name:'NotFoundError'}) } else throw e }
    return new NFileHandle(p); }
  async getDirectoryHandle(name,o){ const p=path.join(this.__p,name); try{ const st=await fsp.stat(p); if(!st.isDirectory())throw Object.assign(new Error('TypeMismatchError'),{name:'TypeMismatchError'}); }
    catch(e){ if(e.code==='ENOENT'){ if(o&&o.create){ await fsp.mkdir(p,{recursive:true}) } else throw Object.assign(new Error('NotFoundError: '+name),{name:'NotFoundError'}) } else throw e }
    return new NDirHandle(p); }
  async removeEntry(name,o){ const p=path.join(this.__p,name); const st=await fsp.stat(p);
    if(st.isDirectory()){ if(o&&o.recursive) await fsp.rm(p,{recursive:true,force:true}); else await fsp.rmdir(p); } else await fsp.unlink(p); }
  async *entries(){ const ds=await fsp.readdir(this.__p,{withFileTypes:true}); for(const d of ds){ const p=path.join(this.__p,d.name); if(d.isDirectory())yield [d.name,new NDirHandle(p)]; else if(d.isFile())yield [d.name,new NFileHandle(p)]; } }
  async *values(){ for await(const [,h] of this.entries())yield h } async *keys(){ for await(const [n] of this.entries())yield n }
  [Symbol.asyncIterator](){ return this.entries() }
  async queryPermission(){ return 'granted' } async requestPermission(){ return 'granted' }
  async isSameEntry(o){ return !!(o&&o.__p&&same(o.__p,this.__p)) }
  async resolve(h){ if(!h||!h.__p)return null; const r=path.relative(this.__p,h.__p); if(r.startsWith('..'))return null; return r.split(path.sep).filter(Boolean) }
}
/* IndexedDB에 저장됐다가 나온 핸들({__p,kind,name}만 남음) 되살리기 */
function revive(o){ if(!o||typeof o!=='object')return o; if(o.__p&&o.kind==='directory'&&!(o instanceof NDirHandle))return new NDirHandle(o.__p); if(o.__p&&o.kind==='file'&&!(o instanceof NFileHandle))return new NFileHandle(o.__p); return o }
window.__nfsRevive = revive;
window.showDirectoryPicker = async function(opts){ const p=await ipcRenderer.invoke('nametag:pick-dir', opts&&opts.id||''); if(!p)throw Object.assign(new Error('취소'),{name:'AbortError'}); return new NDirHandle(p) };
window.showOpenFilePicker = async function(opts){ const ps=await ipcRenderer.invoke('nametag:pick-files', !!(opts&&opts.multiple)); if(!ps||!ps.length)throw Object.assign(new Error('취소'),{name:'AbortError'}); return ps.map(p=>new NFileHandle(p)) };
window.showSaveFilePicker = async function(opts){ const p=await ipcRenderer.invoke('nametag:pick-save', opts&&opts.suggestedName||''); if(!p)throw Object.assign(new Error('취소'),{name:'AbortError'}); return new NFileHandle(p) };
/* 끌어다 놓기: 폴더·파일 경로 → 핸들 */
if(typeof DataTransferItem!=='undefined'){ DataTransferItem.prototype.getAsFileSystemHandle = async function(){ const f=this.getAsFile(); if(!f)return null; let p=''; try{ p=webUtils.getPathForFile(f) }catch(e){} if(!p)return null;
  try{ const st=fs.statSync(p); return st.isDirectory()?new NDirHandle(p):new NFileHandle(p) }catch(e){ return null } } }
/* IDB에서 꺼낸 핸들 되살리기: get 결과·cursor value 안의 핸들 */
(function(){ const wrap=(obj,key)=>{ const o=obj[key]; if(!o)return; Object.defineProperty(obj,key,{get(){ return revive(o) }}) };
  const _get=IDBRequest.prototype; const d=Object.getOwnPropertyDescriptor(_get,'result'); if(d&&d.get){ Object.defineProperty(_get,'result',{get(){ const r=d.get.call(this); if(r&&typeof r==='object'&&!Array.isArray(r)){ if(r.__p)return revive(r); if(r.handle&&r.handle.__p)r.handle=revive(r.handle); if(r.dir&&r.dir.__p)r.dir=revive(r.dir); } return r },configurable:true}) } })();
const NT_INFO=(()=>{ try{ return ipcRenderer.sendSync('nametag:info-sync') }catch(e){ return null } })();
const safeKey=k=>String(k).replace(/^https?:\/\//,'').replace(/[^0-9A-Za-z._-]+/g,'_').slice(0,120);
const MODELS=()=>{ const d=path.join(NT_INFO.dataDir,'models'); fs.mkdirSync(d,{recursive:true}); return d };
/* 모델 보관: 데이터폴더/models/<key>.bin + .json · 사용자가 직접 복사해 넣은 *.onnx 도 인식 */
const models={
  async get(k){ const d=MODELS(), b=path.join(d,safeKey(k)+'.bin'), j=path.join(d,safeKey(k)+'.json');
    if(fs.existsSync(b)){ let meta={}; try{ meta=JSON.parse(fs.readFileSync(j,'utf8')) }catch(e){} const buf=await fsp.readFile(b); return {...meta,data:buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength),size:buf.byteLength} }
    if(/ntd11|seg/i.test(k)){ const c=fs.readdirSync(d).filter(f=>/\.onnx$/i.test(f)&&/ntd11|seg/i.test(f)).sort(); if(c.length){ const f=c[c.length-1], buf=await fsp.readFile(path.join(d,f)); return {name:'애니 seg · '+f,imgsz:/640/.test(f)?640:1024,t:0,file:f,data:buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength),size:buf.byteLength} } }
    return null },
  async put(k,v){ const d=MODELS(), b=path.join(d,safeKey(k)+'.bin'), j=path.join(d,safeKey(k)+'.json'); const {data,...meta}=v||{}; if(data){ const u=data instanceof ArrayBuffer?Buffer.from(data):Buffer.from(data.buffer||data); await fsp.writeFile(b+'.쓰는중',u); await fsp.rename(b+'.쓰는중',b) } await fsp.writeFile(j,JSON.stringify({...meta,key:k,size:v&&v.size||0})) },
  async keys(){ const d=MODELS(); const out=[]; for(const f of fs.readdirSync(d)){ if(/\.json$/.test(f)){ try{ out.push(JSON.parse(fs.readFileSync(path.join(d,f),'utf8')).key||f) }catch(e){} } else if(/\.onnx$/i.test(f))out.push('file:'+f) } return out },
  async list(){ const d=MODELS(); const out=[]; for(const f of fs.readdirSync(d)){ const p=path.join(d,f); if(/\.json$/.test(f)){ let m={}; try{ m=JSON.parse(fs.readFileSync(p,'utf8')) }catch(e){} let sz=0; try{ sz=fs.statSync(p.replace(/\.json$/,'.bin')).size }catch(e){} out.push({k:m.key||f,name:m.name||f,size:sz}) } else if(/\.onnx$/i.test(f))out.push({k:'file:'+f,name:f+' (직접 넣음)',size:fs.statSync(p).size}) } return out },
  async clear(){ const d=MODELS(); for(const f of fs.readdirSync(d)){ if(/\.(bin|json)$/.test(f))await fsp.unlink(path.join(d,f)) } },
  dir(){ return MODELS() }
};
/* 폴더 지켜보기: 하위 폴더까지 · 바뀌면 cb() · 돌려주는 객체의 close()로 끝 */
function watchDir(p,cb){ let w=null; try{ w=fs.watch(p,{recursive:true},(ev,name)=>{ if(name&&/\.(쓰는중|tmp|crdownload|part)$/i.test(String(name)))return; try{cb(ev,name)}catch(e){} }); w.on('error',e=>console.warn('watch',e)) }catch(e){ console.warn('watch 실패',e); return {close(){}} } return {close(){ try{w.close()}catch(e){} }} }
window.nametag = { info:()=>ipcRenderer.invoke('nametag:info'), sync:NT_INFO, models, watch:watchDir, pickDataDir:()=>ipcRenderer.invoke('nametag:pick-data-dir'), onDataDir:(fn)=>ipcRenderer.on('nametag:data-dir',(_,d)=>fn(d)), shell:true, fsPath:h=>h&&h.__p||null,
  py:{ start:()=>ipcRenderer.invoke('nametag:py-start'), stop:()=>ipcRenderer.invoke('nametag:py-stop'), status:()=>ipcRenderer.invoke('nametag:py-status') },
  update:{ check:(q)=>ipcRenderer.invoke('nametag:update-check',!!q), state:()=>ipcRenderer.invoke('nametag:update-state'), on:(fn)=>ipcRenderer.on('nametag:update-state',(_,st)=>fn(st)) },
  openTrain:()=>ipcRenderer.invoke('nametag:open-train'),
  onTool:(fn)=>ipcRenderer.on('nametag:open-tool',(_,t)=>fn(t)),
  get mode(){ try{ return new URLSearchParams(location.search).get('mode')||'' }catch(e){ return '' } } };
