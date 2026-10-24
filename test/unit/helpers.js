'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Isolate from the developer's git config.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdonkey-home-'));
process.env.HOME = HOME;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test User';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test User';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
fs.writeFileSync(path.join(HOME, '.gitconfig'), '[init]\n\tdefaultBranch = main\n[user]\n\tname = Test User\n\temail = test@example.com\n');

let seq = 0;
function tmpDir(prefix = 'repo') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gitdonkey-${prefix}-${seq++}-`)));
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(repo, file, content) {
  const abs = path.join(repo, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(repo, file) {
  return fs.readFileSync(path.join(repo, file), 'utf8');
}

function commitFile(repo, file, content, message) {
  write(repo, file, content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message || `update ${file}`);
  return git(repo, 'rev-parse', 'HEAD');
}

function newRepo() {
  const dir = tmpDir();
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

module.exports = { tmpDir, git, write, read, commitFile, newRepo, HOME };
