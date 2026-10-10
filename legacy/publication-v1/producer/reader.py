"""Finite selected Markdown preview. Linux file boundary; no Vault enumeration."""
import hashlib,html,json,os,re,stat,unicodedata
from pathlib import Path
POLICY_VERSION='selected-note-v1'
MAX_BYTES=65536

def digest(value):return hashlib.sha256(value).hexdigest()
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')
def read_selected(vault,selected):
 if not isinstance(selected,str) or not selected or any(c in selected for c in ('\\',':','\0')):raise ValueError('invalid_selected_path')
 names=selected.split('/')
 if any(n in ('','.', '..') or n.startswith('.') for n in names) or not selected.endswith('.md'):raise ValueError('invalid_selected_path')
 root=Path(vault)
 if root.is_symlink() or not root.is_dir():raise ValueError('invalid_vault')
 fds=[]
 try:
  fds.append(os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW))
  for n in names[:-1]:fds.append(os.open(n,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fds[-1]))
  fds.append(os.open(names[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fds[-1]));info=os.fstat(fds[-1])
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>MAX_BYTES:raise ValueError('unsupported_source_file')
  chunks=[];total=0
  while total<=MAX_BYTES:
   b=os.read(fds[-1],min(8192,MAX_BYTES+1-total))
   if not b:break
   chunks.append(b);total+=len(b)
  if total>MAX_BYTES:raise ValueError('source_too_large')
  return b''.join(chunks)
 except OSError as e:raise ValueError('selected_file_unavailable_or_unsafe') from e
 finally:
  for fd in reversed(fds):os.close(fd)

def render(text,labels):
 if not isinstance(labels,dict) or any(not isinstance(k,str) or not isinstance(v,str) or not v.strip() or len(v)>200 or any(unicodedata.category(c).startswith('C') for c in v) for k,v in labels.items()):raise ValueError('invalid_label_approval')
 if any(unicodedata.category(c).startswith('C') and c not in '\n\r\t' for c in text):raise ValueError('unsupported_control_character')
 text=text.replace('\r\n','\n')
 if '\r' in text or text.startswith('\ufeff'):raise ValueError('unsupported_encoding_marker')
 parts=[];conversions=[];used=set();paragraph=[];code=None
 def inline(s):
  out=[];last=0
  for m in re.finditer(r'\[\[([^\[\]\n]+)\]\]',s):
   plain=s[last:m.start()]
   if m.start()>0 and s[m.start()-1]=='!':raise ValueError('unsupported_embed')
   if m.group(1) not in labels:raise ValueError('unapproved_wikilink')
   check_plain(plain);out.append(html.escape(plain));out.append(html.escape(labels[m.group(1)]));used.add(m.group(1));conversions.append({'kind':'wikilink-to-text','display':labels[m.group(1)]});last=m.end()
  check_plain(s[last:]);out.append(html.escape(s[last:]));return ''.join(out)
 def check_plain(s):
  if re.search(r'[<>\[\]*_`$\\|{}~!^]',s) or '%%' in s or re.search(r'https?://|obsidian://',s,re.I):raise ValueError('unsupported_inline_syntax')
 def flush():
  if paragraph:parts.append('<p>'+inline(' '.join(paragraph))+'</p>');paragraph.clear()
 for line in text.split('\n'):
  if code is not None:
   if line=='```':parts.append('<pre><code>'+html.escape('\n'.join(code))+'</code></pre>');code=None
   else:code.append(line)
   continue
  if line.startswith('```'):
   flush()
   if line not in ('```','```text'):raise ValueError('unsupported_code_language')
   code=[];continue
  if not line.strip():flush();continue
  if line.startswith(('---','+++','>','- ','+ ','* ','    ','\t')) or re.match(r'\d+[.)] ',line) or re.fullmatch(r'[=-]{2,}',line.strip()) or line.strip() in ('***','___'):raise ValueError('unsupported_block_syntax')
  heading=re.fullmatch(r'(#{1,6}) (.+)',line)
  if heading:
   flush();level=len(heading[1]);parts.append(f'<h{level}>'+inline(heading[2])+f'</h{level}>')
  elif line.startswith('#'):raise ValueError('unsupported_heading')
  else:paragraph.append(line)
 if code is not None:raise ValueError('unclosed_code_fence')
 flush()
 if set(labels)!=used:raise ValueError('unused_label_approval')
 if not parts:raise ValueError('empty_selected_note')
 return '\n'.join(parts),conversions

def freeze(vault,selected,approved_labels):
 raw=read_selected(vault,selected)
 try:text=raw.decode('utf-8')
 except UnicodeDecodeError as e:raise ValueError('source_not_utf8') from e
 body,changes=render(text,approved_labels)
 snap={'selected':selected,'source_sha256':digest(raw),'labels_sha256':digest(canonical(approved_labels)),'policy_version':POLICY_VERSION,'adapter_sha256':digest(Path(__file__).read_bytes()),'html_sha256':digest(body.encode()),'conversions':changes}
 return {'html':body,'snapshot':snap,'digest':digest(canonical(snap))}

def read_selected_asset(vault, selected, relative):
 """Read one explicitly approved PNG next to the selected Markdown file."""
 if not isinstance(selected,str) or not selected or any(c in selected for c in ('\\\\',':','\\0')):
  raise ValueError('invalid_selected_path')
 note_parts=selected.split('/')
 if any(n in ('','.', '..') or n.startswith('.') for n in note_parts) or not selected.endswith('.md'):
  raise ValueError('invalid_selected_path')
 if not isinstance(relative,str) or not relative or any(c in relative for c in ('\\\\',':','\\0','%','?','#')):
  raise ValueError('invalid_asset_path')
 asset_parts=relative.split('/')
 if any(n in ('','.', '..') or n.startswith('.') or any(ch.isspace() or unicodedata.category(ch).startswith('C') for ch in n) for n in asset_parts) or not relative.endswith('.png'):
  raise ValueError('invalid_asset_path')
 names=note_parts[:-1]+asset_parts
 root=Path(vault);fds=[]
 try:
  if root.is_symlink() or not root.is_dir():raise ValueError('invalid_vault')
  fds.append(os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW))
  for name in names[:-1]:fds.append(os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fds[-1]))
  fds.append(os.open(names[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fds[-1]))
  info=os.fstat(fds[-1])
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('unsupported_asset_file')
  if info.st_size>4*1024*1024:raise ValueError('asset_too_large')
  chunks=[];total=0
  while total<=4*1024*1024:
   data=os.read(fds[-1],min(8192,4*1024*1024+1-total))
   if not data:break
   chunks.append(data);total+=len(data)
  if total>4*1024*1024:raise ValueError('asset_too_large')
  return b''.join(chunks)
 except OSError as exc:
  raise ValueError('selected_asset_unavailable_or_unsafe') from exc
 finally:
  for fd in reversed(fds):os.close(fd)


def verify(vault,selected,approved_labels,frozen):
 try:
  if not isinstance(frozen,dict) or set(frozen)!={'html','snapshot','digest'}:return False
  if frozen['digest']!=digest(canonical(frozen['snapshot'])):return False
  if frozen['snapshot']['html_sha256']!=digest(frozen['html'].encode('utf-8')):return False
  return frozen==freeze(vault,selected,approved_labels)
 except (ValueError,TypeError,KeyError,AttributeError,OSError):return False
