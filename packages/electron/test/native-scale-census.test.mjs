import assert from 'node:assert/strict';import test from 'node:test';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const helper=await import(process.env.SURF_ACE_CENSUS_HELPER?pathToFileURL(process.env.SURF_ACE_CENSUS_HELPER).href:new URL('../scripts/native-scale-owned-process.mjs',import.meta.url));
const target='/private/tmp/private-sdk/Electron.app/Contents/MacOS/Electron';
const row=(pid,executable,command=executable)=>({pid,pgid:pid,executable,command});
test('wrapper argv and unrelated resident helpers do not identify private Electron',()=>{
 const rows=[row(83745,'/opt/homebrew/bin/node',`node wrapper.mjs --electron ${target}`),row(2261,'/Applications/LM Studio.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'),row(64141,'/Applications/Surf Ace.app/Contents/Frameworks/Surf Ace Helper (Renderer).app/Contents/MacOS/Surf Ace Helper (Renderer)',`helper --framework-dir=/Applications/Surf Ace.app/Contents/Frameworks/Electron Framework.framework --reference=${target}`),row(88271,'/Applications/Grok Bot.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler')];
 assert.deepEqual(helper.electronProcessCensus(target,rows),[]);
});
test('private Electron executable and private bundle helpers remain visible regardless of argv',()=>{
 const main=row(1,target,'renamed argv'),renderer=row(2,'/private/tmp/private-sdk/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)','worker'),crashpad=row(3,'/private/tmp/private-sdk/Electron.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler','crash handler'),neighbor=row(4,'/private/tmp/private-sdk/Electron.app/Contents-other/worker',target);
 assert.deepEqual(helper.electronProcessCensus(target,[main,renderer,crashpad,neighbor]),[main,renderer,crashpad]);
 assert.notDeepEqual(helper.electronProcessCensus(target,[main]).map(r=>r.pid),[],'genuine new private PID still invalidates empty admission');
});
test('missing or unresolved executable provenance refuses without argv fallback',()=>{
 assert.throws(()=>helper.electronProcessCensus(target,[{pid:1,command:target}]),/identity is missing/);assert.throws(()=>helper.electronProcessCensus(target,[row(1,'Electron')]),/identity is unresolved/);assert.throws(()=>helper.electronProcessCensus(target,null),/successful process census/);assert.throws(()=>helper.electronProcessCensus('Electron',[]),/absolute private Electron/);
});
function fakePs(stdout,{exit=0,hang=false}={}){const calls=[],signals=[];return{calls,signals,spawnProcess(command,args){calls.push({command,args});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=signal=>{signals.push(signal);queueMicrotask(()=>child.emit('close',null,signal))};if(!hang)queueMicrotask(()=>{child.stdout.write(stdout);child.stdout.end();child.emit('close',exit,null)});return child}}}
test('bounded executable census uses comm for baseline and final identity',async()=>{
 const ps=fakePs(`83745 83745 /opt/homebrew/bin/node\n1 1 ${target}\n2 1 /private/tmp/private-sdk/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper\n`);assert.deepEqual((await helper.electronExecutableCensus(target,{spawnProcess:ps.spawnProcess,timeoutMs:100})).map(r=>r.pid),[1,2]);assert.deepEqual(ps.calls,[{command:'ps',args:['-eo','pid=,pgid=,comm=']}]);assert.deepEqual(ps.signals,[]);
 const empty=fakePs('83745 83745 /opt/homebrew/bin/node\n');assert.deepEqual(await helper.electronExecutableCensus(target,{spawnProcess:empty.spawnProcess,timeoutMs:100}),[]);
});
test('unreadable duplicate failed and timed-out census remains an error',async()=>{
 for(const text of ['malformed identity\n',`1 1 ${target}\n1 2 ${target}\n`]){const ps=fakePs(text);await assert.rejects(helper.electronExecutableCensus(target,{spawnProcess:ps.spawnProcess,timeoutMs:100}),/unreadable|duplicate/)}
 const failed=fakePs('',{exit:1});await assert.rejects(helper.electronExecutableCensus(target,{spawnProcess:failed.spawnProcess,timeoutMs:100}),/ps exited 1/);
 const hung=fakePs('',{hang:true}),keepAlive=setTimeout(()=>{},100);try{await assert.rejects(helper.electronExecutableCensus(target,{spawnProcess:hung.spawnProcess,timeoutMs:10}),/exceeded/)}finally{clearTimeout(keepAlive)}assert.deepEqual(hung.signals,['SIGKILL'],'timeout signals only injected ps child');
});
test('owned-group census retains args and wrapper shares executable census',async()=>{
 const ps=fakePs('123 123 node --marker=owned-group\n');assert.deepEqual(await helper.processCensus({spawnProcess:ps.spawnProcess}),[{pid:123,pgid:123,command:'node --marker=owned-group'}]);assert.deepEqual(ps.calls[0].args,['-eo','pid=,pgid=,args=']);const source=await readFile(new URL('../scripts/run-browser-content-scale-native-private.mjs',import.meta.url),'utf8');assert.match(source,/await electronExecutableCensus\(electronPath, \{ timeoutMs: 1_500 \}\)/);assert.equal((source.match(/await currentElectronPids\(electronRealPath\)/g)||[]).length,2);
});
