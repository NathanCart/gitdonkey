'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, git, write, commitFile, newRepo } = require('./helpers');
const { GitRepo } = require('../../src/main/git');

// Local paths as submodule URLs need the file transport allowed.
const sub = (cwd, ...args) => git(cwd, '-c', 'protocol.file.allow=always', ...args);

test('submodules: listed with their state, changes shown in status, set up on demand', async () => {
  const lib = newRepo();
  commitFile(lib, 'lib.txt', 'v1\n', 'lib v1');
  const app = newRepo();
  commitFile(app, 'app.txt', 'a\n', 'app');
  sub(app, 'submodule', 'add', '-q', lib, 'vendor/lib');
  git(app, 'commit', '-q', '-m', 'add lib');
  const repo = new GitRepo(app);
  let [s] = await repo.submodules();
  assert.deepEqual([s.name, s.path, s.url, s.state], ['vendor/lib', 'vendor/lib', lib, 'ok']);
  assert.equal(s.root, path.join(app, 'vendor/lib'));

  // New commits and an untracked file inside: the status says so.
  commitFile(path.join(app, 'vendor/lib'), 'lib.txt', 'v2\n', 'lib v2');
  write(path.join(app, 'vendor/lib'), 'scratch.txt', 'x\n');
  const st = await repo.status();
  assert.deepEqual(st.unstaged.map((f) => [f.path, f.submodule]), [['vendor/lib', { commits: true, changes: false, untracked: true }]]);
  [s] = await repo.submodules();
  assert.equal(s.state, 'moved');
  await repo.updateSubmodules({ paths: ['vendor/lib'] });
  [s] = await repo.submodules();
  assert.equal(s.state, 'ok', 'back at the recorded commit');

  // A fresh clone has it, but not set up.
  const parent = tmpDir('clone');
  const clone = path.join(parent, 'app');
  git(parent, 'clone', '-q', app, clone);
  const c = new GitRepo(clone);
  [s] = await c.submodules();
  assert.equal(s.state, 'missing');
  fs.writeFileSync(path.join(require('./helpers').HOME, '.gitconfig'), `${fs.readFileSync(path.join(require('./helpers').HOME, '.gitconfig'), 'utf8')}[protocol "file"]\n\tallow = always\n`);
  await c.updateSubmodules();
  [s] = await c.submodules();
  assert.equal(s.state, 'ok');
  assert.equal(fs.readFileSync(path.join(clone, 'vendor/lib/lib.txt'), 'utf8'), 'v1\n');
  assert.deepEqual(await new GitRepo(lib).submodules(), [], 'no .gitmodules, no submodules');
});

test('Git LFS: noticed from .gitattributes, and tracking asks for it to be installed', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  let info = await repo.lfsInfo();
  assert.equal(info.used, false);
  write(dir, '.gitattributes', '# big files\n*.psd filter=lfs diff=lfs merge=lfs -text\n*.txt text\nassets/** filter=lfs diff=lfs merge=lfs -text\n');
  info = await repo.lfsInfo();
  assert.equal(info.used, true);
  assert.deepEqual(info.patterns, ['*.psd', 'assets/**']);
  if (!info.installed) await assert.rejects(repo.lfsTrack('*.mov'), (e) => e.kind === 'LFS_MISSING');
  await assert.rejects(repo.lfsTrack('--all'), /Invalid pattern/);
});
