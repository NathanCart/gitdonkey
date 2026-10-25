'use strict';

// electron-builder afterSign hook: sign the Mac app with GitDonkey's own
// certificate (made by make-signing-cert.sh), so every release carries the
// same signature and macOS keeps trusting it across updates ("Always Allow"
// on the keychain prompt sticks). Without the certificate the app stays
// ad-hoc signed, as before.
//
// The certificate goes into a throwaway keychain for the signing. codesign
// only finds identities in keychains on the search list, so it joins the
// list (after the user's own) while signing, and the list is put back and the
// keychain deleted after. The login keychain itself is never touched.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'GitDonkey Self-Signed';

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const dir = process.env.GITDONKEY_SIGNING_DIR || path.join(os.homedir(), '.gitdonkey-signing');
  const p12 = path.join(dir, 'gitdonkey-signing.p12');
  if (!fs.existsSync(p12)) {
    console.warn('  • no GitDonkey signing certificate: leaving the app ad-hoc signed (make one with npm run signing:create)');
    return;
  }
  const password = fs.readFileSync(path.join(dir, 'password'), 'utf8').trim();
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const keychain = path.join(os.tmpdir(), `gitdonkey-sign-${process.pid}-${Date.now()}.keychain-db`);
  const pass = crypto.randomBytes(16).toString('hex');
  const searchList = run('security', ['list-keychains', '-d', 'user']).split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  run('security', ['create-keychain', '-p', pass, keychain]);
  try {
    run('security', ['list-keychains', '-d', 'user', '-s', ...searchList, keychain]);
    run('security', ['set-keychain-settings', keychain]);
    run('security', ['unlock-keychain', '-p', pass, keychain]);
    run('security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', pass, keychain]);
    const { sign } = await import('@electron/osx-sign');
    await sign({
      app,
      identity: NAME,
      keychain,
      identityValidation: false,
      platform: 'darwin',
      preAutoEntitlements: false,
      // As before: no hardened runtime (it would need notarisation to mean anything), and no
      // timestamp (Apple's server only stamps Apple-issued certificates).
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
    });
  } finally {
    run('security', ['list-keychains', '-d', 'user', '-s', ...searchList]);
    try {
      run('security', ['delete-keychain', keychain]);
    } catch {
      fs.rmSync(keychain, { force: true });
    }
  }
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const req = run('codesign', ['-d', '-r-', app]).trim().split('\n').pop();
  console.log(`  • signed ${path.basename(app)} as ${NAME} (${context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : context.arch})\n    ${req}`);
};
