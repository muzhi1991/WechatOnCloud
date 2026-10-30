"""Exercise the shipped script against fake local HTTP data, without WeChat writes."""
import http.server, threading, tempfile, pathlib, json, os, subprocess, unittest
SCRIPT=pathlib.Path(__file__).parents[1]/'scripts/wechat-read.py'
class TestCheckpoint(unittest.TestCase):
    def test_pending_batch_empty_and_receipt(self):
        messages=[{'local_id':1,'timestamp':1,'content':'baseline','sender':''}]
        status=['succeeded']
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length',0)))
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'username':'contact','is_group':False,'messages':messages}).encode())
            def do_GET(self):
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'status':status[0]}).encode())
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as d:
                p=pathlib.Path(d);(p/'token').write_text('test');url='http://127.0.0.1:'+str(server.server_port)
                (p/'config').write_text(json.dumps({'panelUrl':url,'tokenFile':str(p/'token')}))
                env={**os.environ,'WOC_CLIENT_CONFIG':str(p/'config'),'WOC_TRIGGER_STATE_DIR':d,'WOC_TRIGGER_URL':url,'WOC_TRIGGER_TOKEN_FILE':str(p/'token'),'WOC_RUN_ID':'run1','WOC_STEP_ID':'read'}
                def run(): return subprocess.run(['python3',str(SCRIPT),'--machine','test','--chat','contact'],input='{}',text=True,env=env,capture_output=True)
                self.assertEqual(run().stdout,'')
                messages.append({'local_id':2,'timestamp':2,'content':'new','sender':''})
                out=run();self.assertEqual(out.returncode,0,out.stderr);self.assertEqual(json.loads(out.stdout)['messages'][0]['content'],'new')
                for previous in ['unknown','failed','interrupted','canceled']:
                    status[0]=previous;out=run();self.assertNotEqual(out.returncode,0);self.assertEqual(out.stdout,'');self.assertIn('requires review',out.stderr)
                status[0]='succeeded';self.assertEqual(run().stdout,'')
                self.assertEqual(run().stdout,'')
                messages.append({'local_id':3,'timestamp':3,'content':'outgoing','sender':'me'})
                self.assertEqual(run().stdout,'')
        finally:server.shutdown();server.server_close()
if __name__=='__main__':unittest.main()
