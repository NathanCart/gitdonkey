'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AvatarService, avatarCandidates, isEmail } = require('../../src/main/avatars');

test('avatar candidates: GitHub noreply first, Gravatar always', () => {
  const gh = avatarCandidates('583231+octocat@users.noreply.github.com', 64);
  assert.equal(gh[0], 'https://avatars.githubusercontent.com/u/583231?s=64&v=4');
  assert.match(gh[1], /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?s=64&d=404$/);
  const legacy = avatarCandidates('octocat@users.noreply.github.com');
  assert.equal(legacy[0], 'https://github.com/octocat.png?size=96');
  const plain = avatarCandidates('  Ada@Example.com ');
  assert.equal(plain.length, 1);
  // Gravatar hashes the trimmed, lower-cased address.
  assert.match(plain[0], /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?s=96&d=404$/);
  assert.equal(plain[0], avatarCandidates('ada@example.com')[0]);
  assert.equal(isEmail('nope'), false);
  assert.equal(isEmail('a@b.c'), true);
});

function fakeFetch(map, calls) {
  return async (url) => {
    calls.push(url);
    const hit = Object.entries(map).find(([k]) => url.startsWith(k));
    if (!hit) return { ok: false, headers: new Map([['content-type', 'text/html']]), arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from(hit[1]);
    return { ok: true, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };
}

test('avatar service: falls back across sources, caches hits and misses on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdonkey-avatars-'));
  const calls = [];
  const svc = new AvatarService(dir, fakeFetch({ 'https://www.gravatar.com/': 'PNGDATA' }, calls));
  const url = await svc.get('ada@example.com');
  assert.equal(url, `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`);
  assert.equal(await svc.get('ADA@example.com '), url, 'normalised key hits the memory cache');
  assert.equal(calls.length, 1);

  const svc2 = new AvatarService(dir, fakeFetch({}, calls));
  assert.equal(await svc2.get('ada@example.com'), url, 'disk cache survives a restart');
  assert.equal(calls.length, 1);

  assert.equal(await svc2.get('nobody@example.com'), null);
  const after = calls.length;
  const svc3 = new AvatarService(dir, fakeFetch({ 'https://www.gravatar.com/': 'LATE' }, calls));
  assert.equal(await svc3.get('nobody@example.com'), null, 'misses are cached too');
  assert.equal(calls.length, after);

  const offline = new AvatarService(dir, fakeFetch({}, calls), { offline: true });
  assert.equal(await offline.get('someone@example.com'), null);
  assert.equal(await svc.get('not-an-email'), null);
  // Concurrent requests for the same author share one download.
  const calls2 = [];
  const svc4 = new AvatarService(fs.mkdtempSync(path.join(os.tmpdir(), 'gitdonkey-avatars-')), fakeFetch({ 'https://avatars.githubusercontent.com/': 'GH' }, calls2));
  const [a, b] = await Promise.all([svc4.get('1+x@users.noreply.github.com'), svc4.get('1+x@users.noreply.github.com')]);
  assert.equal(a, b);
  assert.equal(calls2.length, 1);
});
