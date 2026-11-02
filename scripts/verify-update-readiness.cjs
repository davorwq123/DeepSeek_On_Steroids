// Production renderer in isolated Electron: DeepSeek readiness needs the browser, never a tunnel.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const root = path.resolve(__dirname, '..');
const built = path.join(root, 'out/renderer');
const output = path.join(root, 'outputs/update-readiness');
const version = require('../package.json').version;
fs.mkdirSync(path.join(output, 'runtime'), { recursive: true });
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const fixture = `${fixtureConfigSource()}
    const state={config:fixtureConfig({ui:{lastSeenVersion:'${version}',theme:'dark',tourDone:true}}),
      cosBrowserSignedIn:true,hasApiKey:false,hasGoalKey:false,
      status:{state:'disconnected',detail:'',surfaces:[]},bridge:{running:false,present:false,paired:false},
      update:{current:'${version}',latest:null,stage:'idle',checkedAt:1,error:null}};
    const ok=data=>Promise.resolve({ok:true,data});let listener=()=>{};
    window.fixtureState=state;window.mutations=[];
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:[],activeId:null,pressure:[]}),listInputs:()=>ok([]),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),
      getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]}),
      onStateChanged:fn=>{listener=fn;return()=>{}},
      connect:()=>{window.mutations.push('connect');return ok(state)},
      updateAll:()=>{window.mutations.push('update');return ok('checked')}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:()=>ok(null)});
    window.fixturePush=next=>listener(next);`;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/fixture.js') { response.setHeader('Content-Type','text/javascript'); response.end(fixture); return; }
    const file = path.resolve(built, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(built + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    const type = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)];
    if (type) response.setHeader('Content-Type',type);
    const bytes = fs.readFileSync(file);
    response.end(pathname === '/' ? bytes.toString().replace('</head>', '<script src="/fixture.js"></script></head>') : bytes);
  });
  let win;
  let code = 1;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    win = new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
    win.webContents.on('paint',()=>{});
    const js = script => win.webContents.executeJavaScript(script);
    const until = async condition => {
      const end = Date.now()+20000;
      while (!(await js(condition))) {
        if(Date.now()>end)throw new Error('Timed out: '+condition);
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    };
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await until(`!!document.querySelector('#tabs [data-tab="activity"]') && !!document.getElementById('updateReadinessSummary').dataset.ready`);
    await js(`document.querySelector('#tabs [data-tab="activity"]').click()`);
    await until(`document.getElementById('updateReadinessSummary').dataset.ready==='true'`);
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-update-part]'),e=>e.dataset.updatePart)`),['app','browser']);
    for(const signedIn of [null,false,true]) {
      await js(`window.fixturePush({...window.fixtureState,cosBrowserSignedIn:${JSON.stringify(signedIn)}})`);
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),String(signedIn===true));
    }
    await js(`window.fixturePush({...window.fixtureState,update:{...window.fixtureState.update,unavailable:true,checkedAt:null}})`);
    assert.equal(await js(`document.getElementById('updateAll').hidden`),true);
    assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'true');
    assert.deepEqual(await js('window.mutations'),[]);
    for (const lang of ['en','de','es','fr','ja','ko','pt-BR','pt-PT','ru','tr','vi','zh-CN','zh-TW']) {
      win.setContentSize(640,900);
      await js(`document.querySelector('[data-language="${lang}"]').click();document.getElementById('updateReadinessDetails').open=true`);
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await js(`document.getElementById('updateReadinessRows').scrollWidth<=document.getElementById('updateReadinessRows').clientWidth+1`),true,lang+' rows fit');
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-update-part]'),e=>e.dataset.updatePart)`),['app','browser']);
      fs.writeFileSync(path.join(output,lang+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    console.log('DeepSeek readiness: signed-in, signed-out, unknown, unavailable updates and 13 locales passed.');
    code=0;
  } catch(error) { console.error(error); }
  finally { win?.destroy(); if(server.listening)server.close(); app.exit(code); }
});
