'use strict';
// Deliberately finite CommonJS closure; native Obsidian supplies obsidian/Node externals.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const MODULES=['selection','live','session_client','session_launcher','main'];
const EXTERNALS=new Set(['obsidian','node:crypto','node:http','node:fs','node:path','node:child_process','node:net']);
function build(output){
 if(typeof output!=='string'||!output)throw new Error('explicit_output_directory_required');
 const target=path.resolve(output);
 if(target===path.resolve(__dirname))throw new Error('refuse_source_directory_output');
 const inventory={};
 const wrapped=MODULES.map(name=>{
  const raw=fs.readFileSync(path.join(__dirname,name+'.js'));
  const code=raw.toString('utf8');
  inventory[name+'.js']=crypto.createHash('sha256').update(raw).digest('hex');
  for(const match of code.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)){
   const id=match[2];
   if(!EXTERNALS.has(id)&&!MODULES.some(n=>id==='./'+n))throw new Error('unsupported_module:'+id);
  }
  return JSON.stringify('./'+name)+':function(module,exports,require){\n'+code+'\n}';
 });
 const bundle="'use strict';\nconst __externalRequire=require;\nconst __factories={\n"+wrapped.join(',\n')+"\n};\nconst __cache=Object.create(null);\nfunction __localRequire(id){if(!Object.prototype.hasOwnProperty.call(__factories,id)){if(id.startsWith('.'))throw new Error('unknown_local_module');return __externalRequire(id);}if(__cache[id])return __cache[id].exports;const m={exports:{}};__cache[id]=m;__factories[id](m,m.exports,__localRequire);return m.exports;}\nmodule.exports=__localRequire('./main');\n";
 // Compile before any write; no evaluation, process launch, runtime configuration or secrets.
 new (require('node:vm').Script)(bundle,{filename:'blog-entry-preview/main.js'});
 const manifest=fs.readFileSync(path.join(__dirname,'manifest.json'));
 fs.mkdirSync(target,{recursive:true});
 fs.writeFileSync(path.join(target,'main.js'),bundle);
 fs.writeFileSync(path.join(target,'manifest.json'),manifest);
 return {source_sha256:inventory,bundle_sha256:crypto.createHash('sha256').update(bundle).digest('hex')};
}
if(require.main===module){try{console.log(JSON.stringify(build(process.argv[2])));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={build};
