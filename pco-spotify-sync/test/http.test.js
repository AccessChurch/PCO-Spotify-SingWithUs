import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
test('HTTP authentication, CSRF and OAuth state cookie', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pco-http-'));
  const port=23000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`;
  const password='test-password-at-least-24-characters';
  const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port),BASE_URL:base,ADMIN_PASSWORD:password,PCO_APP_ID:'test',PCO_SECRET:'test',SPOTIFY_CLIENT_ID:'test',SPOTIFY_CLIENT_SECRET:'test',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error(`Server exited: ${stderr}`);}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Startup timeout')),5000);t.unref();})]);
    assert.equal((await fetch(`${base}/health`)).status,200);
    assert.equal((await fetch(base)).status,401);
    const headers={Authorization:`Basic ${Buffer.from(`admin:${password}`).toString('base64')}`};
    const response=await fetch(`${base}/api/status`,{headers});const status=await response.json();
    assert.equal(status.enabled,false);assert.match(status.schedule,/last Wednesday/);assert.equal(status.tokens,undefined);
    assert.equal((await fetch(`${base}/api/enable`,{method:'POST',headers,body:'{"enabled":true}'})).status,403);
    headers.Origin=base;headers['X-CSRF-Token']=status.csrf;headers['Content-Type']='application/json';
    const oauth=await fetch(`${base}/api/connect`,{method:'POST',headers,body:'{}'});const location=await oauth.json();
    assert.match(location.url,/accounts.spotify.com\/authorize/);assert.match(oauth.headers.get('set-cookie'),/HttpOnly/);
    assert.equal((await fetch(`${base}/oauth/callback?state=wrong&code=fake`,{headers})).status,400);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child,'exit'); child.kill('SIGKILL'); await exited; } rmSync(dir,{recursive:true,force:true}); }
});
