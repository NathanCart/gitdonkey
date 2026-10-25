'use strict';

// Git backend: every operation the UI can perform, implemented on top of the
// git CLI. Pure Node (no Electron) so it can be unit tested directly.

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const US = '\x1f';
const RS = '\x1e';
const EXTRA_PATHS = process.platform === 'win32'
  ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd'),
      ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd')] : []),
    ]
  : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const INSTALL_HINT = process.platform === 'win32'
  ? 'Install Git for Windows from https://git-scm.com/download/win and try again.'
  : process.platform === 'darwin'
    ? 'Install Git (for example `xcode-select --install`) and try again.'
    : 'Install Git with your package manager and try again.';
const MAX_DIFF_BYTES = 8 * 1024 * 1024;

// Snapshots: the working tree saved before something throws it away.
const SNAPSHOT_REFS = 'refs/gitdonkey/snapshots/';
const SNAPSHOT_KEEP = 60;
const SNAPSHOT_MAX_FILE = 50 * 1024 * 1024;
const SNAPSHOT_MAX_TOTAL = 400 * 1024 * 1024;
// GitDonkey's own bookkeeping commits: never signed, never blocked on a missing identity.
const SELF = { GIT_AUTHOR_NAME: 'GitDonkey', GIT_AUTHOR_EMAIL: 'snapshots@gitdonkey.local', GIT_COMMITTER_NAME: 'GitDonkey', GIT_COMMITTER_EMAIL: 'snapshots@gitdonkey.local' };
const STASH_SUBJECT = /^(?:WIP on|On) [^:]+: /;

// Set by the main process: the askpass bridge (env) and credential helpers (-c).
let EXTRA_ENV = {};
let EXTRA_CONFIG = [];

function configureGit({ env, config } = {}) {
  if (env) EXTRA_ENV = { ...env };
  if (config) EXTRA_CONFIG = [...config];
}

class GitError extends Error {
  constructor(message, { code = null, stderr = '', stdout = '', args = [] } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
    this.args = args;
    this.kind = classifyError(`${stderr}\n${stdout}`);
  }
}

/** Files still in conflict, said plainly. */
function unmergedError(paths) {
  const names = paths.map((p) => p.split('/').pop());
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(' and ');
  const e = new GitError(`${paths.length === 1 ? '1 file is' : `${paths.length} files are`} still conflicted (${list}). Resolve ${paths.length === 1 ? 'it' : 'them'}, or mark ${paths.length === 1 ? 'it' : 'them'} resolved, then try again.`);
  e.kind = 'UNMERGED';
  e.files = paths;
  return e;
}

function classifyError(text) {
  if (/Author identity unknown|Please tell me who you are|empty ident name/i.test(text)) return 'NO_IDENTITY';
  if (/\[rejected\]|non-fast-forward|\(fetch first\)|Updates were rejected|stale info/i.test(text)) return 'PUSH_REJECTED';
  if (/has no upstream branch|no tracking information/i.test(text)) return 'NO_UPSTREAM';
  if (/would be overwritten by|Please commit your changes or stash them|You have unstaged changes|Your index contains uncommitted changes/i.test(text)) return 'DIRTY_WORKTREE';
  if (/not fully merged/i.test(text)) return 'NOT_MERGED';
  if (/is already (?:checked out|used by worktree) at/i.test(text)) return 'WORKTREE_BUSY';
  // Git refusing to touch the index while files are mid-conflict ("f: needs merge", "could not write index").
  if (/needs merge|you need to resolve your current index first|could not write index/i.test(text)) return 'UNMERGED';
  if (/gpg failed to sign|failed to sign the data|error: (?:Couldn't|cannot) (?:load|sign)|signing failed|ssh-keygen.*(?:sign|key)|No such file or directory.*\.pub|failed to write commit object.*sign/i.test(text)) return 'SIGNING';
  if (/Authentication failed|could not read Username|Permission denied \(publickey|terminal prompts disabled|Host key verification failed/i.test(text)) return 'AUTH';
  if (/Not possible to fast-forward|not possible to fast-forward|Diverging branches can't be fast-forwarded/i.test(text)) return 'NOT_FF';
  if (/CONFLICT/.test(text)) return 'CONFLICT';
  return null;
}

const PROGRESS_LINE = /^(remote:\s*)?(Counting|Compressing|Receiving|Resolving|Enumerating|Writing|Total|Delta|Unpacking|Updating files|Checking out|Filtering content|POST git-upload-pack|From |To |\s*\* \[|\s*[0-9a-f]{7,}\.\.[0-9a-f]{7,}|\s*\+?\s*[0-9a-f]{7,}\.\.\.)/;

function cleanMessage(stderr, stdout) {
  const pick = (text) => {
    const seen = new Set();
    const lines = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.split('\r').pop().trimEnd();
      if (!line.trim()) continue;
      if (/^hint:/.test(line)) continue;
      if (PROGRESS_LINE.test(line)) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line.replace(/^(error|fatal): /, ''));
    }
    return lines.join('\n');
  };
  return pick(stderr) || pick(stdout);
}

function parseProgress(line) {
  const text = line.trim();
  const m = text.match(/^(?:remote:\s*)?([A-Za-z][A-Za-z ]+?):\s+(\d+)%/);
  return m ? { phase: m[1], percent: Number(m[2]), text } : { phase: null, percent: null, text };
}

function gitEnv(extra) {
  const env = { ...process.env };
  const parts = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const p of EXTRA_PATHS) if (!parts.includes(p)) parts.push(p);
  env.PATH = parts.join(path.delimiter);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_EDITOR = 'true';
  env.GIT_MERGE_AUTOEDIT = 'no';
  env.GIT_PAGER = 'cat';
  env.LANGUAGE = 'en';
  env.LC_MESSAGES = 'C';
  Object.assign(env, EXTRA_ENV);
  // Without the askpass bridge, never let ssh block on a hidden terminal prompt.
  if (!env.SSH_ASKPASS && !env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return Object.assign(env, extra || {});
}

/**
 * Run git and collect its output.
 * @returns {Promise<{stdout: string|Buffer, stderr: string, code: number}>}
 */
function runGit(cwd, args, { input, okCodes = [0], env, onProgress, maxBuffer = 512 * 1024 * 1024, binary = false, literal = false } = {}) {
  return new Promise((resolve, reject) => {
    // Literal pathspecs only where we pass user paths: setting it globally breaks
    // commands that rely on pathspec magic internally (e.g. `stash -u`).
    const fullArgs = [...(literal ? ['--literal-pathspecs'] : []), ...EXTRA_CONFIG, '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'advice.detachedHead=false', ...args];
    let child;
    try {
      child = spawn('git', fullArgs, { cwd, env: gitEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new GitError(e.message, { args }));
      return;
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let truncated = false;
    let pending = '';
    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen > maxBuffer) {
        truncated = true;
        child.kill();
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d) => {
      err.push(d);
      if (onProgress) {
        pending += d.toString('utf8');
        const pieces = pending.split(/[\r\n]/);
        pending = pieces.pop();
        const last = pieces.filter((p) => p.trim()).pop();
        if (last) onProgress(parseProgress(last));
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      const msg = e.code === 'ENOENT' ? `Git executable not found. ${INSTALL_HINT}` : e.message;
      reject(new GitError(msg, { args }));
    });
    child.on('close', (code) => {
      const buf = Buffer.concat(out);
      const stdout = binary ? buf : buf.toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (truncated) {
        const e = new GitError('Output too large', { code, stderr, args });
        e.kind = 'TOO_LARGE';
        reject(e);
        return;
      }
      if (okCodes.includes(code)) resolve({ stdout, stderr, code });
      else {
        const message = cleanMessage(stderr, binary ? '' : stdout) || `git ${args[0]} exited with code ${code}`;
        reject(new GitError(message, { code, stderr, stdout: binary ? '' : stdout, args }));
      }
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------- validation

function assertArg(value, what = 'argument') {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\0\n\r]/.test(value)) {
    throw new GitError(`Invalid ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{4,64}$/i.test(value)) throw new GitError(`Invalid commit id: ${value}`);
  return value;
}

function assertStash(ref) {
  if (typeof ref !== 'string' || !/^stash@\{\d+\}$/.test(ref)) throw new GitError(`Invalid stash: ${ref}`);
  return ref;
}

function assertPaths(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) {
    throw new GitError('Invalid path list');
  }
  return paths;
}

function trackParse(track) {
  const r = { ahead: 0, behind: 0, gone: false };
  if (!track) return r;
  if (/gone/.test(track)) r.gone = true;
  const a = track.match(/ahead (\d+)/);
  const b = track.match(/behind (\d+)/);
  if (a) r.ahead = Number(a[1]);
  if (b) r.behind = Number(b[1]);
  return r;
}

// ---------------------------------------------------------------- parsers

function parseStatus(out) {
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, detached: false, unborn: false };
  const staged = [];
  const unstaged = [];
  const conflicted = [];
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const parts = t.split(' ');
      const key = parts[1];
      const val = parts.slice(2).join(' ');
      if (key === 'branch.oid') {
        if (val === '(initial)') branch.unborn = true;
        else branch.oid = val;
      } else if (key === 'branch.head') {
        if (val === '(detached)') branch.detached = true;
        else branch.head = val;
      } else if (key === 'branch.upstream') branch.upstream = val;
      else if (key === 'branch.ab') {
        const m = val.match(/\+(\d+) -(\d+)/);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = t[0];
    if (type === '1' || type === '2') {
      const parts = t.split(' ');
      const xy = parts[1];
      // S<c><m><u>: a submodule, with new commits / changed files / untracked files.
      const sub = parts[2] && parts[2][0] === 'S' ? { commits: parts[2][1] === 'C', changes: parts[2][2] === 'M', untracked: parts[2][3] === 'U' } : null;
      let p;
      let orig = null;
      if (type === '1') p = parts.slice(8).join(' ');
      else {
        p = parts.slice(9).join(' ');
        orig = toks[++i];
      }
      if (xy[0] !== '.') staged.push({ path: p, oldPath: orig, status: xy[0], ...(sub ? { submodule: sub } : {}) });
      if (xy[1] !== '.') unstaged.push({ path: p, oldPath: null, status: xy[1], ...(sub ? { submodule: sub } : {}) });
    } else if (type === 'u') {
      const parts = t.split(' ');
      conflicted.push({ path: parts.slice(10).join(' '), oldPath: null, status: 'U', conflict: parts[1] });
    } else if (type === '?') {
      unstaged.push({ path: t.slice(2), oldPath: null, status: '?', untracked: true });
    }
  }
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  staged.sort(byPath);
  unstaged.sort(byPath);
  conflicted.sort(byPath);
  return { branch, staged, unstaged, conflicted };
}

function parseLog(out) {
  const commits = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const f = rec.split(US);
    if (f.length < 6) continue;
    commits.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      email: f[3],
      date: Number(f[4]) * 1000,
      subject: f.slice(5).join(US),
    });
  }
  return commits;
}

function parseNameStatus(out) {
  const toks = out.split('\0');
  const files = [];
  for (let i = 0; i < toks.length; ) {
    const st = toks[i];
    if (!st) {
      i++;
      continue;
    }
    if (st[0] === 'R' || st[0] === 'C') {
      files.push({ status: st[0], score: Number(st.slice(1)) || null, oldPath: toks[i + 1], path: toks[i + 2] });
      i += 3;
    } else {
      files.push({ status: st[0], oldPath: null, path: toks[i + 1] });
      i += 2;
    }
  }
  return files;
}

function parseNumstat(out) {
  const toks = out.split('\0');
  const map = new Map();
  for (let i = 0; i < toks.length; ) {
    const entry = toks[i];
    if (!entry) {
      i++;
      continue;
    }
    const parts = entry.split('\t');
    const add = parts[0] === '-' ? null : Number(parts[0]);
    const del = parts[1] === '-' ? null : Number(parts[1]);
    let p;
    if (parts.length >= 3 && parts[2] === '') {
      p = toks[i + 2];
      i += 3;
    } else {
      p = parts.slice(2).join('\t');
      i += 1;
    }
    map.set(p, { additions: add, deletions: del, binary: add === null });
  }
  return map;
}

function parseBlame(out) {
  const commits = {};
  const lines = [];
  const rows = out.split('\n');
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row[0] === '\t') {
      lines.push({ hash: cur.hash, origLine: cur.orig, line: cur.final, text: row.slice(1) });
      continue;
    }
    const m = row.match(/^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/);
    if (m) {
      cur = { hash: m[1], orig: Number(m[2]), final: Number(m[3]) };
      if (!commits[m[1]]) commits[m[1]] = { hash: m[1] };
      continue;
    }
    if (!cur) continue;
    const sp = row.indexOf(' ');
    const key = sp === -1 ? row : row.slice(0, sp);
    const val = sp === -1 ? '' : row.slice(sp + 1);
    const c = commits[cur.hash];
    if (key === 'author') c.author = val;
    else if (key === 'author-mail') c.email = val.replace(/^<|>$/g, '');
    else if (key === 'author-time') c.date = Number(val) * 1000;
    else if (key === 'summary') c.summary = val;
    else if (key === 'filename') c.filename = val;
  }
  return { commits, lines };
}

// ---------------------------------------------------------------- repo

class GitRepo {
  constructor(root) {
    // Normalised so Windows paths compare with path.sep separators.
    this.root = path.resolve(root);
    this._gitDir = null;
    this._emptyTree = null;
  }

  async run(args, opts) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runGit(this.root, args, opts);
      } catch (e) {
        // Another git process (a terminal, an editor) briefly holds the lock;
        // git refuses before changing anything, so a retry is safe.
        if (attempt < 3 && /index\.lock': File exists/.test(e.stderr || '')) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  async text(args, opts) {
    return (await this.run(args, opts)).stdout;
  }

  resolvePath(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new GitError('Invalid path');
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new GitError('Path is outside the repository');
    const parts = path.relative(this.root, abs).split(path.sep);
    if (parts[0] === '.git') throw new GitError('Refusing to touch the .git directory');
    return abs;
  }

  async gitDir() {
    if (!this._gitDir) this._gitDir = (await this.text(['rev-parse', '--absolute-git-dir'])).trim();
    return this._gitDir;
  }

  async emptyTree() {
    if (!this._emptyTree) this._emptyTree = (await this.text(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim();
    return this._emptyTree;
  }

  async hasHead() {
    const r = await this.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { okCodes: [0, 1, 128] });
    return r.code === 0;
  }

  async headHash() {
    const r = await this.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { okCodes: [0, 1, 128] });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async info() {
    return { root: this.root, name: path.basename(this.root), gitDir: await this.gitDir() };
  }

  // ------------------------------------------------------------ reading

  async status() {
    return parseStatus(await this.text(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']));
  }

  async refs() {
    const fmt = [
      '%(refname)', '%(objectname)', '%(*objectname)', '%(objecttype)', '%(upstream)',
      '%(upstream:track,nobracket)', '%(upstream:remotename)', '%(upstream:remoteref)',
      '%(symref)', '%(contents:subject)', '%(creatordate:unix)',
    ].join('%1f');
    const [out, remotesOut, headSym, headHash] = await Promise.all([
      this.text(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.text(['remote']),
      this.run(['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1, 128] }).then((r) => r.stdout.trim()),
      this.headHash(),
    ]);
    const remotes = remotesOut.split('\n').map((s) => s.trim()).filter(Boolean);
    const byLength = [...remotes].sort((a, b) => b.length - a.length);
    const local = [];
    const remote = [];
    const tags = [];
    const remoteHeads = {};
    for (const line of out.split('\n')) {
      if (!line) continue;
      const f = line.split(US);
      const [refname, objectname, peeled, objecttype, upstream, track, upRemote, upRef, symref, subject, cdate] = f;
      if (refname.startsWith('refs/heads/')) {
        const name = refname.slice(11);
        local.push({
          name,
          fullName: refname,
          hash: objectname,
          upstream: upstream ? upstream.replace(/^refs\/remotes\//, '') : null,
          upstreamRemote: upRemote || null,
          upstreamBranch: upRef ? upRef.replace(/^refs\/heads\//, '') : null,
          isHead: refname === headSym,
          ...trackParse(track),
        });
      } else if (refname.startsWith('refs/remotes/')) {
        const rest = refname.slice(13);
        const rname = byLength.find((r) => rest.startsWith(`${r}/`)) || rest.split('/')[0];
        const bname = rest.slice(rname.length + 1);
        if (symref) {
          remoteHeads[rname] = symref.replace(/^refs\/remotes\//, '');
          continue;
        }
        remote.push({ remote: rname, name: bname, fullName: refname, shortName: rest, hash: objectname });
      } else if (refname.startsWith('refs/tags/')) {
        const annotated = objecttype === 'tag';
        tags.push({
          name: refname.slice(10),
          fullName: refname,
          hash: annotated ? peeled || objectname : objectname,
          tagObject: objectname,
          annotated,
          message: annotated ? subject : '',
          date: Number(cdate) * 1000 || null,
        });
      }
    }
    return {
      head: {
        branch: headSym ? headSym.replace(/^refs\/heads\//, '') : null,
        hash: headHash,
        detached: !headSym,
        unborn: Boolean(headSym) && !headHash,
      },
      local,
      remote,
      tags,
      remotes,
      remoteHeads,
    };
  }

  /**
   * The graph's commits. By default every branch, remote branch and tag;
   * `only` limits it to those refs, `hidden` leaves those branches out, and
   * `remotes` / `tags` false leave remote branches / tags out.
   */
  async log({ skip = 0, max = 1000, only = null, hidden = [], remotes = true, tags = true } = {}) {
    const refname = (r) => {
      if (typeof r !== 'string' || !/^refs\/(heads|remotes|tags)\/[^\0\n\r]+$/.test(r)) throw new GitError(`Invalid ref: ${r}`);
      return r;
    };
    const revs = [];
    if (only && only.length) revs.push('--ignore-missing', ...only.map(refname));
    else {
      const hide = (prefix) => (hidden || []).map(refname).filter((r) => r.startsWith(prefix)).map((r) => `--exclude=${r.slice(prefix.length)}`);
      revs.push(...hide('refs/heads/'), '--branches');
      if (remotes) revs.push(...hide('refs/remotes/'), '--remotes');
      if (tags) revs.push('--tags');
      if (await this.hasHead()) revs.push('HEAD');
    }
    const out = await this.text([
      'log', ...revs, '--date-order', '-z', `--max-count=${Number(max) | 0}`, `--skip=${Number(skip) | 0}`,
      '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s', '--',
    ]);
    return parseLog(out);
  }

  async searchCommits(query, { max = 500 } = {}) {
    if (typeof query !== 'string' || !query.trim()) return [];
    const revs = ['--branches', '--remotes', '--tags'];
    if (await this.hasHead()) revs.push('HEAD');
    const base = ['log', ...revs, '--date-order', '-z', `--max-count=${max}`, '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s', '--regexp-ignore-case', '--fixed-strings'];
    const [byMsg, byAuthor] = await Promise.all([
      this.text([...base, `--grep=${query}`]),
      this.text([...base, `--author=${query}`]),
    ]);
    const seen = new Set();
    const list = [];
    for (const c of [...parseLog(byMsg), ...parseLog(byAuthor)]) {
      if (seen.has(c.hash)) continue;
      seen.add(c.hash);
      list.push(c);
    }
    return list.sort((a, b) => b.date - a.date);
  }

  async stashes() {
    const r = await this.run(['stash', 'list', '-z', '--format=%gd%x1f%H%x1f%P%x1f%ct%x1f%gs'], { okCodes: [0, 1, 128] });
    if (r.code !== 0) return [];
    return r.stdout.split('\0').filter(Boolean).map((rec) => {
      const [ref, hash, parents, ct, ...rest] = rec.split(US);
      const subject = rest.join(US);
      const m = subject.match(/^(?:WIP on|On) ([^:]+): ?(.*)$/);
      return {
        ref,
        index: Number((ref.match(/\{(\d+)\}/) || [])[1]),
        hash,
        parents: parents ? parents.split(' ') : [],
        date: Number(ct) * 1000,
        message: subject,
        branch: m ? m[1] : null,
        summary: m ? m[2] : subject,
      };
    });
  }

  async remotes() {
    const out = await this.text(['remote', '-v']);
    const map = new Map();
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
      if (!m) continue;
      if (!map.has(m[1])) map.set(m[1], { name: m[1], fetchUrl: null, pushUrl: null });
      map.get(m[1])[m[3] === 'fetch' ? 'fetchUrl' : 'pushUrl'] = m[2];
    }
    return [...map.values()];
  }

  async opState() {
    const gd = await this.gitDir();
    const has = (p) => fs.existsSync(path.join(gd, p));
    const read = async (p) => {
      try {
        return (await fsp.readFile(path.join(gd, p), 'utf8')).trim();
      } catch {
        return null;
      }
    };
    if (has('rebase-merge') || has('rebase-apply')) {
      const dir = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
      if (dir === 'rebase-apply' && has('rebase-apply/applying')) return { type: 'am' };
      const step = Number(await read(dir === 'rebase-merge' ? `${dir}/msgnum` : `${dir}/next`)) || null;
      const total = Number(await read(dir === 'rebase-merge' ? `${dir}/end` : `${dir}/last`)) || null;
      const headName = await read(`${dir}/head-name`);
      const onto = await read(`${dir}/onto`);
      const stopped = await read(`${dir}/stopped-sha`);
      return {
        type: 'rebase',
        step,
        total,
        branch: headName ? headName.replace(/^refs\/heads\//, '') : null,
        onto,
        stopped,
        message: await read(`${dir}/message`),
      };
    }
    if (has('MERGE_HEAD')) {
      return { type: 'merge', heads: ((await read('MERGE_HEAD')) || '').split('\n'), message: await read('MERGE_MSG') };
    }
    if (has('CHERRY_PICK_HEAD')) return { type: 'cherry-pick', hash: await read('CHERRY_PICK_HEAD'), message: await read('MERGE_MSG') };
    if (has('REVERT_HEAD')) return { type: 'revert', hash: await read('REVERT_HEAD'), message: await read('MERGE_MSG') };
    return null;
  }

  async commitDetails(hash, { stash = false } = {}) {
    assertHash(hash);
    const out = await this.text(['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', hash, '--']);
    const f = out.split(US);
    const parents = f[1] ? f[1].split(' ') : [];
    const body = f.slice(8).join(US).replace(/\s+$/, '');
    const nl = body.indexOf('\n');
    const details = {
      hash: f[0],
      parents,
      author: f[2],
      email: f[3],
      date: Number(f[4]) * 1000,
      committer: f[5],
      committerEmail: f[6],
      commitDate: Number(f[7]) * 1000,
      message: body,
      subject: nl === -1 ? body : body.slice(0, nl),
      body: nl === -1 ? '' : body.slice(nl + 1).replace(/^\s*\n/, ''),
    };
    const from = parents[0] || (await this.emptyTree());
    details.files = await this.changedFiles(from, details.hash);
    details.signature = stash ? null : await this.signature(details.hash).catch(() => null);
    if (stash && parents[2]) {
      const untracked = await this.changedFiles(await this.emptyTree(), parents[2]);
      for (const u of untracked) {
        u.status = 'A';
        u.untracked = true;
      }
      details.files.push(...untracked);
    }
    return details;
  }

  /** Whether a commit is signed, how, and whether this computer can vouch for it. */
  async signature(hash) {
    assertHash(hash);
    const raw = await this.text(['cat-file', 'commit', hash]);
    const header = raw.slice(0, raw.indexOf('\n\n') === -1 ? raw.length : raw.indexOf('\n\n'));
    if (!/^gpgsig(?:-sha256)? /m.test(header)) return null;
    const type = /BEGIN SSH SIGNATURE/.test(header) ? 'ssh' : /BEGIN SIGNED MESSAGE/.test(header) ? 'x509' : 'gpg';
    const r = await this.run(['log', '-1', '--format=%G?%x1f%GS%x1f%GK', hash, '--'], { okCodes: [0, 1, 128] });
    const [code = 'E', signer = '', key = ''] = r.stdout.trim().split(US);
    // G: good, from a signer we trust. U: good, but the signer isn't one we know. E / N: can't check here.
    const status = { G: 'verified', U: 'signed', X: 'expired', Y: 'expired', R: 'revoked', B: 'bad' }[code] || 'unverified';
    return { type, status, signer: signer || null, key: key || null };
  }

  /** How commits are signed here: the settings Git will use in this repository. */
  async signingConfig() {
    const get = async (key, scope = []) => (await this.run(['config', ...scope, '--get', key], { okCodes: [0, 1] })).stdout.trim();
    const [enabled, format, key, allowed, localEnabled] = await Promise.all([
      get('commit.gpgsign'), get('gpg.format'), get('user.signingkey'), get('gpg.ssh.allowedSignersFile'), get('commit.gpgsign', ['--local']),
    ]);
    return {
      enabled: /^(true|yes|on|1)$/i.test(enabled),
      format: format === 'ssh' ? 'ssh' : format === 'x509' ? 'x509' : 'gpg',
      key: key || null,
      allowedSigners: allowed || null,
      scope: localEnabled ? 'local' : 'global',
    };
  }

  /**
   * Turn signing on (with an SSH or GPG key) or off, for every repository or
   * just this one. With SSH, your own key is added to the allowed signers so
   * your commits show as verified here too.
   */
  async setSigning({ enabled, format = 'ssh', key = null, scope = 'global' } = {}) {
    const where = scope === 'local' ? '--local' : '--global';
    if (!enabled) {
      await this.run(['config', where, 'commit.gpgsign', 'false']);
      if (scope === 'global') await this.run(['config', '--local', '--unset', 'commit.gpgsign'], { okCodes: [0, 5] });
      return this.signingConfig();
    }
    if (format !== 'ssh' && format !== 'gpg') throw new GitError('Choose SSH or GPG');
    if (typeof key !== 'string' || !key.trim() || /[\0\n\r]/.test(key)) throw new GitError('Choose a key to sign with');
    const k = key.trim();
    if (format === 'ssh' && !k.startsWith('ssh-') && !k.startsWith('key::') && !fs.existsSync(k.replace(/^~(?=\/)/, os.homedir()))) throw new GitError(`There’s no key file at ${k}`);
    await this.run(['config', where, 'gpg.format', format === 'ssh' ? 'ssh' : 'openpgp']);
    await this.run(['config', where, 'user.signingkey', k]);
    await this.run(['config', where, 'commit.gpgsign', 'true']);
    if (format === 'ssh') await this.trustOwnSshKey(k, where).catch(() => {});
    return this.signingConfig();
  }

  /** Add your own public key to the allowed signers file (made if needed), so Git can verify your commits. */
  async trustOwnSshKey(key, where = '--global') {
    const file = key.replace(/^~(?=\/)/, os.homedir());
    const pub = key.startsWith('key::') ? key.slice(5) : key.startsWith('ssh-') ? key : (await fsp.readFile(file.endsWith('.pub') ? file : `${file}.pub`, 'utf8')).trim();
    const email = (await this.run(['config', '--get', 'user.email'], { okCodes: [0, 1] })).stdout.trim();
    if (!email || !pub) return;
    let allowed = (await this.run(['config', '--get', 'gpg.ssh.allowedSignersFile'], { okCodes: [0, 1] })).stdout.trim();
    if (!allowed) {
      allowed = path.join(os.homedir(), '.ssh', 'allowed_signers');
      await this.run(['config', where, 'gpg.ssh.allowedSignersFile', allowed]);
    }
    const target = allowed.replace(/^~(?=\/)/, os.homedir());
    let existing = '';
    try {
      existing = await fsp.readFile(target, 'utf8');
    } catch {}
    const keyPart = pub.split(/\s+/).slice(0, 2).join(' ');
    if (existing.includes(keyPart)) return;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.appendFile(target, `${existing && !existing.endsWith('\n') ? '\n' : ''}${email} namespaces="git" ${keyPart}\n`, { mode: 0o644 });
  }

  async changedFiles(from, to) {
    assertArg(from, 'revision');
    assertArg(to, 'revision');
    const [ns, num] = await Promise.all([
      this.text(['diff', '--name-status', '-z', '-M', from, to, '--']),
      this.text(['diff', '--numstat', '-z', '-M', from, to, '--']),
    ]);
    const stats = parseNumstat(num);
    return parseNameStatus(ns).map((file) => ({
      ...file,
      from,
      to,
      ...(stats.get(file.path) || { additions: 0, deletions: 0, binary: false }),
    }));
  }

  async diff({ kind, path: p, oldPath = null, from, to, context = 3, ignoreWhitespace = false } = {}) {
    if (typeof p !== 'string' || !p) throw new GitError('Missing path');
    const base = ['diff', '--no-color', '--no-ext-diff', `-U${Math.max(0, Math.min(Number(context) || 3, 1000))}`];
    if (ignoreWhitespace) base.push('-w');
    const pathspec = oldPath && oldPath !== p ? [oldPath, p] : [p];
    let args;
    let okCodes = [0];
    if (kind === 'untracked') {
      args = [...base, '--no-index', '--', '/dev/null', p];
      okCodes = [0, 1];
    } else if (kind === 'unstaged') args = [...base, '--', p];
    else if (kind === 'staged') args = [...base, '-M', '--cached', '--', ...pathspec];
    else if (kind === 'commit') {
      assertArg(from, 'revision');
      assertArg(to, 'revision');
      args = [...base, '-M', from, to, '--', ...pathspec];
    } else throw new GitError(`Unknown diff kind: ${kind}`);
    try {
      const r = await this.run(args, { okCodes, maxBuffer: MAX_DIFF_BYTES, literal: kind !== 'untracked' });
      return { text: r.stdout, tooLarge: false };
    } catch (e) {
      if (e.kind === 'TOO_LARGE') return { text: '', tooLarge: true };
      throw e;
    }
  }

  async blob({ rev, path: p }) {
    const maxBuffer = 25 * 1024 * 1024;
    if (rev === 'working') {
      const abs = this.resolvePath(p);
      try {
        const st = await fsp.stat(abs);
        if (st.size > maxBuffer) return { tooLarge: true };
        return { base64: (await fsp.readFile(abs)).toString('base64'), size: st.size };
      } catch {
        return null;
      }
    }
    const spec = rev === 'index' ? `:${p}` : `${assertArg(rev, 'revision')}:${p}`;
    try {
      const r = await this.run(['show', spec], { binary: true, maxBuffer });
      return { base64: r.stdout.toString('base64'), size: r.stdout.length };
    } catch (e) {
      if (e.kind === 'TOO_LARGE') return { tooLarge: true };
      return null;
    }
  }

  async showFile({ rev, path: p }) {
    const b = await this.blob({ rev, path: p });
    if (!b) return null;
    if (b.tooLarge) return { tooLarge: true };
    const buf = Buffer.from(b.base64, 'base64');
    const binary = buf.subarray(0, 8000).includes(0);
    return { text: binary ? '' : buf.toString('utf8'), binary, size: b.size };
  }

  async fileHistory(p, { max = 300 } = {}) {
    if (typeof p !== 'string' || !p) throw new GitError('Missing path');
    const revs = (await this.hasHead()) ? ['HEAD'] : [];
    if (!revs.length) return [];
    const out = await this.text([
      'log', ...revs, '--follow', '-M', '-z', `--max-count=${max}`, '--name-status',
      '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s', '--', p,
    ], { literal: true });
    const list = [];
    for (const rec of out.split(RS)) {
      if (!rec) continue;
      const nul = rec.indexOf('\0');
      const header = nul === -1 ? rec : rec.slice(0, nul);
      const rest = nul === -1 ? '' : rec.slice(nul + 1).replace(/^\n/, '');
      const f = header.split(US);
      const files = parseNameStatus(rest);
      const file = files[0] || { status: 'M', path: p, oldPath: null };
      list.push({
        hash: f[0],
        parents: f[1] ? f[1].split(' ') : [],
        author: f[2],
        email: f[3],
        date: Number(f[4]) * 1000,
        subject: f.slice(5).join(US),
        status: file.status,
        path: file.path,
        oldPath: file.oldPath,
      });
    }
    return list;
  }

  async blame(p, rev = null) {
    if (typeof p !== 'string' || !p) throw new GitError('Missing path');
    const args = ['blame', '--porcelain'];
    if (rev) args.push(assertArg(rev, 'revision'));
    args.push('--', p);
    return parseBlame(await this.text(args, { maxBuffer: 64 * 1024 * 1024 }));
  }

  /** Commits in base..HEAD, oldest first (for interactive rebase). */
  async rangeCommits(base) {
    const args = ['log', '--reverse', '-z', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s'];
    args.push(base ? `${assertArg(base, 'base')}..HEAD` : 'HEAD');
    return parseLog(await this.text(args));
  }

  /**
   * What an AI commit message is written from: the staged diff, its files,
   * the branch and recent subjects. When amending, the diff covers the whole
   * commit as it will be (index against HEAD's parent).
   */
  async commitContext({ amend = false } = {}) {
    const hasHead = await this.hasHead();
    let base = null;
    if (!hasHead) base = await this.emptyTree();
    else if (amend) {
      const parents = (await this.text(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(/\s+/).slice(1);
      base = parents[0] || (await this.emptyTree());
    }
    const range = base ? ['--cached', base] : ['--cached'];
    const [diff, ns, branch, recent] = await Promise.all([
      this.run(['diff', '--no-color', '--no-ext-diff', '-M', '-U3', ...range, '--'], { maxBuffer: MAX_DIFF_BYTES })
        .then((r) => r.stdout)
        .catch((e) => {
          if (e.kind === 'TOO_LARGE') return '';
          throw e;
        }),
      this.text(['diff', '--name-status', '-z', '-M', ...range, '--']),
      this.run(['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1, 128] }).then((r) => r.stdout.trim() || null),
      hasHead ? this.text(['log', '-12', '--format=%s', ...(amend ? ['--skip=1'] : []), 'HEAD', '--']).then((s) => s.split('\n').filter(Boolean)) : [],
    ]);
    return { diff, files: parseNameStatus(ns), branch, recent };
  }

  async lastCommitMessage() {
    if (!(await this.hasHead())) return '';
    return (await this.text(['log', '-1', '--format=%B', 'HEAD'])).replace(/\s+$/, '');
  }

  async _diffText(args) {
    try {
      return (await this.run(['diff', '--no-color', '--no-ext-diff', '-M', '-U3', ...args, '--'], { maxBuffer: MAX_DIFF_BYTES })).stdout;
    } catch (e) {
      if (e.kind === 'TOO_LARGE') return '';
      throw e;
    }
  }

  /** A commit's message, files and diff (against its first parent), for the AI to read. */
  async commitPatch(hash) {
    const c = await this.commitDetails(hash);
    const from = c.parents[0] || (await this.emptyTree());
    return { commit: { author: c.author, subject: c.subject, body: c.body }, files: c.files, diff: await this._diffText([from, c.hash]) };
  }

  /** What `head` changes compared with `base` (from where they split), for the AI to read. */
  async rangePatch(base, head) {
    assertArg(base, 'base');
    assertArg(head, 'head');
    const [commits, ns, diff] = await Promise.all([
      this.commitsBetween(base, head, { max: 60 }),
      this.text(['diff', '--name-status', '-z', '-M', `${base}...${head}`, '--']),
      this._diffText([`${base}...${head}`]),
    ]);
    return { range: { base, head, commits }, files: parseNameStatus(ns), diff };
  }

  /** Commits on `head` that `base` doesn't have, newest first. */
  async commitsBetween(base, head, { max = 200 } = {}) {
    assertArg(base, 'base');
    assertArg(head, 'head');
    return parseLog(await this.text(['log', '-z', `--max-count=${Number(max) | 0}`, '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s', `${base}..${head}`, '--']));
  }

  /** Fetch a pull request's head (from a fork too) into `localName`, and check it out. */
  async checkoutPull(remote, number, localName) {
    assertArg(remote, 'remote');
    assertArg(localName, 'branch name');
    if (!Number.isInteger(number) || number <= 0) throw new GitError('Invalid pull request number');
    if (!(await this.validateBranchName(localName))) throw new GitError(`"${localName}" is not a valid branch name`);
    await this.run(['fetch', '--progress', remote, `refs/pull/${number}/head`]);
    const exists = await this.run(['show-ref', '--verify', '-q', `refs/heads/${localName}`], { okCodes: [0, 1] });
    if (exists.code === 0) {
      await this.run(['checkout', '-q', localName, '--']);
      await this.run(['merge', '--ff-only', 'FETCH_HEAD']);
    } else {
      await this.run(['checkout', '-q', '-b', localName, 'FETCH_HEAD', '--']);
    }
  }

  async isAncestor(a, b) {
    assertArg(a, 'revision');
    assertArg(b, 'revision');
    const r = await this.run(['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1] });
    return r.code === 0;
  }

  async revParse(rev) {
    assertArg(rev, 'revision');
    return (await this.text(['rev-parse', '--verify', `${rev}^{commit}`])).trim();
  }

  async identity() {
    const get = async (args) => (await this.run(['config', ...args], { okCodes: [0, 1] })).stdout.trim();
    const [name, email, gname, gemail] = await Promise.all([
      get(['user.name']), get(['user.email']), get(['--global', 'user.name']), get(['--global', 'user.email']),
    ]);
    return { name, email, globalName: gname, globalEmail: gemail };
  }

  async setIdentity({ name, email, global = true }) {
    const scope = global ? '--global' : '--local';
    if (typeof name === 'string' && name.trim()) await this.run(['config', scope, 'user.name', name.trim()]);
    if (typeof email === 'string' && email.trim()) await this.run(['config', scope, 'user.email', email.trim()]);
  }

  // ------------------------------------------------------------ index & worktree

  async stage(paths) {
    assertPaths(paths);
    if (!paths.length) return;
    await this.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0'), literal: true });
  }

  async stageAll() {
    await this.run(['add', '-A']);
  }

  async unstage(paths) {
    assertPaths(paths);
    if (!paths.length) return;
    const input = paths.join('\0');
    if (await this.hasHead()) {
      await this.run(['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], { input, okCodes: [0, 1], literal: true });
    } else {
      await this.run(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input, literal: true });
    }
  }

  async unstageAll() {
    if (await this.hasHead()) await this.run(['reset', '-q', 'HEAD'], { okCodes: [0, 1] });
    else await this.run(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '.']);
  }

  /** Discard unstaged changes (restore from index) and delete untracked files. */
  async discard(files) {
    if (!Array.isArray(files)) throw new GitError('Invalid file list');
    const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
    const untracked = files.filter((f) => f.untracked).map((f) => f.path);
    assertPaths(tracked);
    if (tracked.length) {
      await this.run(['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: tracked.join('\0'), literal: true });
    }
    for (const p of untracked) await fsp.rm(this.resolvePath(p), { force: true, recursive: false });
  }

  /** Throw away all changes (staged + unstaged) for the given files, back to HEAD. */
  async discardFull(files) {
    if (!Array.isArray(files)) throw new GitError('Invalid file list');
    const hasHead = await this.hasHead();
    for (const f of files) {
      const paths = assertPaths([f.path, ...(f.oldPath ? [f.oldPath] : [])]);
      if (f.status === 'A' || !hasHead) {
        await this.run(['rm', '--cached', '-q', '-f', '--ignore-unmatch', '--', f.path], { literal: true });
        await fsp.rm(this.resolvePath(f.path), { force: true });
      } else {
        await this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: paths.join('\0'),
          literal: true,
        });
      }
    }
  }

  async discardAll() {
    if (await this.hasHead()) await this.run(['reset', '--hard', '-q']);
    else await this.run(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '.']);
    await this.run(['clean', '-f', '-d', '-q']);
  }

  async applyPatch(patch, { cached = false, reverse = false } = {}) {
    if (typeof patch !== 'string' || !patch.trim()) throw new GitError('Empty patch');
    const args = ['apply', '--whitespace=nowarn', '--recount'];
    if (cached) args.push('--cached');
    if (reverse) args.push('--reverse');
    args.push('-');
    await this.run(args, { input: patch.endsWith('\n') ? patch : `${patch}\n` });
  }

  async ignore(pattern) {
    if (typeof pattern !== 'string' || !pattern.trim() || /[\n\r\0]/.test(pattern)) throw new GitError('Invalid pattern');
    const file = path.join(this.root, '.gitignore');
    let existing = '';
    try {
      existing = await fsp.readFile(file, 'utf8');
    } catch {}
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    await fsp.appendFile(file, `${prefix}${pattern.trim()}\n`);
  }

  async readFile(p) {
    return fsp.readFile(this.resolvePath(p), 'utf8');
  }

  async writeFile(p, content) {
    if (typeof content !== 'string') throw new GitError('Invalid content');
    await fsp.writeFile(this.resolvePath(p), content);
  }

  // ------------------------------------------------------------ commits

  async commit({ message, amend = false, noVerify = false, messageOnly = false, noSign = false } = {}) {
    if (typeof message !== 'string' || !message.trim()) throw new GitError('Commit message is required');
    const args = ['commit', '-q', '-F', '-', '--cleanup=strip'];
    if (noSign) args.push('--no-gpg-sign');
    if (amend) args.push('--amend');
    // --only without paths: rewrite the message, ignore whatever is staged.
    if (amend && messageOnly) args.push('--only', '--allow-empty');
    if (noVerify) args.push('--no-verify');
    await this.run(args, { input: message });
    return this.headHash();
  }

  async checkout(ref) {
    assertArg(ref, 'ref');
    await this.run(['checkout', '-q', ref, '--']);
  }

  async checkoutDetached(rev) {
    assertArg(rev, 'revision');
    await this.run(['checkout', '-q', '--detach', rev, '--']);
  }

  async checkoutRemote(remoteBranch, localName) {
    assertArg(remoteBranch, 'remote branch');
    assertArg(localName, 'branch name');
    const exists = await this.run(['show-ref', '--verify', '-q', `refs/heads/${localName}`], { okCodes: [0, 1] });
    if (exists.code === 0) await this.run(['checkout', '-q', localName, '--']);
    else await this.run(['checkout', '-q', '-b', localName, '--track', remoteBranch, '--']);
  }

  async validateBranchName(name) {
    if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
    const r = await this.run(['check-ref-format', '--branch', name], { okCodes: [0, 1, 128] });
    return r.code === 0;
  }

  async createBranch(name, start = 'HEAD', { checkout = false } = {}) {
    assertArg(name, 'branch name');
    assertArg(start, 'start point');
    if (!(await this.validateBranchName(name))) throw new GitError(`"${name}" is not a valid branch name`);
    if (checkout) await this.run(['checkout', '-q', '-b', name, start, '--']);
    else await this.run(['branch', name, start]);
  }

  async deleteBranch(name, { force = false } = {}) {
    assertArg(name, 'branch name');
    await this.run(['branch', force ? '-D' : '-d', name]);
  }

  async renameBranch(oldName, newName) {
    assertArg(oldName, 'branch name');
    assertArg(newName, 'branch name');
    if (!(await this.validateBranchName(newName))) throw new GitError(`"${newName}" is not a valid branch name`);
    await this.run(['branch', '-m', oldName, newName]);
  }

  async setUpstream(branch, upstream) {
    assertArg(branch, 'branch');
    if (upstream) await this.run(['branch', `--set-upstream-to=${assertArg(upstream, 'upstream')}`, branch]);
    else await this.run(['branch', '--unset-upstream', branch]);
  }

  /** Move a branch that is not checked out to `target` if it is a fast-forward. */
  async fastForwardBranch(branch, target) {
    assertArg(branch, 'branch');
    assertArg(target, 'target');
    const headRef = (await this.run(['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1, 128] })).stdout.trim();
    if (headRef === `refs/heads/${branch}`) {
      // The checked-out branch must move together with the index and worktree.
      await this.run(['merge', '--ff-only', target]);
      return;
    }
    const cur = (await this.text(['rev-parse', '--verify', `refs/heads/${branch}`])).trim();
    const to = await this.revParse(target);
    if (!(await this.isAncestor(cur, to))) {
      const e = new GitError(`Cannot fast-forward ${branch}: it has commits that ${target} does not.`);
      e.kind = 'NOT_FF';
      throw e;
    }
    await this.run(['update-ref', '-m', `fast-forward: ${target}`, `refs/heads/${branch}`, to, cur]);
  }

  async _withConflicts(args, opts) {
    try {
      const r = await this.run(args, opts);
      return { conflicts: false, output: cleanMessage(r.stdout, r.stderr) };
    } catch (e) {
      const st = await this.status().catch(() => null);
      if (st && st.conflicted.length) return { conflicts: true, output: e.message, files: st.conflicted.map((f) => f.path) };
      throw e;
    }
  }

  async merge(ref, { noFF = false, ffOnly = false, squash = false } = {}) {
    assertArg(ref, 'ref');
    const args = ['merge'];
    if (noFF) args.push('--no-ff');
    if (ffOnly) args.push('--ff-only');
    if (squash) args.push('--squash');
    args.push('--no-edit', ref);
    return this._withConflicts(args);
  }

  async rebase(onto) {
    assertArg(onto, 'ref');
    return this._withConflicts(['rebase', '--autostash', onto]);
  }

  /**
   * Interactive rebase driven from a prepared todo list.
   * steps: [{ action: 'pick'|'reword'|'squash'|'fixup'|'drop', hash, message? }] oldest first.
   */
  async rebaseInteractive(base, steps) {
    if (base !== null) assertArg(base, 'base');
    if (!Array.isArray(steps) || !steps.length) throw new GitError('Nothing to rebase');
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdonkey-rebase-'));
    try {
      const lines = [];
      let n = 0;
      for (const s of steps) {
        assertHash(s.hash);
        if (!['pick', 'reword', 'squash', 'fixup', 'drop'].includes(s.action)) throw new GitError(`Unknown action ${s.action}`);
        if (s.action === 'reword') {
          lines.push(`pick ${s.hash}`);
          const msgFile = path.join(tmp, `msg-${n++}.txt`);
          await fsp.writeFile(msgFile, s.message || '');
          lines.push(`exec git commit --amend --allow-empty -q --cleanup=strip -F ${shellQuote(msgFile)}`);
        } else lines.push(`${s.action} ${s.hash}`);
      }
      const todo = path.join(tmp, 'todo');
      await fsp.writeFile(todo, `${lines.join('\n')}\n`);
      const args = ['rebase', '-i', '--autostash'];
      if (base === null) args.push('--root');
      else args.push(base);
      return await this._withConflicts(args, { env: { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todo)}` } });
    } finally {
      // The todo file is copied by git synchronously; reword message files are
      // read by `exec` lines, which may still be pending if the rebase stopped.
      const st = await this.opState().catch(() => null);
      if (!st || st.type !== 'rebase') await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  async cherryPick(hash) {
    assertHash(hash);
    const parents = (await this.text(['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
    const args = ['cherry-pick'];
    if (parents.length > 1) args.push('-m', '1');
    args.push(hash);
    return this._withConflicts(args);
  }

  async revert(hash) {
    assertHash(hash);
    const parents = (await this.text(['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
    const args = ['revert', '--no-edit'];
    if (parents.length > 1) args.push('-m', '1');
    args.push(hash);
    return this._withConflicts(args);
  }

  async reset(rev, mode = 'mixed') {
    assertArg(rev, 'revision');
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new GitError(`Invalid reset mode ${mode}`);
    await this.run(['reset', `--${mode}`, '-q', rev, '--']);
  }

  async abortOperation(type) {
    const map = { merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'], am: ['am', '--abort'] };
    if (!map[type]) throw new GitError(`Nothing to abort for ${type}`);
    await this.run(map[type]);
  }

  async continueOperation(type, { message } = {}) {
    if (type === 'merge') {
      if (message && message.trim()) {
        await this.run(['commit', '-q', '-F', '-', '--cleanup=strip'], { input: message });
      } else await this.run(['commit', '-q', '--no-edit']);
      return { conflicts: false };
    }
    const map = { rebase: ['rebase', '--continue'], 'cherry-pick': ['cherry-pick', '--continue'], revert: ['revert', '--continue'], am: ['am', '--continue'] };
    if (!map[type]) throw new GitError(`Cannot continue ${type}`);
    if ((type === 'cherry-pick' || type === 'revert') && message && message.trim()) {
      const gd = await this.gitDir();
      await fsp.writeFile(path.join(gd, 'MERGE_MSG'), message);
    }
    return this._withConflicts(map[type]);
  }

  async skipRebase() {
    return this._withConflicts(['rebase', '--skip']);
  }

  // ------------------------------------------------------------ conflicts

  async conflictDetails(p) {
    const stage = async (n) => {
      const r = await this.run(['show', `:${n}:${p}`], { okCodes: [0, 128] });
      return r.code === 0 ? r.stdout : null;
    };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    let working = null;
    try {
      working = await this.readFile(p);
    } catch {}
    return { path: p, base, ours, theirs, working };
  }

  async resolveConflict(p, side) {
    if (side !== 'ours' && side !== 'theirs') throw new GitError('Invalid side');
    const n = side === 'ours' ? 2 : 3;
    const r = await this.run(['show', `:${n}:${p}`], { okCodes: [0, 128] });
    if (r.code !== 0) {
      // That side deleted the file.
      await this.run(['rm', '-q', '-f', '--', p], { literal: true });
      return;
    }
    await this.run(['checkout', `--${side}`, '--', p], { literal: true });
    await this.run(['add', '--', p], { literal: true });
  }

  async markResolved(paths) {
    assertPaths(paths);
    if (!paths.length) return;
    await this.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0'), literal: true });
  }

  // ------------------------------------------------------------ tags

  async createTag(name, target = 'HEAD', message = '') {
    assertArg(name, 'tag name');
    assertArg(target, 'target');
    const fmt = await this.run(['check-ref-format', `refs/tags/${name}`], { okCodes: [0, 1] });
    if (fmt.code !== 0) throw new GitError(`"${name}" is not a valid tag name`);
    if (message && message.trim()) await this.run(['tag', '-a', name, '-F', '-', target], { input: message });
    else await this.run(['tag', name, target]);
  }

  async deleteTag(name) {
    assertArg(name, 'tag name');
    await this.run(['tag', '-d', name]);
  }

  async pushTag(remote, name, { onProgress } = {}) {
    assertArg(remote, 'remote');
    assertArg(name, 'tag name');
    await this.run(['push', '--progress', remote, `refs/tags/${name}:refs/tags/${name}`], { onProgress });
  }

  async deleteRemoteTag(remote, name) {
    assertArg(remote, 'remote');
    assertArg(name, 'tag name');
    await this.run(['push', remote, '--delete', `refs/tags/${name}`]);
  }

  // ------------------------------------------------------------ stash

  /** Paths with unresolved conflicts. */
  async unmergedPaths() {
    return (await this.text(['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
  }

  async stashSave({ message = '', includeUntracked = true, keepIndex = false } = {}) {
    // Git can't stash a half-merged index and only says "could not write index".
    const unmerged = await this.unmergedPaths();
    if (unmerged.length) throw unmergedError(unmerged);
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (keepIndex) args.push('--keep-index');
    if (message && message.trim()) args.push('-m', message.trim());
    const r = await this.run(args);
    if (/No local changes to save/.test(r.stdout + r.stderr)) throw new GitError('No local changes to stash');
    return { stashed: true };
  }

  async stashApply(ref, { pop = false, index = false } = {}) {
    assertStash(ref);
    const args = ['stash', pop ? 'pop' : 'apply'];
    if (index) args.push('--index');
    args.push(ref);
    return this._withConflicts(args);
  }

  async stashDrop(ref) {
    assertStash(ref);
    await this.run(['stash', 'drop', ref]);
  }

  /** Put a stash commit back on the stash list. */
  async stashStore(hash, message) {
    assertHash(hash);
    await this.run(['stash', 'store', '-m', String(message || 'Restored stash').replace(/[\0\n\r]/g, ' '), hash]);
  }

  // ------------------------------------------------------------ worktrees

  /** Every worktree of this repository, the main one first. */
  async worktrees() {
    const out = await this.text(['worktree', 'list', '--porcelain']);
    const list = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (!line) {
        cur = null;
        continue;
      }
      const sp = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const val = sp === -1 ? '' : line.slice(sp + 1);
      if (key === 'worktree') {
        cur = { path: path.resolve(val), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
        list.push(cur);
      } else if (!cur) continue;
      else if (key === 'HEAD') cur.head = val;
      else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
      else if (key === 'detached') cur.detached = true;
      else if (key === 'bare') cur.bare = true;
      else if (key === 'locked') cur.locked = val || true;
      else if (key === 'prunable') cur.prunable = val || true;
    }
    return list.map((w, i) => ({ ...w, main: i === 0, current: w.path === this.root, exists: fs.existsSync(w.path) }));
  }

  /**
   * A new worktree at `dir`: on an existing branch, on a new branch from
   * `start`, or detached at `start`.
   */
  async addWorktree(dir, { branch = null, newBranch = null, start = 'HEAD' } = {}) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || /[\0\n\r]/.test(dir)) throw new GitError('Choose an absolute folder for the worktree');
    if (fs.existsSync(dir) && (await fsp.readdir(dir)).length) throw new GitError(`${dir} already exists and isn’t empty`);
    const args = ['worktree', 'add'];
    if (newBranch) {
      assertArg(newBranch, 'branch name');
      if (!(await this.validateBranchName(newBranch))) throw new GitError(`"${newBranch}" is not a valid branch name`);
      args.push('-b', newBranch, '--', dir, assertArg(start, 'start point'));
    } else if (branch) args.push('--', dir, assertArg(branch, 'branch'));
    else args.push('--detach', '--', dir, assertArg(start, 'start point'));
    await this.run(args);
    return path.resolve(dir);
  }

  async removeWorktree(dir, { force = false } = {}) {
    const known = (await this.worktrees()).find((w) => w.path === path.resolve(String(dir)));
    if (!known) throw new GitError('That folder isn’t one of this repository’s worktrees');
    if (known.main) throw new GitError('The main worktree can’t be removed');
    await this.run(['worktree', 'remove', ...(force ? ['--force'] : []), '--', known.path]);
  }

  async pruneWorktrees() {
    await this.run(['worktree', 'prune']);
  }

  // ------------------------------------------------------------ submodules

  /** Submodules from .gitmodules, with whether each is set up and at the commit this branch records. */
  async submodules() {
    const gm = path.join(this.root, '.gitmodules');
    if (!fs.existsSync(gm)) return [];
    const cfg = await this.run(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url|branch)$'], { okCodes: [0, 1] });
    const byName = new Map();
    for (const line of cfg.stdout.split('\n')) {
      const m = line.match(/^submodule\.(.+)\.(path|url|branch) (.*)$/);
      if (!m) continue;
      if (!byName.has(m[1])) byName.set(m[1], { name: m[1] });
      byName.get(m[1])[m[2]] = m[3];
    }
    const st = await this.run(['submodule', 'status'], { okCodes: [0, 1, 128] });
    const states = new Map();
    for (const line of st.stdout.split('\n')) {
      const m = line.match(/^([ +\-U])([0-9a-f]{40,64}) (.+?)(?: \((.*)\))?$/);
      if (m) states.set(m[3], { sha: m[2], state: { ' ': 'ok', '+': 'moved', '-': 'missing', U: 'conflict' }[m[1]], describe: m[4] || null });
    }
    return [...byName.values()].filter((s) => s.path).map((s) => ({
      name: s.name,
      path: s.path,
      url: s.url || null,
      branch: s.branch || null,
      ...(states.get(s.path) || { sha: null, state: 'missing', describe: null }),
      root: path.join(this.root, s.path),
    }));
  }

  /** Check submodules out at the commits this branch records (setting up any that aren't yet). */
  async updateSubmodules({ paths = null, onProgress } = {}) {
    if (paths !== null) assertPaths(paths);
    await this.run(['submodule', 'update', '--init', '--recursive', '--progress', ...(paths && paths.length ? ['--', ...paths] : [])], { onProgress, literal: true });
  }

  // ------------------------------------------------------------ Git LFS

  /** Whether this repository keeps files in Git LFS, which patterns, and whether Git LFS is installed. */
  async lfsInfo() {
    let attrs = '';
    try {
      attrs = await fsp.readFile(path.join(this.root, '.gitattributes'), 'utf8');
    } catch {}
    const patterns = attrs.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && /\bfilter=lfs\b/.test(l)).map((l) => l.split(/\s+/)[0]);
    const v = await this.run(['lfs', 'version'], { okCodes: [0, 1, 128] }).catch(() => ({ code: 1, stdout: '' }));
    return { used: patterns.length > 0, patterns, installed: v.code === 0, version: v.code === 0 ? v.stdout.trim() : null };
  }

  /** Keep files matching `pattern` in Git LFS from now on. */
  async lfsTrack(pattern) {
    if (typeof pattern !== 'string' || !pattern.trim() || /[\0\n\r]/.test(pattern) || pattern.startsWith('-')) throw new GitError('Invalid pattern');
    const info = await this.lfsInfo();
    if (!info.installed) {
      const e = new GitError('Git LFS isn’t installed. Install it from git-lfs.com, then try again.');
      e.kind = 'LFS_MISSING';
      throw e;
    }
    await this.run(['lfs', 'install', '--local'], { okCodes: [0, 2] });
    await this.run(['lfs', 'track', pattern.trim()]);
  }

  // ------------------------------------------------------------ snapshots & recovery

  async _commitTree(tree, parents, message) {
    const args = ['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p])];
    return (await this.text(args, { input: message, env: SELF })).trim();
  }

  /**
   * Save uncommitted work, before something throws it away, as a stash-shaped
   * commit (worktree, with the index and untracked files as parents) under
   * refs/gitdonkey/snapshots/. `paths` limits it to those files. Returns
   * { hash, ref, files } or null when there's nothing to save.
   */
  async snapshot(label, { paths = null, kind = 'discard' } = {}) {
    if (paths !== null) assertPaths(paths);
    const st = await this.status();
    const want = paths ? new Set(paths) : null;
    const pick = (list) => (want ? list.filter((f) => want.has(f.path) || (f.oldPath && want.has(f.oldPath))) : list);
    const staged = pick(st.staged);
    const changed = pick(st.unstaged.filter((f) => !f.untracked));
    const conflicted = pick(st.conflicted);
    let untracked = pick(st.unstaged.filter((f) => f.untracked)).map((f) => f.path);
    const files = new Set([...staged, ...changed, ...conflicted].map((f) => f.path).concat(untracked)).size;
    if (!files) return null;
    const head = await this.headHash();
    const gd = await this.gitDir();
    const tmp = path.join(gd, `gitdonkey-snapshot-${process.pid}-${Date.now()}`);
    const idx = (n) => ({ GIT_INDEX_FILE: `${tmp}-${n}` });
    const realIndex = path.join(gd, 'index');
    const skipped = [];
    try {
      // I: the index as it is (or HEAD plus just these files' staged versions).
      const stage0 = async (only) => {
        const out = await this.text(['ls-files', '-s', '-z', ...(only ? ['--', ...only] : [])], { literal: true });
        return out.split('\0').filter((l) => l && / 0\t/.test(l));
      };
      let iTree;
      if (!want && !conflicted.length) iTree = (await this.text(['write-tree'])).trim();
      else {
        if (head) await this.run(['read-tree', head], { env: idx('i') });
        else await this.run(['read-tree', '--empty'], { env: idx('i') });
        const entries = await stage0(want ? staged.map((f) => f.path) : null);
        if (entries.length) await this.run(['update-index', '-z', '--index-info'], { env: idx('i'), input: `${entries.join('\0')}\0` });
        // Staged deletions, and the old side of staged renames.
        const removed = staged.flatMap((f) => [...(f.status === 'D' ? [f.path] : []), ...(f.oldPath ? [f.oldPath] : [])]);
        if (removed.length) await this.run(['update-index', '-z', '--force-remove', '--stdin'], { env: idx('i'), input: `${removed.join('\0')}\0` });
        iTree = (await this.text(['write-tree'], { env: idx('i') })).trim();
      }
      // W: tracked files as they are on disk.
      const base = !want && !conflicted.length ? realIndex : `${tmp}-i`;
      if (fs.existsSync(base)) await fsp.copyFile(base, `${tmp}-w`);
      const trackedPaths = [...new Set([...staged, ...changed, ...conflicted].flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]))];
      const onDisk = trackedPaths.filter((p) => fs.existsSync(this.resolvePath(p)));
      const gone = trackedPaths.filter((p) => !onDisk.includes(p));
      if (onDisk.length) await this.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: idx('w'), input: onDisk.join('\0'), literal: true });
      if (gone.length) await this.run(['update-index', '-z', '--force-remove', '--stdin'], { env: idx('w'), input: `${gone.join('\0')}\0` });
      const wTree = (await this.text(['write-tree'], { env: idx('w') })).trim();
      // U: untracked files, leaving out any too big to keep a copy of.
      let total = 0;
      untracked = untracked.filter((p) => {
        let size = 0;
        try {
          size = fs.statSync(this.resolvePath(p)).size;
        } catch {
          return false;
        }
        if (size > SNAPSHOT_MAX_FILE || total + size > SNAPSHOT_MAX_TOTAL) {
          skipped.push(p);
          return false;
        }
        total += size;
        return true;
      });
      let uCommit = null;
      if (untracked.length) {
        await this.run(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: idx('u'), input: untracked.join('\0'), literal: true });
        const uTree = (await this.text(['write-tree'], { env: idx('u') })).trim();
        uCommit = await this._commitTree(uTree, [], 'untracked files');
      }
      const branch = (await this.run(['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1, 128] })).stdout.trim() || '(no branch)';
      const iCommit = await this._commitTree(iTree, head ? [head] : [], `index on ${branch}`);
      const body = [`files: ${files}`, `kind: ${kind}`, `branch: ${branch}`, ...(skipped.length ? [`skipped: ${skipped.join(', ')}`] : [])].join('\n');
      const subject = `On ${branch}: GitDonkey: ${String(label || 'snapshot').replace(/[\n\r]/g, ' ')}`;
      const hash = await this._commitTree(wTree, [...(head ? [head] : []), iCommit, ...(uCommit ? [uCommit] : [])], `${subject}\n\n${body}\n`);
      const ref = `${SNAPSHOT_REFS}${Date.now()}-${hash.slice(0, 8)}`;
      await this.run(['update-ref', ref, hash]);
      await this.pruneSnapshots();
      return { hash, ref, files, skipped };
    } finally {
      for (const n of ['i', 'w', 'u']) await fsp.rm(`${tmp}-${n}`, { force: true }).catch(() => {});
    }
  }

  /** Keep a stash's commit as a snapshot before it's dropped. */
  async keepStash(ref) {
    assertStash(ref);
    const hash = (await this.text(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    const keep = `${SNAPSHOT_REFS}${Date.now()}-${hash.slice(0, 8)}`;
    await this.run(['update-ref', keep, hash]);
    await this.pruneSnapshots();
    return { hash, ref: keep };
  }

  async pruneSnapshots() {
    const list = await this.snapshots();
    for (const s of list.slice(SNAPSHOT_KEEP)) await this.run(['update-ref', '-d', s.ref], { okCodes: [0, 1] });
  }

  async snapshots() {
    const fmt = ['%(refname)', '%(objectname)', '%(creatordate:unix)', '%(contents)'].join('%1f');
    const out = await this.text(['for-each-ref', '--sort=-refname', `--format=${fmt}%1e`, SNAPSHOT_REFS]);
    return out.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((rec) => {
      const [ref, hash, date, contents = ''] = rec.split(US);
      const lines = contents.split('\n');
      const meta = Object.fromEntries(lines.slice(1).map((l) => l.match(/^(\w+): (.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
      const subject = lines[0] || '';
      const ours = subject.match(/^On ([^:]+): GitDonkey: (.*)$/);
      const stash = !ours && subject.match(/^(?:WIP on|On) ([^:]+): ?(.*)$/);
      return {
        ref,
        hash,
        subject,
        date: Number(date) * 1000,
        label: ours ? ours[2] : stash ? `Dropped stash: ${stash[2] || subject}` : subject,
        branch: ours ? ours[1] : stash ? stash[1] : meta.branch || null,
        kind: ours ? meta.kind || 'discard' : 'stash',
        files: meta.files ? Number(meta.files) : null,
        skipped: meta.skipped ? meta.skipped.split(', ') : [],
      };
    });
  }

  async deleteSnapshot(ref) {
    if (typeof ref !== 'string' || !ref.startsWith(SNAPSHOT_REFS) || /[\0\n\r\s]/.test(ref)) throw new GitError('Invalid snapshot');
    await this.run(['update-ref', '-d', ref]);
  }

  /** Put a snapshot (or any stash-shaped commit) back into the working tree. */
  async restoreSnapshot(hash) {
    assertHash(hash);
    if (!(await this.hasHead())) {
      // No commit yet, so no stash: write the files back (tracked ones staged, untracked ones not).
      const parents = (await this.text(['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
      const files = async (rev) => (await this.text(['ls-tree', '-r', '-z', '--name-only', rev])).split('\0').filter(Boolean);
      if ((await files(hash)).length) await this.run(['checkout', hash, '--', '.']);
      const u = parents[1];
      const loose = u ? await files(u) : [];
      if (loose.length) {
        await this.run(['checkout', u, '--', '.']);
        await this.run(['rm', '--cached', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: loose.join('\0'), literal: true });
      }
      return { conflicts: false };
    }
    try {
      return await this._withConflicts(['stash', 'apply', '--index', hash]);
    } catch (e) {
      // The staged part didn't apply cleanly on top of what's staged now: bring the files back unstaged.
      if (/Conflicts in index|could not restore|patch does not apply|Try without --index/i.test(`${e.message}\n${e.stderr || ''}`)) {
        return this._withConflicts(['stash', 'apply', hash]);
      }
      throw e;
    }
  }

  /**
   * Commits HEAD was on that no branch, tag or remote branch reaches any more
   * (after a hard reset, a rebase, or deleting a branch you'd checked out),
   * newest first, with what moved HEAD away from each.
   */
  async lostCommits({ max = 400 } = {}) {
    if (!(await this.hasHead())) return [];
    const r = await this.run(['reflog', 'show', '-z', `-n${Number(max) | 0}`, '--format=%H%x1f%gs%x1f%ct', 'HEAD', '--'], { okCodes: [0, 128] });
    if (r.code !== 0) return [];
    const entries = r.stdout.split('\0').filter(Boolean).map((e) => {
      const [hash, action, ct] = e.split(US);
      return { hash, action, date: Number(ct) * 1000 };
    });
    const candidates = [...new Set(entries.map((e) => e.hash))];
    if (!candidates.length) return [];
    return this._lostTips(candidates, (tip) => {
      const k = entries.findIndex((e) => e.hash === tip);
      const away = k > 0 ? entries[k - 1] : null;
      return away ? { lostBy: away.action, lostAt: away.date } : {};
    });
  }

  /** Of these commits, the ones nothing reaches, as tips with how many commits hang off each. */
  async _lostTips(candidates, describe) {
    const out = await this.text(['rev-list', '--parents', '--max-count=5000', '--ignore-missing', '--stdin', '--not', '--branches', '--tags', '--remotes', '--glob=refs/stash'], { input: `${candidates.join('\n')}\n`, okCodes: [0] })
      .catch(() => '');
    const parentsOf = new Map();
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [c, ...ps] = line.split(' ');
      parentsOf.set(c, ps);
    }
    const isParent = new Set([...parentsOf.values()].flat());
    const tips = candidates.filter((c) => parentsOf.has(c) && !isParent.has(c));
    if (!tips.length) return [];
    const count = (tip) => {
      const seen = new Set();
      const stack = [tip];
      while (stack.length) {
        const c = stack.pop();
        if (seen.has(c) || !parentsOf.has(c)) continue;
        seen.add(c);
        stack.push(...parentsOf.get(c));
      }
      return seen.size;
    };
    const info = parseLog(await this.text(['log', '--no-walk=unsorted', '--ignore-missing', '-z', '--stdin', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s'], { input: `${tips.join('\n')}\n` }));
    return info.map((c) => ({ ...c, commits: count(c.hash), stashLike: c.parents.length >= 2 && STASH_SUBJECT.test(c.subject), ...describe(c.hash) }))
      .sort((a, b) => (b.lostAt || b.date) - (a.lostAt || a.date));
  }

  /** A slower, deeper look (git fsck): commits nothing points to, including dropped stashes. */
  async danglingCommits() {
    const r = await this.run(['fsck', '--no-reflogs', '--no-progress', '--dangling'], { okCodes: [0, 1, 2, 3, 4, 5, 6, 7], maxBuffer: 64 * 1024 * 1024 });
    const hashes = [...`${r.stdout}\n${r.stderr}`.matchAll(/^dangling commit ([0-9a-f]{40,64})$/gm)].map((m) => m[1]);
    if (!hashes.length) return [];
    const info = parseLog(await this.text(['log', '--no-walk=unsorted', '-z', '--stdin', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%s'], { input: `${hashes.slice(0, 500).join('\n')}\n` }));
    // Our own snapshot pieces (index / untracked commits) are reachable; anything with our identity left over isn't interesting.
    return info.filter((c) => c.email !== SELF.GIT_AUTHOR_EMAIL || STASH_SUBJECT.test(c.subject))
      .map((c) => ({ ...c, commits: 1, stashLike: c.parents.length >= 2 && STASH_SUBJECT.test(c.subject) }))
      .sort((a, b) => b.date - a.date);
  }

  // ------------------------------------------------------------ remotes

  async fetch({ remote = null, prune = true, onProgress } = {}) {
    const args = ['fetch', '--progress', '--tags'];
    if (prune) args.push('--prune');
    if (remote) args.push(assertArg(remote, 'remote'));
    else args.push('--all');
    await this.run(args, { onProgress });
  }

  async pull({ mode = 'merge', onProgress } = {}) {
    const args = ['pull', '--progress'];
    if (mode === 'ff-only') args.push('--ff-only');
    else if (mode === 'rebase') args.push('--rebase', '--autostash');
    else args.push('--no-rebase');
    return this._withConflicts(args, { onProgress });
  }

  async push({ remote, branch, remoteBranch = null, setUpstream = false, force = false, onProgress } = {}) {
    assertArg(remote, 'remote');
    assertArg(branch, 'branch');
    const args = ['push', '--progress'];
    if (setUpstream) args.push('--set-upstream');
    if (force) args.push('--force-with-lease');
    args.push(remote, `refs/heads/${branch}:refs/heads/${remoteBranch ? assertArg(remoteBranch, 'remote branch') : branch}`);
    const r = await this.run(args, { onProgress });
    return { output: cleanMessage(r.stderr, r.stdout) };
  }

  async deleteRemoteBranch(remote, branch) {
    assertArg(remote, 'remote');
    assertArg(branch, 'branch');
    await this.run(['push', remote, '--delete', `refs/heads/${branch}`]);
  }

  async addRemote(name, url) {
    assertArg(name, 'remote name');
    assertArg(url, 'remote URL');
    await this.run(['remote', 'add', name, url]);
  }

  async removeRemote(name) {
    assertArg(name, 'remote name');
    await this.run(['remote', 'remove', name]);
  }

  async renameRemote(oldName, newName) {
    assertArg(oldName, 'remote name');
    assertArg(newName, 'remote name');
    await this.run(['remote', 'rename', oldName, newName]);
  }

  async setRemoteUrl(name, url) {
    assertArg(name, 'remote name');
    assertArg(url, 'remote URL');
    await this.run(['remote', 'set-url', name, url]);
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- repo-level

async function resolveRoot(dir) {
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return null;
    const r = await runGit(dir, ['rev-parse', '--show-toplevel'], { okCodes: [0, 128] });
    const out = r.stdout.trim();
    return r.code === 0 && out ? path.resolve(out) : null;
  } catch {
    return null;
  }
}

async function initRepo(dir, { branch = 'main', readme = false, name } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new GitError('Choose an absolute folder');
  await fsp.mkdir(dir, { recursive: true });
  const b = branch && branch.trim() ? branch.trim() : 'main';
  if (b.startsWith('-')) throw new GitError('Invalid branch name');
  await runGit(dir, ['init', '-q', `--initial-branch=${b}`]);
  if (readme) {
    const file = path.join(dir, 'README.md');
    if (!fs.existsSync(file)) await fsp.writeFile(file, `# ${name || path.basename(dir)}\n`);
    await runGit(dir, ['add', 'README.md']);
    await runGit(dir, ['commit', '-q', '-m', 'Initial commit']);
  }
  return (await resolveRoot(dir)) || dir;
}

async function cloneRepo(url, dest, { onProgress } = {}) {
  assertArg(url, 'URL');
  if (typeof dest !== 'string' || !path.isAbsolute(dest)) throw new GitError('Choose an absolute destination folder');
  if (fs.existsSync(dest) && (await fsp.readdir(dest)).length) throw new GitError(`Destination ${dest} already exists and is not empty`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await runGit(path.dirname(dest), ['clone', '--progress', url, dest], { onProgress });
  return (await resolveRoot(dest)) || dest;
}

/** Keys this computer could sign commits with: SSH public keys, and GPG secret keys when gpg is installed. */
async function signingKeys() {
  const ssh = [];
  const dir = path.join(os.homedir(), '.ssh');
  try {
    for (const f of (await fsp.readdir(dir)).filter((n) => n.endsWith('.pub')).sort()) {
      const text = (await fsp.readFile(path.join(dir, f), 'utf8')).trim();
      const [type, , ...comment] = text.split(/\s+/);
      if (/^(ssh-|ecdsa-|sk-)/.test(type || '')) ssh.push({ path: path.join(dir, f), type, comment: comment.join(' ') });
    }
  } catch {}
  const gpg = [];
  const exe = [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATHS, '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/MacGPG2/bin']
    .map((d) => path.join(d, process.platform === 'win32' ? 'gpg.exe' : 'gpg')).find((p) => p && fs.existsSync(p));
  if (exe) {
    const out = await new Promise((resolve) => {
      let buf = '';
      const child = spawn(exe, ['--list-secret-keys', '--with-colons'], { env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => child.kill(), 6000);
      child.stdout.on('data', (d) => {
        buf += d;
      });
      child.on('error', () => resolve(''));
      child.on('close', () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    let cur = null;
    for (const line of out.split('\n')) {
      const f = line.split(':');
      if (f[0] === 'sec') {
        cur = { id: f[4], uid: '' };
        gpg.push(cur);
      } else if (f[0] === 'uid' && cur && !cur.uid) cur.uid = f[9];
    }
  }
  return { ssh, gpg, gpgInstalled: Boolean(exe) };
}

/** Path of an authenticated GitHub CLI, or null. */
async function detectGitHubCli() {
  const names = process.platform === 'win32' ? ['gh.exe'] : ['gh'];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATHS, '/opt/homebrew/bin', '/usr/local/bin',
    ...(process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI')] : [])];
  let gh = null;
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (d && fs.existsSync(p)) {
        gh = p;
        break;
      }
    }
    if (gh) break;
  }
  if (!gh) return null;
  const ok = await new Promise((resolve) => {
    const child = spawn(gh, ['auth', 'status', '--hostname', 'github.com'], { env: gitEnv(), stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return ok ? gh : null;
}

/** Git config that lets an authenticated GitHub CLI answer github.com logins. */
function githubCliCredentialConfig(gh) {
  const quoted = `"${gh.split(path.sep).join('/')}"`;
  return ['-c', `credential.https://github.com.helper=!${quoted} auth git-credential`, '-c', `credential.https://gist.github.com.helper=!${quoted} auth git-credential`];
}

/** Credential helpers configured outside any repository (system + global). */
async function credentialHelpers() {
  const r = await runGit(os.homedir(), ['config', '--get-all', 'credential.helper'], { okCodes: [0, 1] }).catch(() => ({ stdout: '' }));
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Turn on the platform's secure store so logins are remembered. */
async function enableCredentialHelper() {
  if ((await credentialHelpers()).length) return false;
  const helper = process.platform === 'darwin' ? 'osxkeychain' : process.platform === 'win32' ? 'manager' : 'cache --timeout=86400';
  await runGit(os.homedir(), ['config', '--global', 'credential.helper', helper]);
  return true;
}

module.exports = {
  configureGit,
  detectGitHubCli,
  githubCliCredentialConfig,
  credentialHelpers,
  enableCredentialHelper,
  GitRepo,
  GitError,
  signingKeys,
  runGit,
  resolveRoot,
  initRepo,
  cloneRepo,
  parseStatus,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseBlame,
  cleanMessage,
  classifyError,
  SNAPSHOT_REFS,
};
