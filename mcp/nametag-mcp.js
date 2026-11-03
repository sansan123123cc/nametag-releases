#!/usr/bin/env node
/* 이름표 MCP 서버 (MK8) — 클로드 데스크톱이 stdio 로 띄우고, 명령은 켜져 있는 이름표 앱(127.0.0.1:17866)에 전달한다.
   실행: 이름표.exe 로 (ELECTRON_RUN_AS_NODE=1) 또는 node. 앱이 꺼져 있으면 같은 exe 로 앱을 켠다. 의존 모듈 없음. */
'use strict';
const http = require('http'); const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs');
const PORT = +(process.env.NAMETAG_PORT || 17866);
const APP_EXE = process.env.NAMETAG_APP || (process.env.ELECTRON_RUN_AS_NODE ? process.execPath : null);

function httpJson(method, p, body, timeoutMs) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, timeout: timeoutMs || 5000 }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(new Error('응답이 JSON 이 아님: ' + b.slice(0, 200))) } }) });
    req.on('error', rej); req.on('timeout', () => { req.destroy(new Error('시간 초과')) }); if (data) req.write(data); req.end();
  });
}
async function health() { try { return await httpJson('GET', '/health', null, 2000) } catch (e) { return null } }
async function ensureApp() {
  let h = await health(); if (h && h.ok && h.window) return h;
  if (!APP_EXE || !fs.existsSync(APP_EXE)) throw new Error('이름표 앱이 꺼져 있고 자동으로 켤 수 없다 · 앱을 켜고 다시');
  try { const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; spawn(APP_EXE, [], { detached: true, stdio: 'ignore', env, windowsHide: false }).unref() } catch (e) { throw new Error('앱을 못 켰다: ' + e.message) }
  const t0 = Date.now(); while (Date.now() - t0 < 60000) { await new Promise(r => setTimeout(r, 1000)); h = await health(); if (h && h.ok && h.window) { await new Promise(r => setTimeout(r, 2500)); return h } }
  throw new Error('앱을 켰지만 60초 안에 응답이 없다 (데이터 폴더 고르기 창이 떠 있나?)');
}
async function call(cmd, args, timeoutMs) {
  await ensureApp();
  const r = await httpJson('POST', '/call', { cmd, args, timeoutMs }, (timeoutMs || 600000) + 5000);
  if (!r || !r.ok) throw new Error((r && r.error) || '실패');
  return r.result;
}

const TOOLS = [
  { name: 'nametag_status', description: '이름표 앱 상태: 버전, 데이터 폴더, 열린 폴더, 사진 수(바뀔 것·NSFW·칠함·놓침 의심), 정밀 검수 서버 상태. 다른 도구 전에 먼저 부른다. 앱이 꺼져 있으면 켠다.', inputSchema: { type: 'object', properties: {} } },
  { name: 'nametag_open_folder', description: '폴더를 이름표에 연다 (기존 목록은 비움, add:true 면 추가). subfolders 에 하위폴더 상대경로 목록을 주면 그 하위폴더만 넣는다 (예: ["nsfw"]). 안 주면 전부.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '절대 경로 (예: E:\\\\자동생성\\\\작품\\\\캐릭터)' }, subfolders: { type: 'array', items: { type: 'string' }, description: '넣을 하위폴더 상대경로들 · 없으면 전부' }, add: { type: 'boolean', description: '기존 목록에 추가' } }, required: ['path'] } },
  { name: 'nametag_list', description: '열린 사진 목록. filter: all|pending(이름 바뀔 것)|nsfw|sfw|painted(칠함)|nobox(찾았는데 0개)|missing(프롬프트엔 있는 부위를 못 찾음)|unchecked(아직 안 찾음)|selected. 각 항목: path, 지금 이름, 바뀔 이름, 칸(f1 감정 f2 장소 f3 의상 f4 행동), nsfw, 찾은 부위 박스, 놓침 의심.', inputSchema: { type: 'object', properties: { filter: { type: 'string' }, query: { type: 'string', description: '이름·폴더에 포함된 글자' }, paths: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } } } },
  { name: 'nametag_detect', description: '영역 찾기(검열 탐지)를 돌린다. paths 없으면 열린 전부. precise:true 면 파이썬 정밀 검수(GPU · 1280 · TTA), paint 는 찾은 자리를 임시로 칠할지 (off|fill|mosaic|blur · fill=흰색). 결과: 찾은 수, 못 찾은 사진, 프롬프트상 놓침 의심 목록. 칠은 "임시"라 nametag_apply 전엔 파일이 안 바뀐다.', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, precise: { type: 'boolean' }, paint: { type: 'string', enum: ['off', 'fill', 'mosaic', 'blur'] } } } },
  { name: 'nametag_set_names', description: '이름 칸을 적어둔다 (파일은 아직 안 바뀜). changes: [{path, f1?, f2?, f3?, f4?, nsfw?}] · 칸 값 ""/null 이면 그 칸을 뺀다 · nsfw:true 면 _NSFW 만 붙이고 칸은 그대로. 결과에 바뀔 이름 미리보기.', inputSchema: { type: 'object', properties: { changes: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, f1: { type: 'string' }, f2: { type: 'string' }, f3: { type: 'string' }, f4: { type: 'string' }, nsfw: { type: 'boolean' } }, required: ['path'] } } }, required: ['changes'] } },
  { name: 'nametag_apply', description: '적어둔 이름·임시 칠·nsfw 이동을 실제 파일에 반영한다 (되돌리기 가능하지만 파일이 바뀌는 작업). 반드시 먼저 nametag_list 로 바뀔 내용을 사용자에게 보여주고 확인받은 뒤 confirm:true 로.', inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' }, includeSuspicious: { type: 'boolean', description: '놓침 의심(프롬프트엔 있는 부위를 못 찾은) 사진까지 그대로 반영 · 기본 false = 그런 사진은 빼고 remaining 으로 돌려줌' } }, required: ['confirm'] } },
  { name: 'nametag_undo', description: '마지막 nametag_apply 를 되돌린다 (이름·이동·칠 원본 복구).', inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } },
  { name: 'nametag_convert_webp', description: 'mp4·mov 를 움직이는 webp 로 (같은 폴더에 저장). maxW 0=원본, fps 0=원본, quality 50~95.', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, maxW: { type: 'number' }, fps: { type: 'number' }, quality: { type: 'number' }, overwrite: { type: 'boolean' } }, required: ['paths'] } },
  { name: 'nametag_precise_server', description: '파이썬 정밀 검수 서버 start|stop|status (GPU 이름·모델 목록).', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop', 'status'] } }, required: ['action'] } },
  { name: 'nametag_train_stats', description: '학습 모드로 쌓인 정답 사진 수.', inputSchema: { type: 'object', properties: {} } },
];
const MAP = { nametag_status: 'status', nametag_open_folder: 'open_folder', nametag_list: 'list', nametag_detect: 'detect', nametag_set_names: 'set_names', nametag_apply: 'apply', nametag_undo: 'undo', nametag_convert_webp: 'convert_webp', nametag_precise_server: 'precise_server', nametag_train_stats: 'train_stats' };

/* ---- JSON-RPC over stdio (줄 단위) ---- */
let buf = '';
const send = o => { process.stdout.write(JSON.stringify(o) + '\n') };
async function handle(m) {
  const id = m.id; const reply = result => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }) };
  const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }) };
  try {
    switch (m.method) {
      case 'initialize': return reply({ protocolVersion: m.params && m.params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'nametag', version: '1.0.0' } });
      case 'notifications/initialized': case 'notifications/cancelled': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params && m.params.name, args = (m.params && m.params.arguments) || {}; const cmd = MAP[name];
        if (!cmd) return reply({ content: [{ type: 'text', text: '모르는 도구: ' + name }], isError: true });
        try { const r = await call(cmd, args, 600000); return reply({ content: [{ type: 'text', text: JSON.stringify(r, null, 1) }] }) }
        catch (e) { return reply({ content: [{ type: 'text', text: '실패: ' + (e.message || e) }], isError: true }) }
      }
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default: return fail(-32601, 'method not found: ' + m.method);
    }
  } catch (e) { fail(-32000, String(e.message || e)) }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch (e) { continue } handle(m) } });
process.stdin.on('end', () => process.exit(0));
