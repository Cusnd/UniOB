const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8'};
const server = http.createServer((req,res) => {
  let route;
  try { route = decodeURIComponent(new URL(req.url,'http://localhost').pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }
  if(route === '/favicon.ico') {res.writeHead(204).end(); return;}
  if(route === '/cache') {res.writeHead(302,{Location:'/cache/'}).end();return;}
  if(route.startsWith('/cache/')) route = route.slice(6);
  const file = path.resolve(root, '.' + (route.endsWith('/') ? route + 'index.html' : route));
  const relative = path.relative(root,file);
  if(relative.startsWith('..') || path.isAbsolute(relative)) {res.writeHead(403).end('Forbidden');return;}
  fs.readFile(file,(err,data) => {
    if(err) {res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}).end('Not found');return;}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
  });
});
server.listen(Number(process.env.PORT || 5175),'127.0.0.1',() => console.log('UniOB cache preview: http://127.0.0.1:' + server.address().port + '/cache/'));
