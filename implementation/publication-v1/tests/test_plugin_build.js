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
  const context={module:{exports:{}},require:id=>{
   calls.push(id);
   if(id==='obsidian')return {Plugin:class{},ItemView:class{},Notice:class{}};
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
  const again=spawnSync(process.execPath,[build,dir],{encoding:'utf8'});
  assert.equal(again.status,0,again.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir,'main.js')),bytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')).id,'blog-entry-preview');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
