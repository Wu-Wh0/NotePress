'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');

test('single-file plugin loads through an Obsidian-shaped external require without relative modules',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publication-native-build-'));
 try{
  const build=path.resolve(__dirname,'../plugin/build.cjs');
  const r=spawnSync(process.execPath,[build,dir],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const bytes=fs.readFileSync(path.join(dir,'main.js'));
  const calls=[];
  const notices=[];
  class FakeNotice {constructor(message){this.message=message;this.hidden=false;notices.push(this);}setMessage(message){this.message=message;}hide(){this.hidden=true;}}
  const context={module:{exports:{}},require:id=>{
   calls.push(id);
   if(id==='obsidian')return {Plugin:class{},ItemView:class{},Notice:FakeNotice};
   if(id.startsWith('.'))throw new Error('native_relative_module_unavailable');
   return require(id);
  },process,Buffer,URL,AbortController,console,setTimeout,clearTimeout};
  vm.runInNewContext(bytes.toString('utf8'),context,{filename:'native-plugin-main.js'});
  assert.equal(typeof context.module.exports,'function');
  assert.equal(typeof context.module.exports.prototype.startLocalSession,'function');
  assert.ok(calls.includes('obsidian'));
  assert.ok(calls.every(id=>!id.startsWith('.')));
  const plugin=new context.module.exports();
  const states=[];
  plugin.writingView={clearSessionPreview(){},update(event){states.push(event.state);}};
  plugin.setPublicationSession(null);
  assert.equal(states.at(-1),'disconnected');
  plugin.notifyLiveState({state:'waiting'});
  plugin.notifyLiveState({state:'generating'});
  plugin.notifyLiveState({state:'synced'});
  assert.equal(notices.length,1,'one native notice reused across transitions');
  assert.equal(notices[0].message,'预览已更新');
  plugin.clearLiveNotice();
  assert.equal(notices[0].hidden,true);
  const again=spawnSync(process.execPath,[build,dir],{encoding:'utf8'});
  assert.equal(again.status,0,again.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir,'main.js')),bytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')).id,'blog-entry-preview');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('builder refuses source junctions and linked existing output files without source writes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publication-build-path-'));
 try{
  const source=path.join(dir,'source');
  fs.cpSync(path.resolve(__dirname,'../plugin'),source,{recursive:true});
  const before=fs.readFileSync(path.join(source,'main.js'));
  const alias=path.join(dir,'source-alias');
  fs.symlinkSync(source,alias,process.platform==='win32'?'junction':'dir');
  let r=spawnSync(process.execPath,[path.join(source,'build.cjs'),alias],{encoding:'utf8'});
  assert.notEqual(r.status,0,'source alias must be rejected');
  assert.match(r.stderr,/refuse_source_directory_output/);
  assert.deepEqual(fs.readFileSync(path.join(source,'main.js')),before);
  const target=path.join(dir,'output');fs.mkdirSync(target);
  fs.linkSync(path.join(source,'main.js'),path.join(target,'main.js'));
  r=spawnSync(process.execPath,[path.join(source,'build.cjs'),target],{encoding:'utf8'});
  assert.notEqual(r.status,0,'linked output must be rejected');
  assert.match(r.stderr,/unsafe_existing_output_file/);
  assert.deepEqual(fs.readFileSync(path.join(source,'main.js')),before);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
