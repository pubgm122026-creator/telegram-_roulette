import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import api from './api.mjs';

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const chunks=[];
      for await (const chunk of req) chunks.push(chunk);
      const body=Buffer.concat(chunks).toString('utf8');
      const request = new Request(`http://localhost${url.pathname}${url.search}`, {
        method:req.method,
        headers:{'content-type':req.headers['content-type'] || 'application/json'},
        ...(req.method==='GET'||req.method==='HEAD'?{}:{body:body || '{}'})
      });
      const response=await api(request);
      res.writeHead(response.status,Object.fromEntries(response.headers.entries()));
      res.end(await response.text());
      return;
    }
    let requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(ROOT, '.' + requested);
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT,'index.html')) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const data=await fs.readFile(file);
    res.writeHead(200, {'Content-Type':MIME[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  } catch (e) {
    res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
    res.end('Not found');
  }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Elite Force running on ${PORT}`));
