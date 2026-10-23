/* 이름표 v4 — 설치형 껍데기 (MK5: 파이썬 정밀 검수 서버 · 학습 전용 창 · 자동 업데이트)
   구조: 설치 폴더(프로그램) / 데이터 폴더(사용자가 고름: models, work, backup, train, editor-override, config.json)
   편집기 화면은 resources/editor/editor.html — 데이터 폴더의 editor/editor.html 이 있으면 그걸 우선 (업데이트 파일 넣기) */
const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } = require('electron');
const fs = require('fs'); const path = require('path');

const APP_VER = app.getVersion(), MK = 6;
const http = require('http');
const { spawn } = require('child_process');
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
function loadCfg(){ try{ return JSON.parse(fs.readFileSync(cfgPath(),'utf8')) }catch(e){ return {} } }
function saveCfg(c){ fs.mkdirSync(path.dirname(cfgPath()),{recursive:true}); fs.writeFileSync(cfgPath(), JSON.stringify(c,null,2)) }
let cfg = loadCfg();
if(process.env.NAMETAG_DATA){ cfg.dataDir=process.env.NAMETAG_DATA; fs.mkdirSync(cfg.dataDir,{recursive:true}); }   /* 테스트용 */

const SUB = ['models','work','backup','train','editor','update','infer'];
function ensureData(dir){ for(const s of SUB) fs.mkdirSync(path.join(dir,s),{recursive:true}); copyTrainScripts(dir); copyScripts(dir,'infer'); }
/* 학습 스크립트를 데이터 폴더 train/ 에 복사 (새 버전이면 덮어씀 · 사용자 파일은 안 건드림) */
function copyScripts(dir,sub){ try{ const src=app.isPackaged?path.join(process.resourcesPath,sub):path.join(__dirname,'..',sub); const dst=path.join(dir,sub); fs.mkdirSync(dst,{recursive:true});
  const stamp=path.join(dst,'_버전.txt'); let cur=''; try{ cur=fs.readFileSync(stamp,'utf8').trim() }catch(e){}
  const want=`${APP_VER} MK${MK}`;
  for(const f of fs.readdirSync(src)){ const a=path.join(src,f), b=path.join(dst,f); if(fs.statSync(a).isDirectory())continue;
    if(!fs.existsSync(b)||(cur!==want&&!fs.readFileSync(a).equals(fs.readFileSync(b))))fs.copyFileSync(a,b) }          /* 버전이 바뀐 첫 실행에만 덮어씀 → 사용자가 고친 bat 이 매번 되돌아가지 않음 */
  fs.writeFileSync(stamp,want) }catch(e){ console.warn(sub+' scripts',e) } }
function copyTrainScripts(dir){ copyScripts(dir,'train') }
/* ---- MK5 파이썬 정밀 검수 서버: 편집기가 켤 때만 띄움 · 앱 끄면 같이 꺼짐 ---- */
const PY_PORT = () => cfg.pyPort || 17865;
let pyProc=null, pyLog=null;
function pyExe(){ if(process.env.NAMETAG_PY)return process.env.NAMETAG_PY; if(!cfg.dataDir)return null; const v=path.join(cfg.dataDir,'train','venv'); const p=process.platform==='win32'?path.join(v,'Scripts','python.exe'):path.join(v,'bin','python'); return fs.existsSync(p)?p:null }
function pyGet(p,timeout){ return new Promise(res=>{ const req=http.get({host:'127.0.0.1',port:PY_PORT(),path:p,timeout:timeout||1500},r=>{ let b=''; r.on('data',d=>b+=d); r.on('end',()=>{ try{ res(JSON.parse(b)) }catch(e){ res(null) } }) }); req.on('error',()=>res(null)); req.on('timeout',()=>{ req.destroy(); res(null) }) }) }
async function pyStatus(){ const h=await pyGet('/health'); return { up:!!(h&&h.ok), port:PY_PORT(), health:h, venv:!!pyExe(), running:!!(pyProc&&pyProc.exitCode===null), log:cfg.dataDir?path.join(cfg.dataDir,'infer','server.log'):null } }
async function pyStart(){
  const st=await pyStatus(); if(st.up)return {ok:true,...st};
  const exe=pyExe(); if(!exe)return {ok:false,err:'파이썬 환경이 없다 · 메뉴 [학습 → 1. 환경 설치] 먼저 (10분쯤)',...st};
  const dir=path.join(cfg.dataDir,'infer'), srv=path.join(dir,'server.py'); if(!fs.existsSync(srv))return {ok:false,err:'server.py 없음: '+srv,...st};
  if(pyProc&&pyProc.exitCode===null){ try{ pyProc.kill() }catch(e){} }
  try{ pyLog=fs.openSync(path.join(dir,'server.log'),'a') }catch(e){ pyLog=null }
  pyProc=spawn(exe,['-u',srv,'--port',String(PY_PORT()),'--data',cfg.dataDir],{cwd:dir,stdio:['ignore',pyLog||'ignore',pyLog||'ignore'],windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  pyProc.on('exit',c=>{ console.log('py server exit',c); if(pyLog){ try{ fs.closeSync(pyLog) }catch(e){} pyLog=null } });
  const t0=Date.now(); while(Date.now()-t0<90000){ await new Promise(r=>setTimeout(r,700)); if(pyProc.exitCode!==null)return {ok:false,err:'서버가 바로 꺼짐 · infer\\server.log 봐라 (ultralytics 설치 안 됐으면 [1. 환경 설치] 다시)',...(await pyStatus())}; const h=await pyGet('/health'); if(h&&h.ok)return {ok:true,...(await pyStatus())} }
  return {ok:false,err:'90초 안에 안 떴다 · infer\\server.log 봐라',...(await pyStatus())};
}
async function pyStop(){ await pyGet('/quit',800); if(pyProc&&pyProc.exitCode===null){ setTimeout(()=>{ try{ pyProc.kill() }catch(e){} },1500) } return {ok:true} }
app.on('before-quit',()=>{ if(pyProc&&pyProc.exitCode===null){ try{ pyProc.kill() }catch(e){} } });
/* ---- MK5 자동 업데이트 (GitHub Releases) · 저장소는 데이터폴더\update\업데이트주소.txt 에 "owner/repo" 한 줄 ---- */
const UPD_DEFAULT={owner:'sansan123123cc',repo:'nametag-releases'};                     /* 기본 저장소 (사용자 GitHub) · 업데이트주소.txt 에 적으면 그게 우선 */
function updRepo(){ try{ const t=fs.readFileSync(path.join(cfg.dataDir,'update','업데이트주소.txt'),'utf8'); const m=t.replace(/^#.*$/mg,'').match(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/); if(m)return {owner:m[1],repo:m[2]} }catch(e){} return UPD_DEFAULT }
function updRepoFile(){ const f=path.join(cfg.dataDir,'update','업데이트주소.txt'); if(!fs.existsSync(f))fs.writeFileSync(f,'# 자동 업데이트 저장소 · 비워두면 기본값 sansan123123cc/nametag-releases\n# 바꾸려면 아래 줄에 GitHub "소유자/저장소" 를 적고 저장 (공개 저장소만)\n\n'); return f }
let updater=null, updState={status:'idle'}, updQuiet=true;
function updInit(){ if(updater)return updater; try{ const {autoUpdater}=require('electron-updater'); updater=autoUpdater; updater.autoDownload=true; updater.autoInstallOnAppQuit=true; updater.allowPrerelease=false;
    updater.logger={info:m=>updLog('info',m),warn:m=>updLog('warn',m),error:m=>updLog('error',m),debug:()=>{}};
    updater.on('checking-for-update',()=>{ updState={status:'checking'}; updSend() });
    updater.on('update-available',i=>{ updState={status:'downloading',version:i.version}; updSend(); if(!updQuiet)dialog.showMessageBox(win,{message:`새 버전 ${i.version} 있다 · 받는 중 (뒤에서)`}) });
    updater.on('update-not-available',i=>{ updState={status:'latest',version:i&&i.version}; updSend(); if(!updQuiet)dialog.showMessageBox(win,{message:`지금이 최신이다 (v${APP_VER})`}) });
    updater.on('download-progress',p=>{ updState={status:'downloading',percent:Math.round(p.percent)}; updSend() });
    updater.on('error',e=>{ updState={status:'error',err:String(e&&e.message||e)}; updSend() });
    updater.on('update-downloaded',i=>{ updState={status:'ready',version:i.version}; updSend();
      const r=dialog.showMessageBoxSync(win,{type:'question',buttons:['지금 재시작해서 설치','나중에 (끌 때 설치)'],message:`새 버전 ${i.version} 받았다`,detail:'설치 폴더만 바뀌고 데이터 폴더는 그대로다.'}); if(r===0)updater.quitAndInstall() });
  }catch(e){ console.warn('updater',e) } return updater }
function updLog(l,m){ try{ fs.appendFileSync(path.join(cfg.dataDir,'update','update.log'),`${new Date().toISOString()} ${l} ${m}\n`) }catch(e){} }
function updSend(){ try{ if(win)win.webContents.send('nametag:update-state',updState) }catch(e){} }
async function updCheck(quiet){ updQuiet=!!quiet;
  const repo=updRepo();
  const u=updInit(); if(!u)return updState; updState={status:'checking'}; updSend(); try{ u.setFeedURL({provider:'github',owner:repo.owner,repo:repo.repo}); const r=await u.checkForUpdates(); if(!r&&updState.status==='checking'){ updState={status:'skipped',err:'패키지 설치본이 아니라 확인 안 함'}; updSend() } }catch(e){ updState={status:'error',err:String(e&&e.message||e)}; updSend(); if(!quiet)dialog.showMessageBoxSync(win,{type:'error',message:'업데이트 확인 실패',detail:updState.err}) }
  return updState }
function runBat(name){ if(!cfg.dataDir)return; const d=path.join(cfg.dataDir,'train'), b=path.join(d,name); if(!fs.existsSync(b)){ dialog.showMessageBoxSync(win,{type:'error',message:name+' 없음',detail:d}); return }
  if(process.platform==='win32'){ spawn('cmd.exe',['/c','start','"이름표 학습"','/D',d,'cmd','/k',b],{detached:true,stdio:'ignore',windowsVerbatimArguments:true}).unref() } else { shell.openPath(d) } }
function builtinEditor(){ return app.isPackaged ? path.join(process.resourcesPath,'editor','editor.html') : path.join(__dirname,'..','editor','editor.html') }
function editorPath(){
  if(cfg.dataDir){ const o = path.join(cfg.dataDir,'editor','editor.html'); if(fs.existsSync(o)) return o; }
  return builtinEditor();
}
function editorInfo(){ const p=editorPath(); let mk=''; try{ const m=fs.readFileSync(p,'utf8').match(/<title>[^<]*?(v\d+\s*MK\d+[^<]*)<\/title>/); mk=m?m[1].trim():'' }catch(e){} return {path:p, override:p!==builtinEditor(), mk} }

async function pickDataDir(win){
  const r = await dialog.showOpenDialog(win, { title:'데이터 폴더 고르기 (모델·보관함·백업·학습 자료가 여기 저장됨)', properties:['openDirectory','createDirectory'],
    defaultPath: cfg.dataDir || path.join(app.getPath('documents'),'이름표데이터') });
  if(r.canceled || !r.filePaths[0]) return null;
  const d = r.filePaths[0];
  const inst = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  if(d.toLowerCase().startsWith(inst.toLowerCase())){ dialog.showMessageBoxSync(win,{type:'error',message:'설치 폴더 안은 안 된다',detail:'업데이트하면 지워질 수 있어서 데이터 폴더는 설치 폴더 밖에 둬야 한다.'}); return null }
  ensureData(d); cfg.dataDir = d; saveCfg(cfg); return d;
}

let win=null;
function createWindow(){
  win = new BrowserWindow({ width:1500, height:940, minWidth:900, minHeight:600, title:`이름표 v${APP_VER}`, backgroundColor:'#14171c',
    webPreferences:{ preload:path.join(__dirname,'preload.js'), contextIsolation:false, nodeIntegration:false, sandbox:false, webSecurity:false } });
  win.webContents.setWindowOpenHandler(({url})=>{ if(/^https?:/.test(url)) shell.openExternal(url); return {action:'deny'} });
  win.loadFile(editorPath());
  win.on('closed',()=>{ win=null });
}
let trainWin=null;
function openTrainWindow(){                                /* MK5: 학습 전용 창 (사진 넣고 표시만 · 이름 바꾸기 없음) */
  if(trainWin&&!trainWin.isDestroyed()){ trainWin.focus(); return }
  trainWin = new BrowserWindow({ width:1500, height:940, minWidth:900, minHeight:600, title:`이름표 학습 모드 v${APP_VER}`, backgroundColor:'#14171c',
    webPreferences:{ preload:path.join(__dirname,'preload.js'), contextIsolation:false, nodeIntegration:false, sandbox:false, webSecurity:false } });
  trainWin.setMenuBarVisibility(false);
  trainWin.loadFile(editorPath(),{query:{mode:'train'}});
  trainWin.on('closed',()=>{ trainWin=null });
}
function applyUpdateFile(file){
  if(!cfg.dataDir) return '데이터 폴더 먼저';
  const txt = fs.readFileSync(file,'utf8');
  if(!/<title>[^<]*이름표/.test(txt)) return '편집기 파일이 아님 (제목에 "이름표" 없음)';
  const dst = path.join(cfg.dataDir,'editor','editor.html');
  if(fs.existsSync(dst)) fs.copyFileSync(dst, dst.replace(/\.html$/, `.이전_${Date.now()}.html`));
  fs.copyFileSync(file, dst); return null;
}
function checkUpdateFolder(){            /* 데이터폴더/update/*.html 가 있으면 그걸로 교체 (딸깍 없이) */
  if(!cfg.dataDir) return null; const d=path.join(cfg.dataDir,'update'); let files=[]; try{ files=fs.readdirSync(d).filter(f=>/\.html$/i.test(f)) }catch(e){ return null }
  if(!files.length) return null; files.sort(); const f=path.join(d,files[files.length-1]);
  const err=applyUpdateFile(f); if(err) return null; fs.renameSync(f, f+'.적용됨'); return files[files.length-1];
}
function menu(){
  const t=[
    { label:'파일', submenu:[
      { label:'데이터 폴더 바꾸기…', click: async()=>{ if(await pickDataDir(win)){ win.webContents.send('nametag:data-dir', cfg.dataDir); win.reload() } } },
      { label:'데이터 폴더 열기', click:()=>{ if(cfg.dataDir) shell.openPath(cfg.dataDir) } },
      { type:'separator' }, { role:'reload', label:'새로고침' }, { role:'quit', label:'끝내기' } ] },
    { label:'업데이트', submenu:[
      { label:'편집기 파일 넣기 (MK 업데이트)…', click: async()=>{ const r=await dialog.showOpenDialog(win,{filters:[{name:'편집기 HTML',extensions:['html']}],properties:['openFile']}); if(r.canceled)return;
          const err=applyUpdateFile(r.filePaths[0]); if(err) dialog.showMessageBoxSync(win,{type:'error',message:err}); else { dialog.showMessageBoxSync(win,{message:'넣었다 · 새로고침한다'}); win.reload() } } },
      { label:'기본 편집기로 되돌리기', click:()=>{ if(!cfg.dataDir)return; const o=path.join(cfg.dataDir,'editor','editor.html'); if(fs.existsSync(o)){ fs.renameSync(o,o.replace(/\.html$/,`.꺼둠_${Date.now()}.html`)); win.reload() } } },
      { type:'separator' },
      { label:'새 버전 확인 (GitHub)', click:()=>updCheck(false) },
      { label:'업데이트 저장소 설정 파일 열기', click:()=>{ if(cfg.dataDir)shell.openPath(updRepoFile()) } },
      { type:'separator' },
      { label:'버전 정보', click:()=>{ const e=editorInfo(); dialog.showMessageBoxSync(win,{message:`이름표 v${APP_VER} (껍데기 MK${MK})`,detail:`편집기: ${e.mk||'?'}\n${e.override?'데이터 폴더의 업데이트 파일 사용':'설치된 기본 편집기'}\n\n데이터 폴더: ${cfg.dataDir||'(없음)'}\n편집기 파일: ${e.path}`}) } } ] },
    { label:'학습', submenu:[
      { label:'학습 모드 열기 (사진 넣고 놓침·잘못 표시 → 자료 쌓기)', click:()=>openTrainWindow() },
      { type:'separator' },
      { label:'1. 환경 설치 (Python · 처음 한 번 · 정밀 검수에도 필요)', click:()=>runBat('1_환경설치.bat') },
      { label:'2. 학습 시작 (내보낸 자료로 모델 다듬기)', click:()=>runBat('2_학습시작.bat') },
      { label:'3. 모델 넣기 (학습 결과 → models)', click:()=>runBat('3_모델넣기.bat') },
      { type:'separator' },
      { label:'학습 폴더 열기', click:()=>{ if(cfg.dataDir) shell.openPath(path.join(cfg.dataDir,'train')) } },
      { label:'설명 보기 (README)', click:()=>{ if(cfg.dataDir) shell.openPath(path.join(cfg.dataDir,'train','README.txt')) } },
      { type:'separator' },
      { label:'정밀 검수 서버 로그 열기', click:()=>{ if(cfg.dataDir){ const f=path.join(cfg.dataDir,'infer','server.log'); if(fs.existsSync(f))shell.openPath(f); else dialog.showMessageBoxSync(win,{message:'아직 로그 없음 (서버를 한 번도 안 켬)'}) } } },
      { label:'정밀 검수 서버 끄기', click:()=>pyStop() } ] },
    { label:'보기', submenu:[ { role:'toggleDevTools', label:'개발자 도구' }, { role:'resetZoom', label:'확대 원래대로' }, { role:'zoomIn', label:'확대' }, { role:'zoomOut', label:'축소' } ] }
  ]; Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}
const infoObj=()=>({ version:APP_VER, mk:MK, dataDir:cfg.dataDir||null, editor:editorInfo(), platform:process.platform });
ipcMain.handle('nametag:info', ()=>infoObj());
ipcMain.on('nametag:info-sync', e=>{ e.returnValue=infoObj() });
ipcMain.handle('nametag:pick-data-dir', async()=>pickDataDir(win));
ipcMain.handle('nametag:pick-dir', async(e,id)=>{ const key='last-'+(id||'dir'); const r=await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)||win,{properties:['openDirectory'],defaultPath:cfg[key]||undefined}); if(r.canceled||!r.filePaths[0])return null; cfg[key]=r.filePaths[0]; saveCfg(cfg); return r.filePaths[0] });
ipcMain.handle('nametag:pick-files', async(e,multi)=>{ const r=await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)||win,{properties:multi?['openFile','multiSelections']:['openFile']}); return r.canceled?[]:r.filePaths });
ipcMain.handle('nametag:py-start', async()=>pyStart());
ipcMain.handle('nametag:py-stop', async()=>pyStop());
ipcMain.handle('nametag:py-status', async()=>pyStatus());
ipcMain.handle('nametag:update-check', async(e,quiet)=>updCheck(!!quiet));
ipcMain.handle('nametag:update-state', async()=>({...updState,repo:updRepo()}));
ipcMain.handle('nametag:open-train', async()=>{ openTrainWindow(); return true });
ipcMain.handle('nametag:pick-save', async(e,name)=>{ const r=await dialog.showSaveDialog(win,{defaultPath:name||undefined}); return r.canceled?null:r.filePath });

app.whenReady().then(async()=>{
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb)=>cb(true));          /* 폴더 접근·클립보드 등 묻지 않음 */
  session.defaultSession.setPermissionCheckHandler(()=>true);
  if(!cfg.dataDir || !fs.existsSync(cfg.dataDir)){
    dialog.showMessageBoxSync({type:'info',message:'처음 켰다 · 데이터 폴더를 고르자',detail:'모델·보관함·백업·학습 자료가 들어갈 폴더다. 설치 폴더 밖, 넉넉한 드라이브(D: 등)에 새 폴더를 만들어 고르면 된다.\n업데이트해도 이 폴더는 안 건드린다.'});
    let d=null; while(!d){ d=await pickDataDir(null); if(!d && dialog.showMessageBoxSync({type:'question',buttons:['다시 고르기','끝내기'],message:'데이터 폴더가 있어야 시작할 수 있다'})===1){ app.quit(); return } }
  } else ensureData(cfg.dataDir);
  const up=checkUpdateFolder(); menu(); createWindow();
  if(up) win.webContents.once('did-finish-load',()=>dialog.showMessageBox(win,{message:`업데이트 파일 적용함: ${up}`}));
  if(app.isPackaged&&!process.env.NAMETAG_DATA) setTimeout(()=>updCheck(true),6000);          /* 저장소가 정해져 있으면 켤 때 조용히 확인 */
});
app.on('window-all-closed',()=>app.quit());
