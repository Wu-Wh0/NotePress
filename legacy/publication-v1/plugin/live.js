const crypto=require('node:crypto');
const {validateSelectedFile}=require('./selection');
async function capture(app,expectedVault,{requireEditor=false,selected}={}){
 if(app.vault.adapter.getBasePath().replaceAll('\\','/').toLowerCase()!==expectedVault.replaceAll('\\','/').toLowerCase())throw new Error('wrong_vault');
 const f=app.workspace.getActiveFile();if(!f)throw new Error('no_active_note');
 validateSelectedFile(f);if(selected!==undefined&&f.path!==selected)throw new Error('selected_path_mismatch');
 const views=(app.workspace.getLeavesOfType('markdown')||[]).map(l=>l.view).filter(v=>v.file?.path===f.path&&v.getMode?.()==='source'&&v.editor);
 const values=views.map(v=>v.editor.getValue());
 if(new Set(values).size>1)throw new Error('conflicting_editors');
 if(requireEditor&&!values.length)throw new Error('active_source_editor_required');
 const text=values.length?values[0]:await app.vault.read(f);
 if(Buffer.byteLength(text,'utf8')>10000)throw new Error('note_too_large');
 return {path:f.path,text,source_sha256:crypto.createHash('sha256').update(text,'utf8').digest('hex')};
}
function captureUnsaved(app,expectedVault,selected){return capture(app,expectedVault,{requireEditor:true,selected});}
function previewInputKey(selected){
 const approvals=selected.approved_assets||{};
 return JSON.stringify([selected.path,selected.source_sha256,selected.title??null,Object.keys(approvals).sort().map(path=>[path,approvals[path]?.sha256,approvals[path]?.mime])]);
}
class Coordinator{
 constructor({capture,send,emit,delay=400}){Object.assign(this,{capture,send,emit,delay});this.revision=0;this.stopped=false;this.running=false;this.pending=false;this.timer=null;}
 change({force=false}={}){if(this.stopped)return;if(force)this.lastSynced=null;this.revision++;this.pending=true;clearTimeout(this.timer);this.emit({state:'waiting',valid:false});this.timer=setTimeout(()=>{this.timer=null;this.run();},this.delay);}
 async run(){if(this.stopped||this.running||!this.pending)return;this.running=true;this.pending=false;const version=this.revision;
 let out;try{const selected=await this.capture();if(this.stopped||version!==this.revision)return;const key=previewInputKey(selected);const old=this.lastSynced;if(old&&!Object.keys(selected.approved_assets||{}).length&&old.key===key&&old.out.expires_at>Date.now()/1000){this.emit({state:'synced',valid:true,selected,out:old.out,reused:true});return;}this.emit({state:'generating',valid:false});out=await this.send(selected);if(this.stopped||version!==this.revision){out?.dispose?.();return;}const now=await this.capture();if(this.stopped||version!==this.revision){out?.dispose?.();return;}if(previewInputKey(now)!==key){out?.dispose?.();this.change();return;}this.lastSynced={selected,out,key};this.emit({state:'synced',valid:true,selected,out,reused:false});}
 catch(e){out?.dispose?.();if(!this.stopped&&version===this.revision)this.emit({state:'error',valid:false,code:e.message});}
 finally{this.running=false;if(!this.stopped&&this.pending&&!this.timer)this.run();}}
 stop(){this.stopped=true;this.revision++;clearTimeout(this.timer);this.pending=false;this.lastSynced?.out?.dispose?.();this.lastSynced=null;}
}
function validateLive(out,selected,origin){
 if(typeof out.html!=='string'||crypto.createHash('sha256').update(out.html,'utf8').digest('hex')!==out.preview_sha256||out.mode!=='live'||out.state!=='live'||out.publication_approval!==false||out.path!==selected.path||out.source_sha256!==selected.source_sha256)throw new Error('preview_integrity_invalid');
 let url;try{url=new URL(out.preview_url);}catch{throw new Error('preview_integrity_invalid');}
 if(url.origin!==origin||url.username||url.password)throw new Error('preview_integrity_invalid');return out;
}
module.exports={capture,captureUnsaved,Coordinator,validateLive};
