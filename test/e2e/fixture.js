'use strict';

// Builds a realistic demo repository (synthetic people and history) with
// branches, merges, tags, a remote, a stash and uncommitted changes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PEOPLE = [
  ['Maya Okafor', 'maya@example.dev'],
  ['Lucas Brandt', 'lucas@example.dev'],
  ['Priya Raman', 'priya@example.dev'],
  ['Tomás Ferreira', 'tomas@example.dev'],
  ['Hana Kobayashi', 'hana@example.dev'],
];

function makeFixture(baseDir, { name = 'harbor-api', withWip = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(baseDir || os.tmpdir(), 'gitdonkey-fixture-')));
  const repo = path.join(root, name);
  const bare = path.join(root, `${name}-origin.git`);
  fs.mkdirSync(repo);
  let clock = Date.now() - 1000 * 60 * 60 * 24 * 40;
  let who = 0;

  const env = () => {
    const [n, e] = PEOPLE[who % PEOPLE.length];
    const date = new Date(clock).toISOString();
    return {
      ...process.env,
      GIT_AUTHOR_NAME: n,
      GIT_AUTHOR_EMAIL: e,
      GIT_COMMITTER_NAME: n,
      GIT_COMMITTER_EMAIL: e,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, content) => {
    const abs = path.join(repo, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const tick = (hours = 7) => {
    clock += hours * 60 * 60 * 1000 + Math.floor(Math.random() * 3600 * 1000);
  };
  const commit = (person, message, files) => {
    who = person;
    tick();
    for (const [f, c] of Object.entries(files)) {
      if (c === null) fs.rmSync(path.join(repo, f), { force: true });
      else write(f, c);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Maya Okafor');
  git('config', 'user.email', 'maya@example.dev');

  const server = (extra = '') => `import { createServer } from 'node:http';
import { router } from './router.js';
${extra}
const port = Number(process.env.PORT || 8080);

createServer((req, res) => router(req, res)).listen(port, () => {
  console.log(\`harbor-api listening on :\${port}\`);
});
`;
  const router = (routes) => `import { json } from './util/json.js';

const routes = {
${routes.map((r) => `  '${r}': (req, res) => json(res, { ok: true, route: '${r}' }),`).join('\n')}
};

export function router(req, res) {
  const handler = routes[req.url.split('?')[0]];
  if (!handler) return json(res, { error: 'not found' }, 404);
  return handler(req, res);
}
`;

  commit(0, 'Initial commit', {
    'README.md': '# harbor-api\n\nShipping manifest service for the Harbor dashboard.\n',
    'package.json': '{\n  "name": "harbor-api",\n  "version": "0.1.0",\n  "type": "module"\n}\n',
    '.gitignore': 'node_modules/\n.env\n',
  });
  commit(0, 'Add HTTP server and router skeleton', {
    'src/server.js': server(),
    'src/router.js': router(['/health']),
    'src/util/json.js': "export function json(res, body, status = 200) {\n  res.writeHead(status, { 'content-type': 'application/json' });\n  res.end(JSON.stringify(body));\n}\n",
  });
  commit(1, 'Add manifests endpoint', { 'src/router.js': router(['/health', '/manifests']) });
  commit(2, 'Document local development setup', {
    'README.md': '# harbor-api\n\nShipping manifest service for the Harbor dashboard.\n\n## Develop\n\n```sh\nnpm install\nnpm run dev\n```\n',
  });
  git('tag', '-a', 'v1.0.0', '-m', 'First public release');

  git('checkout', '-q', '-b', 'develop');
  commit(1, 'Add vessel lookup by IMO number', { 'src/router.js': router(['/health', '/manifests', '/vessels']) });
  commit(3, 'Validate container codes (ISO 6346)', {
    'src/validate.js': "const RE = /^[A-Z]{3}[UJZ]\\d{7}$/;\n\nexport function isContainerCode(code) {\n  return RE.test(code);\n}\n",
  });

  git('checkout', '-q', '-b', 'feature/auth-tokens');
  commit(2, 'Add signed session tokens', {
    'src/auth/token.js': "import { createHmac } from 'node:crypto';\n\nexport function sign(payload, secret) {\n  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');\n  const mac = createHmac('sha256', secret).update(body).digest('base64url');\n  return `${body}.${mac}`;\n}\n",
  });
  commit(2, 'Verify token expiry before routing', {
    'src/auth/verify.js': "export function expired(claims, now = Date.now()) {\n  return !claims.exp || claims.exp * 1000 < now;\n}\n",
  });

  git('checkout', '-q', 'develop');
  git('checkout', '-q', '-b', 'feature/rate-limiter');
  commit(4, 'Token-bucket rate limiter middleware', {
    'src/limit.js': "export function bucket({ rate = 10, burst = 20 } = {}) {\n  let tokens = burst;\n  let last = Date.now();\n  return () => {\n    const now = Date.now();\n    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);\n    last = now;\n    if (tokens < 1) return false;\n    tokens -= 1;\n    return true;\n  };\n}\n",
  });

  git('checkout', '-q', 'develop');
  commit(3, 'Return 422 for malformed manifests', { 'src/server.js': server("import { isContainerCode } from './validate.js';\n") });
  who = 2;
  tick();
  git('merge', '-q', '--no-ff', '-m', "Merge branch 'feature/auth-tokens' into develop", 'feature/auth-tokens');

  git('checkout', '-q', 'main');
  commit(0, 'Fix crash when PORT is not numeric', {
    'src/config.js': "export function port(value = process.env.PORT) {\n  const n = Number(value);\n  return Number.isInteger(n) && n > 0 ? n : 8080;\n}\n",
  });
  git('checkout', '-q', '-b', 'fix/null-session');
  commit(1, 'Guard against null session on logout', {
    'src/session.js': 'export function endSession(session) {\n  if (!session) return false;\n  session.active = false;\n  return true;\n}\n',
  });
  git('checkout', '-q', 'main');
  who = 0;
  tick();
  git('merge', '-q', '--no-ff', '-m', "Merge branch 'fix/null-session'", 'fix/null-session');
  git('tag', 'v1.0.1');

  git('checkout', '-q', 'develop');
  who = 1;
  tick();
  git('merge', '-q', '--no-ff', '-m', "Merge branch 'main' into develop", 'main');
  commit(4, 'Paginate manifest listing', {
    'src/paginate.js': 'export function page(items, { cursor = 0, limit = 50 } = {}) {\n  const slice = items.slice(cursor, cursor + limit);\n  return { items: slice, next: cursor + slice.length < items.length ? cursor + slice.length : null };\n}\n',
  });
  git('checkout', '-q', '-b', 'release/1.1');
  commit(0, 'Bump version to 1.1.0', { 'package.json': '{\n  "name": "harbor-api",\n  "version": "1.1.0",\n  "type": "module"\n}\n' });
  git('checkout', '-q', 'main');
  who = 0;
  tick();
  git('merge', '-q', '--no-ff', '-m', "Merge branch 'release/1.1'", 'release/1.1');
  git('tag', '-a', 'v1.1.0', '-m', 'Release 1.1.0: vessel lookup, auth tokens, pagination');

  git('checkout', '-q', 'feature/rate-limiter');
  commit(4, 'Expose limiter headers (X-RateLimit-*)', {
    'src/limit.js': "export function bucket({ rate = 10, burst = 20 } = {}) {\n  let tokens = burst;\n  let last = Date.now();\n  return (res) => {\n    const now = Date.now();\n    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);\n    last = now;\n    res?.setHeader?.('X-RateLimit-Remaining', Math.floor(tokens));\n    if (tokens < 1) return false;\n    tokens -= 1;\n    return true;\n  };\n}\n",
  });

  git('checkout', '-q', 'develop');
  commit(2, 'Add audit log for manifest edits', {
    'src/audit.js': "const entries = [];\n\nexport function record(actor, action, target) {\n  entries.push({ at: new Date().toISOString(), actor, action, target });\n}\n\nexport function recent(n = 20) {\n  return entries.slice(-n).reverse();\n}\n",
  });
  commit(3, 'Speed up manifest search with an index', {
    'src/search.js': 'export function indexBy(items, key) {\n  const map = new Map();\n  for (const item of items) map.set(item[key], item);\n  return map;\n}\n',
  });

  // Remote with main/develop pushed; local develop then gets ahead.
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git('remote', 'add', 'origin', bare);
  git('push', '-q', '-u', 'origin', 'main', 'develop', 'feature/rate-limiter');
  git('push', '-q', 'origin', '--tags');
  commit(1, 'Tighten CORS allow-list', {
    'src/cors.js': "const ALLOWED = new Set(['https://harbor.example.dev']);\n\nexport function allowed(origin) {\n  return ALLOWED.has(origin);\n}\n",
  });
  commit(2, 'Log slow requests over 500 ms', {
    'src/slowlog.js': "export function slowlog(ms, url) {\n  if (ms > 500) console.warn('slow', url, ms);\n}\n",
  });

  // A stash.
  write('src/audit.js', `${fs.readFileSync(path.join(repo, 'src/audit.js'), 'utf8')}\nexport function clear() {\n  entries.length = 0;\n}\n`);
  who = 1;
  execFileSync('git', ['stash', 'push', '-q', '-m', 'audit: clear() experiment'], { cwd: repo, env: env() });

  if (withWip) {
    const routerSrc = fs.readFileSync(path.join(repo, 'src/router.js'), 'utf8');
    write('src/router.js', routerSrc.replace("  '/vessels'", "  '/vessels': (req, res) => json(res, { ok: true, route: '/vessels', cached: true }),\n  '/ports'"));
    write('src/ports.js', "export const PORTS = ['NLRTM', 'SGSIN', 'CNSHA', 'USLAX'];\n\nexport function isPort(code) {\n  return PORTS.includes(code);\n}\n");
    write('README.md', `${fs.readFileSync(path.join(repo, 'README.md'), 'utf8')}\n## Endpoints\n\n- \`GET /health\`\n- \`GET /manifests\`\n- \`GET /vessels\`\n- \`GET /ports\`\n`);
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
  }
  return { root, repo, bare };
}

module.exports = { makeFixture, PEOPLE };

if (require.main === module) {
  const out = makeFixture(process.argv[2]);
  console.log(JSON.stringify(out));
}
