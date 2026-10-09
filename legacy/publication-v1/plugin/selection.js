const crypto=require('node:crypto');
function validateSelectedFile(f){
 const safe=typeof f?.path==='string'&&f.path.endsWith('.md')&&!/[\\:\x00-\x1f\x7f]/.test(f.path)&&f.path.split('/').every(p=>p&&!p.startsWith('.')&&p===p.normalize('NFC'));
 if(f?.extension!=='md'||!safe)throw new Error('unsupported_note_path');
 return f.path;
}
async function select(app,expectedVault){
 if(app.vault.adapter.getBasePath().replaceAll('\\','/').toLowerCase()!==expectedVault.replaceAll('\\','/').toLowerCase())throw new Error('wrong_vault');
 const f=app.workspace.getActiveFile();if(!f)throw new Error('no_active_note');
 validateSelectedFile(f);
 const disk=await app.vault.read(f);if(Buffer.byteLength(disk,'utf8')>10000)throw new Error('note_too_large');
 const active=app.workspace.activeEditor;
 if(active?.file?.path===f.path&&active.editor&&active.editor.getValue()!==disk)throw new Error('unsaved_editor');
 for(const leaf of app.workspace.getLeavesOfType?.('markdown')||[]){const view=leaf.view;if(view.file?.path===f.path&&view.getMode?.()==='source'&&view.editor&&view.editor.getValue()!==disk)throw new Error('unsaved_editor');}
 return {path:f.path,source_sha256:crypto.createHash('sha256').update(disk,'utf8').digest('hex')};
}
module.exports={select,validateSelectedFile};
