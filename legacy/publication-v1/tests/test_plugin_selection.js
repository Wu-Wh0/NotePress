const test=require('node:test');const assert=require('node:assert/strict');const {select}=require('../plugin/selection');
function app(path){return {vault:{adapter:{getBasePath:()=>'/synthetic'},read:async()=> '# 合成文章'},workspace:{getActiveFile:()=>({extension:'md',path}),getLeavesOfType:()=>[]}};}
test('Chinese nested selected path works without enumerating vault',async()=>{const x=await select(app('文章/学习/第一篇.md'),'/synthetic');assert.equal(x.path,'文章/学习/第一篇.md');assert.match(x.source_sha256,/^[a-f0-9]{64}$/);});
for(const path of ['../escape.md','文章/../escape.md','/abs.md','.private/x.md','文章//x.md','文章/秘密\\x.md'])test('reject unsafe '+path,async()=>{await assert.rejects(select(app(path),'/synthetic'),/unsupported_note_path/);});
for(const path of ['文章/note:stream.md','文章/\u0001danger.md','文章/\u007Fdanger.md','cafe\u0301.md'])test('reject unsafe selected path',async()=>{await assert.rejects(select(app(path),'/synthetic'),/unsupported_note_path/);});
