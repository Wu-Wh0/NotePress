"""Real plugin child → bridge → fresh WordPress-WASM focused acceptance."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
FIXTURE = TESTS / "fixtures" / "isolated-publication-launcher.py"
PLUGIN = ROOT / "plugin" / "main.js"
sys.path[:0] = [str(TESTS), str(ROOT / "producer")]
from runtime_paths import node_binary, parser_root, php_wasm_modules, wordpress_core  # noqa: E402

NODE, PARSER = node_binary(), parser_root()
MODULES, WP_CORE = php_wasm_modules(), wordpress_core()
WORKER, SERVER = TESTS / "fixtures" / "wp-session-worker.mjs", ROOT / "server"
SELECTED = "notes/synthetic-isolated.md"
SOURCE = "# Isolated plugin source\n\nSynthetic only; prepare must remain pending.\n"
SITE_PIN = "https://publication-v1.example.test"


def verify_pinned_runtime():
    for package in ("@php-wasm/node-8-3", "@php-wasm/universal", "@wp-playground/wordpress", "@wp-playground/cli"):
        metadata = MODULES / package / "package.json"
        if metadata.is_symlink() or not metadata.is_file() or json.loads(metadata.read_text(encoding="utf-8")).get("version") != "3.1.56":
            raise AssertionError(f"pinned PHP-WASM package missing or changed: {package}")
    zip_path = MODULES / "@wp-playground/cli/sqlite-database-integration.zip"
    if zip_path.is_symlink() or not zip_path.is_file() or not (WP_CORE / "wp-includes/version.php").is_file():
        raise AssertionError("pinned SQLite integration or WordPress core missing")


NODE_DRIVER = r'''const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),net=require('node:net'),Module=require('node:module');
const oldLoad=Module._load; Module._load=function(r,p,m){if(r==='obsidian')return {Plugin:class{},Notice:class{},Modal:class{},ItemView:class{constructor(l){this.leaf=l;this.app=l.app;this.contentEl=new El('div');this.containerEl=new El('div')}}};return oldLoad.call(this,r,p,m)};
class El{constructor(tag){this.tagName=tag;this.ownerDocument={defaultView:win};this.children=[];this.style={};this.hidden=false;this.src='';this.srcdoc='';this.textContent=''}empty(){this.children=[]}createEl(t,o={}){const e=new El(t);e.textContent=o.text||'';this.children.push(e);return e}setAttribute(){}removeAttribute(n){if(n==='src')this.src='';if(n==='srcdoc')this.srcdoc=''}addEventListener(){}querySelector(){return null}}
const made=[],revoked=[],win={Blob:class{constructor(parts,o){this.parts=parts;this.type=o?.type||''}},URL:{createObjectURL(){const x='blob:isolated/'+(made.length+1);made.push(x);return x},revokeObjectURL(x){revoked.push(x)}}};
const oldRequest=http.request,requests=[];let plugin;http.request=function(input,opts,cb){const u=new URL(input),r={method:opts?.method||'GET',path:u.pathname,authorized:opts?.headers?.Authorization===plugin?.publicationSession?.authorization};const q=oldRequest.call(http,input,opts,cb);q.once('finish',()=>requests.push(r));return q};
function portClosed(origin){const u=new URL(origin);return new Promise(done=>{const s=net.createConnection({host:u.hostname,port:+u.port});s.once('connect',()=>{s.destroy();done(false)});s.once('error',e=>done(e.code==='ECONNREFUSED'))})}
(async()=>{const [pluginPath,launcher,python,configB64,vault,selected,source,node,parser,scratch,evidence]=process.argv.slice(1),cmds=new Map(),factories=new Map(),leaves=[],file={extension:'md',path:selected};
const app={plugins:{getPlugin:()=>plugin},vault:{adapter:{getBasePath:()=>vault},read:async chosen=>{assert.equal(chosen.path,selected,'only the selected synthetic disk source may be read');return fs.readFileSync(vault+'/'+selected,'utf8')},getMarkdownFiles(){throw Error('vault_enumeration_forbidden')},on(){return{}}},workspace:{getActiveFile:()=>file,getLeavesOfType:t=>t==='markdown'?[{view:{file,getMode:()=> 'source',editor:{getValue:()=>source}}}]:leaves.filter(x=>x.type===t),getLeaf(){const l={app,view:null,type:null,async setViewState(s){this.type=s.type;this.view=factories.get(s.type)(this);await this.view.onOpen()}};leaves.push(l);return l},async revealLeaf(){},on(){return{}},detachLeavesOfType(t){for(const l of leaves.filter(x=>x.type===t)){try{l.view.onClose()}catch{}}}}};
plugin=new(require(pluginPath))();const config={expectedVault:vault,bridgeLaunch:{command:python,args:[launcher,configB64],mode:'isolated-publication-test',env:{PUBLICATION_NODE:node,PUBLICATION_PARSER_ROOT:parser,TMPDIR:scratch}}};Object.assign(plugin,{app,config,loadData:async()=>config,registerView:(t,f)=>factories.set(t,f),addRibbonIcon(){},registerEvent(){},addCommand:x=>cmds.set(x.id,x)});await plugin.onload();
const started=await cmds.get('current-note-live-preview').callback();assert.equal(started.ok,true,JSON.stringify(started));const session=plugin.publicationSession;assert.equal(session.workflowConnected,true);assert.equal(session.sitePin,'https://publication-v1.example.test');plugin.live.stop();
const prepared=await plugin.generate();assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.equal(prepared.state,'pending');assert.equal(prepared.publication_approval,false);const leaf=plugin.app.workspace.getLeavesOfType('blog-entry-final-preview')[0];assert.ok(leaf.view.frame.srcdoc.includes('Isolated plugin source'));assert.ok(leaf.view.frame.srcdoc.includes('Content-Security-Policy'));
const status=await plugin.checkReceipt();assert.equal(status.ok,true,JSON.stringify(status));assert.equal(status.state,'pending');assert.equal(status.operation_id,prepared.operation_id);const recovered=await plugin.recoverFinalPreview();assert.equal(recovered.ok,true,JSON.stringify(recovered));assert.equal(recovered.operation_id,prepared.operation_id);assert.ok(requests.every(r=>r.authorized));assert.ok(!requests.some(r=>/\/(approve|commit)(\/|$)/.test(r.path)));
const origin=session.origin,child=plugin.sessionChild,close=plugin.sessionChildClose;await plugin.onunload();await close;const bridgeClosed=await portClosed(origin),report=JSON.parse(fs.readFileSync(evidence,'utf8'));process.stdout.write(JSON.stringify({started:started.ok,workflowConnected:session.workflowConnected,sitePin:session.sitePin,preparedState:prepared.state,operationId:prepared.operation_id,statusState:status.state,recoveredId:recovered.operation_id,requests:requests.map(x=>({method:x.method,path:x.path})),requestsAuthorized:requests.every(x=>x.authorized),noApprovalOrCommit:!requests.some(x=>/\/(approve|commit)(\/|$)/.test(x.path)),pluginChildExitCode:child.exitCode,bridgeClosed,workerEvidence:report}));
})().catch(async e=>{process.stderr.write(`${e.name}: ${e.message}`);try{await plugin?.onunload?.();}catch{}process.exitCode=3});
'''


class IsolatedPublicationLaunchTest(unittest.TestCase):
    def test_invalid_preflight_cannot_overwrite_unvalidated_evidence_path(self):
        with tempfile.TemporaryDirectory(prefix="isolated-rejected-preflight-", dir=os.environ["TMPDIR"]) as temporary:
            target = Path(temporary) / "must-not-be-overwritten.txt"
            target.write_text("original bytes", encoding="utf-8")
            encoded = base64.b64encode(json.dumps({"evidencePath": str(target)}).encode()).decode()
            result = subprocess.run([sys.executable, "-B", str(FIXTURE), encoded], input="", capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertEqual(target.read_text(encoding="utf-8"), "original bytes")

    def test_real_plugin_child_private_handshake_prepare_status_and_fresh_wp_cleanup(self):
        verify_pinned_runtime()
        self.assertTrue(NODE.is_file())
        self.assertTrue((SERVER / "publication-v1.php").is_file())
        scratch = Path(os.environ["TMPDIR"]).resolve(strict=True)
        evidence_dir = Path(os.environ.get("PUBLICATION_ISOLATED_EVIDENCE_DIR", str(scratch / "publication-v1-isolated-launch-output")))
        evidence_dir.mkdir(parents=True, exist_ok=True)
        target = evidence_dir / "focused-run.json"
        target.write_text(json.dumps({"verdict": "NOT_ACCEPTED", "stage": "running"}) + "\n", encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix="plugin-isolated-publication-", dir=scratch) as temporary:
            root = Path(temporary)
            vault = root / "synthetic-vault"
            note = vault / SELECTED
            note.parent.mkdir(parents=True)
            note.write_text(SOURCE, encoding="utf-8")
            report_path = root / "worker-readback.json"
            from package_builder import COMPILER_FILES, _sha, _toolchain
            compiler = {"files": {name: _sha((ROOT / "producer" / name).read_bytes()) for name in COMPILER_FILES}, "toolchain": _toolchain()}
            compiler_sha = hashlib.sha256(json.dumps(compiler, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            runtime = {"modules": str(MODULES), "wpCore": str(WP_CORE), "sqliteZip": str(MODULES / "@wp-playground/cli/sqlite-database-integration.zip"),
                       "serverPath": str(SERVER), "runId": uuid.uuid4().hex, "compilerSha256": compiler_sha, "evidencePath": str(report_path)}
            encoded = base64.b64encode(json.dumps(runtime, separators=(",", ":")).encode()).decode()
            env = dict(os.environ)
            env.update({"PYTHONDONTWRITEBYTECODE": "1", "PUBLICATION_NODE": str(NODE), "PUBLICATION_PARSER_ROOT": str(PARSER), "TMPDIR": str(scratch)})
            cmd = [str(NODE), "-e", NODE_DRIVER, str(PLUGIN), str(FIXTURE), sys.executable, encoded, str(vault), SELECTED, SOURCE, str(NODE), str(PARSER), str(scratch), str(report_path)]
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
            try:
                stdout, stderr = process.communicate(timeout=210)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.communicate(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate(timeout=15)
                self.fail("owned isolated integration process group timed out; acceptance remains rejected")
            result = subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)
            if result.returncode != 0 and report_path.is_file():
                (evidence_dir / "focused-failure.json").write_text(report_path.read_text(encoding="utf-8"), encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertNotIn("Bearer ", result.stdout + result.stderr)
            outcome = json.loads(result.stdout)
            self.assertEqual(outcome["preparedState"], "pending", outcome)
            self.assertEqual(outcome["sitePin"], SITE_PIN)
            self.assertEqual(outcome["statusState"], "pending")
            self.assertEqual(outcome["recoveredId"], outcome["operationId"])
            self.assertTrue(outcome["requestsAuthorized"] and outcome["noApprovalOrCommit"] and outcome["bridgeClosed"], outcome)
            self.assertEqual(outcome["pluginChildExitCode"], 0)
            worker = outcome["workerEvidence"]
            self.assertIsNone(worker["failure_class"], worker)
            self.assertTrue(worker["stdin_eof"] and worker["bridge_port_closed"] and worker["wp_port_closed"], worker)
            self.assertEqual(worker["post_counts_before"], worker["post_counts_after"], worker)
            self.assertIsInstance(worker["post_counts_before"]["post_count"], int)
            self.assertEqual(worker["worker_exit_code"], 0, worker)
            accepted = {"verdict": "ACCEPTED_ISOLATED_HOST_STUB", "command": "focused plugin/WordPress isolated integration", "exit_code": result.returncode, "result": outcome}
            target.write_text(json.dumps(accepted, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print("ISOLATED_PUBLICATION_LAUNCH_EVIDENCE=" + json.dumps(accepted, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    unittest.main()
