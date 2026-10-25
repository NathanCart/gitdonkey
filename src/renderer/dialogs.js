// Task dialogs: clone, init, settings, identity, upstream, remotes, tags,
// branches, interactive rebase, shortcuts.
import { h, icon, clear, legend, kbd, logoMark } from './dom.js';
import { openModal, formDialog, confirmDialog, field, toast } from './ui.js';
import { git, invoke, on, kb, sep, isAbsolutePath, isMac } from './api.js';
import { guessRepoName, shortHash, relativeTime, pluralize } from './lib/util.js';
import { themesDialog } from './themes-ui.js';

const pickFolder = (current) => invoke('dialog:pickFolder', { defaultPath: current || undefined, title: 'Choose a folder' });

function joinPath(dir, name) {
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

// ---------------------------------------------------------------- clone

export async function cloneDialog(app, { url = '' } = {}) {
  const home = app.info?.home || '';
  const parent = app.lastParentDir || (home ? `${home}${sep}Developer` : '');
  let nameTouched = false;
  const values = await formDialog({
    title: 'Clone a repository',
    okLabel: 'Clone',
    width: 540,
    pickFolder,
    fields: [
      { name: 'url', label: 'Repository URL', placeholder: 'git@github.com:team/project.git or https://…', value: url, mono: true },
      { name: 'parent', label: 'Clone into folder', type: 'folder', value: parent, mono: true },
      { name: 'name', label: 'Folder name', value: guessRepoName(url), mono: true, hint: 'Created inside the folder above.' },
    ],
    onChange: (v, inputs) => {
      if (document.activeElement === inputs.name) nameTouched = true;
      if (!nameTouched) inputs.name.value = guessRepoName(v.url);
    },
    validate: (v) => {
      if (!v.url.trim()) return 'Enter a repository URL.';
      if (!isAbsolutePath(v.parent)) return 'Choose a folder to clone into.';
      if (!v.name.trim() || /[/\\]/.test(v.name.trim())) return 'Enter a folder name without slashes.';
      return null;
    },
  });
  if (!values) return;
  app.lastParentDir = values.parent.trim();
  const dest = joinPath(values.parent.trim(), values.name.trim());
  const phase = h('div', { class: 'progress-phase' }, 'Connecting…');
  const fill = h('span', { class: 'mp-fill', style: { width: '0%' } });
  const modal = openModal({
    title: 'Cloning',
    dismissable: false,
    body: h('div', { class: 'stack' }, h('div', { class: 'progress-target mono' }, values.url.trim()), h('span', { class: 'mp-track wide' }, fill), phase),
    actions: [],
  });
  const off = on('clone:progress', (p) => {
    phase.textContent = p.text;
    if (p.percent !== null && p.percent !== undefined) fill.style.width = `${p.percent}%`;
  });
  try {
    const res = await invoke('repo:clone', { url: values.url.trim(), dest });
    modal.close();
    toast({ type: 'success', title: 'Cloned', message: res.root });
    await app.openRepo(res.root);
  } catch (e) {
    modal.close();
    toast({ type: 'error', title: 'Clone failed', message: e.message, actions: [{ label: 'Try again', run: () => cloneDialog(app, { url: values.url }) }] });
  } finally {
    off();
  }
}

// ---------------------------------------------------------------- init

export async function initDialog(app) {
  const home = app.info?.home || '';
  const values = await formDialog({
    title: 'Start a new repository',
    okLabel: 'Create repository',
    width: 520,
    pickFolder,
    fields: [
      { name: 'parent', label: 'Create in folder', type: 'folder', value: app.lastParentDir || (home ? `${home}${sep}Developer` : ''), mono: true },
      { name: 'name', label: 'Repository name', placeholder: 'my-project', mono: true },
      { name: 'branch', label: 'Default branch', value: 'main', mono: true },
      { name: 'readme', type: 'checkbox', label: 'Add a README and make the first commit', value: true },
    ],
    validate: (v) => {
      if (!isAbsolutePath(v.parent)) return 'Choose a folder.';
      if (!v.name.trim() || /[/\\]/.test(v.name.trim())) return 'Enter a name without slashes.';
      if (!v.branch.trim()) return 'Enter a default branch name.';
      return null;
    },
  });
  if (!values) return;
  app.lastParentDir = values.parent.trim();
  try {
    const res = await invoke('repo:init', { dir: joinPath(values.parent.trim(), values.name.trim()), branch: values.branch.trim(), readme: values.readme, name: values.name.trim() });
    await app.openRepo(res.root);
    toast({ type: 'success', title: 'Repository created', message: res.root });
  } catch (e) {
    if (e.kind === 'NO_IDENTITY') {
      toast({ type: 'warn', title: 'Set your Git identity first', message: 'The first commit needs a name and email.' });
      await identityDialog(app);
    } else toast({ type: 'error', title: 'Could not create repository', message: e.message });
  }
}

// ---------------------------------------------------------------- settings & identity

export async function identityDialog(app, { required = false } = {}) {
  const id = app.repo ? await git(app.repo, 'identity').catch(() => ({})) : {};
  const values = await formDialog({
    title: required ? 'Who is committing?' : 'Git identity',
    okLabel: 'Save',
    fields: [
      { name: 'name', label: 'Name', value: id.globalName || id.name || '', placeholder: 'Ada Lovelace' },
      { name: 'email', label: 'Email', value: id.globalEmail || id.email || '', placeholder: 'ada@example.com', hint: 'Saved to your global Git config and used for every commit.' },
    ],
    validate: (v) => (!v.name.trim() ? 'Enter your name.' : !/^[^\s@]+@[^\s@]+$/.test(v.email.trim()) ? 'Enter a valid email address.' : null),
  });
  if (!values) return false;
  try {
    await git(app.repo, 'setIdentity', { name: values.name, email: values.email, global: true });
    toast({ type: 'success', title: 'Identity saved', message: `${values.name} <${values.email}>` });
    return true;
  } catch (e) {
    toast({ type: 'error', title: 'Could not save identity', message: e.message });
    return false;
  }
}

export async function settingsDialog(app) {
  const id = app.repo ? await git(app.repo, 'identity').catch(() => ({})) : {};
  const s = app.settings;
  const themeHint = h('div', { class: 'field-hint' }, app.theme().name);
  const values = await formDialog({
    title: 'Settings',
    okLabel: 'Save',
    width: 520,
    fields: [
      ...(app.repo ? [
        { name: 'name', label: 'Commit name (global)', value: id.globalName || '' },
        { name: 'email', label: 'Commit email (global)', value: id.globalEmail || '' },
      ] : []),
      { name: 'pullMode', label: 'Pull button', type: 'select', value: s.pullMode, options: [
        { value: 'merge', label: 'Fast-forward if possible, otherwise merge' },
        { value: 'ff-only', label: 'Fast-forward only' },
        { value: 'rebase', label: 'Rebase local commits' },
      ] },
      { name: 'autoFetch', label: 'Fetch automatically', type: 'select', value: String(s.autoFetch || 0), options: [
        { value: '0', label: 'Never' }, { value: '1', label: 'Every minute' }, { value: '5', label: 'Every 5 minutes' },
        { value: '15', label: 'Every 15 minutes' }, { value: '30', label: 'Every 30 minutes' },
      ] },
      { name: 'avatars', type: 'checkbox', label: 'Show author avatars', value: s.avatars !== false, hint: 'Pictures come from GitHub and Gravatar, looked up by a hash of each author’s email.' },
      { name: 'donkey', type: 'checkbox', label: 'Show the donkey', value: s.donkey !== false, hint: 'A 3D donkey in the bottom-left corner who comments on what you do in Git. Click, double-click, pet or right-click him.' },
      { name: 'checkUpdates', type: 'checkbox', label: 'Check for updates automatically', value: s.checkUpdates !== false, hint: `You have GitDonkey ${app.info.version}. It looks for a new release on GitHub at launch and every few hours.` },
      { name: 'confirmDiscard', type: 'checkbox', label: 'Ask before discarding changes', value: s.confirmDiscard !== false },
    ],
    extra: h('div', { class: 'settings-extra' },
      h('div', { class: 'settings-ai' },
        h('div', null, h('div', { class: 'field-label' }, 'Theme'), themeHint),
        h('button', { type: 'button', class: 'btn btn-small', dataset: { action: 'themes' }, onClick: () => themesDialog(app).then(() => {
          themeHint.textContent = app.theme().name;
        }) }, 'Change…')),
      h('div', { class: 'settings-ai' },
        h('div', null, h('div', { class: 'field-label' }, 'AI commit messages'), h('div', { class: 'field-hint' }, app.aiConfig() ? app.aiConfig().label : 'Off')),
        h('button', { type: 'button', class: 'btn btn-small', onClick: () => aiSettingsDialog(app) }, app.aiConfig() ? 'Change…' : 'Set up…'))),
    validate: (v) => (app.repo && v.email && !/^[^\s@]+@[^\s@]+$/.test(v.email.trim()) ? 'Enter a valid email address.' : null),
  });
  if (!values) return;
  app.setSetting('pullMode', values.pullMode, { silent: true });
  app.setSetting('autoFetch', Number(values.autoFetch), { silent: true });
  app.setSetting('confirmDiscard', values.confirmDiscard, { silent: true });
  if ((s.checkUpdates !== false) !== values.checkUpdates) {
    app.setSetting('checkUpdates', values.checkUpdates, { silent: true });
    if (values.checkUpdates) invoke('update:check').catch(() => {});
  }
  if ((s.avatars !== false) !== values.avatars) app.setSetting('avatars', values.avatars);
  if ((s.donkey !== false) !== values.donkey) app.setSetting('donkey', values.donkey);
  app.applyAutoFetch();
  if (app.repo && values.name.trim() && values.email.trim() && (values.name !== id.globalName || values.email !== id.globalEmail)) {
    await git(app.repo, 'setIdentity', { name: values.name, email: values.email, global: true }).catch((e) => toast({ type: 'error', title: 'Could not save identity', message: e.message }));
  }
  toast({ type: 'success', title: 'Settings saved' });
}

// ---------------------------------------------------------------- AI commit messages

/** Choose a provider, paste your own key, pick a model. */
/** The system wouldn't encrypt the key (on macOS, the Keychain prompt was declined), so it's only kept until quitting. */
export function keychainToast() {
  toast({
    type: 'warn',
    title: 'Key kept until you quit',
    message: isMac
      ? 'macOS didn’t let GitDonkey use the Keychain (that’s the prompt you declined), so the key works now but isn’t saved. Reopen GitDonkey and click Always Allow to save it.'
      : 'This system has no secure storage for GitDonkey to save the key in, so it works until you quit.',
    actions: isMac ? [{ label: 'Reopen GitDonkey', run: () => invoke('app:relaunch') }] : [],
    timeout: 0,
  });
}

export async function aiSettingsDialog(app, { thenGenerate = false } = {}) {
  const providers = await invoke('ai:providers').catch(() => []);
  app.aiProviders = providers;
  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  const cur = app.settings.ai || {};
  const models = { ...(cur.models || {}) };
  const baseUrls = { ...(cur.baseUrls || {}) };
  const forget = new Set();
  let shown = null;
  let inputs = null;

  const suggestions = h('datalist', { id: 'ai-model-list' });
  const status = h('span', { class: 'ai-status', role: 'status' });
  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle('bad', bad);
  };
  const loadBtn = h('button', { type: 'button', class: 'btn btn-small' }, 'Check key and load models');
  const forgetBtn = h('button', { type: 'button', class: 'btn btn-small btn-danger' }, 'Forget saved key');
  const rowOf = (name) => inputs[name].closest('.field');

  const sync = (v, ins) => {
    inputs = ins;
    const p = byId[v.provider];
    // Remember what was typed for the provider we're leaving.
    if (shown && shown !== v.provider && byId[shown]) {
      models[shown] = ins.model.value.trim();
      if (byId[shown].customBase) baseUrls[shown] = ins.baseUrl.value.trim();
    }
    if (shown !== v.provider) {
      shown = v.provider;
      ins.model.value = p ? models[p.id] || '' : '';
      ins.baseUrl.value = p && p.customBase ? baseUrls[p.id] || '' : '';
      ins.key.value = '';
      suggestions.textContent = '';
      say('');
    }
    ins.model.setAttribute('list', 'ai-model-list');
    const saved = p && p.hasKey && !forget.has(p.id);
    rowOf('key').hidden = !p || (!p.needsKey && !p.optionalKey);
    rowOf('baseUrl').hidden = !p || !p.customBase;
    rowOf('model').hidden = !p;
    rowOf('instructions').hidden = !p;
    loadBtn.parentElement.hidden = !p;
    forgetBtn.hidden = !saved;
    if (!p) return;
    ins.key.placeholder = saved ? 'Saved. Paste a new key to replace it.' : p.optionalKey ? 'Only if the endpoint needs one' : `Paste your ${p.name} API key`;
    const keyHint = rowOf('key').querySelector('.field-hint');
    keyHint.textContent = p.keyUrl ? `Encrypted with your system keychain and only sent to ${p.name}. Get a key at ${p.keyUrl.replace(/^https:\/\//, '')}` : 'Encrypted with your system keychain.';
    ins.model.placeholder = p.model ? `${p.model} (default)` : 'Model id';
    ins.baseUrl.placeholder = p.id === 'ollama' ? p.base : 'http://localhost:1234/v1';
  };

  loadBtn.addEventListener('click', async () => {
    const p = byId[shown];
    if (!p) return;
    say('Asking…');
    loadBtn.disabled = true;
    try {
      const ids = await invoke('ai:models', { provider: p.id, key: inputs.key.value, baseUrl: inputs.baseUrl.value });
      clear(suggestions).append(...ids.map((id) => h('option', { value: id })));
      const ok = p.needsKey || inputs.key.value.trim() ? 'Key works.' : 'Connected.';
      say(ids.length ? `${ok} ${pluralize(ids.length, 'model')} to choose from: start typing in Model.` : `${ok} It listed no models, so type a model id.`);
    } catch (e) {
      say(e.message, true);
    } finally {
      loadBtn.disabled = false;
    }
  });
  forgetBtn.addEventListener('click', () => {
    forget.add(shown);
    forgetBtn.hidden = true;
    sync({ provider: shown }, inputs);
    say('The saved key will be removed when you save.');
  });

  const values = await formDialog({
    title: 'AI commit messages',
    okLabel: 'Save',
    width: 560,
    intro: h('p', { class: 'modal-text' }, 'Generate writes the commit message from your staged changes. When you press it, GitDonkey sends the staged diff (trimmed), file names, branch name and recent commit subjects to the provider you choose, with your own key. Nothing is sent until you press it.'),
    fields: [
      { name: 'provider', label: 'Provider', type: 'select', value: cur.provider && byId[cur.provider] ? cur.provider : '', options: [{ value: '', label: 'Off' }, ...providers.map((p) => ({ value: p.id, label: p.name }))] },
      { name: 'key', label: 'API key', type: 'password', hint: ' ' },
      { name: 'baseUrl', label: 'Base URL', mono: true },
      { name: 'model', label: 'Model', mono: true, hint: 'Leave empty for the default. Any model id the provider accepts works.' },
      { name: 'instructions', label: 'Extra instructions (optional)', type: 'textarea', rows: 3, value: cur.instructions || '', placeholder: 'For example: Use Conventional Commits. Keep the body under three lines.' },
    ],
    extra: h('div', { class: 'ai-tools' }, loadBtn, forgetBtn, status, suggestions),
    onChange: sync,
    validate: (v) => {
      const p = byId[v.provider];
      if (!p) return null;
      if (p.needsKey && !v.key.trim() && (!p.hasKey || forget.has(p.id))) return `Paste your ${p.name} API key.`;
      if (p.customBase && p.id === 'custom' && !/^https?:\/\/\S+/.test(v.baseUrl.trim())) return 'Enter the endpoint’s base URL, like http://localhost:1234/v1.';
      if (p.customBase && v.baseUrl.trim() && !/^https?:\/\/\S+/.test(v.baseUrl.trim())) return 'The base URL should start with http:// or https://.';
      if (!p.model && !v.model.trim()) return 'Enter the model id to use.';
      return null;
    },
  });
  if (!values) return;
  const p = byId[values.provider];
  if (p) {
    models[p.id] = values.model.trim();
    if (p.customBase) baseUrls[p.id] = values.baseUrl.trim();
  }
  let keptForSession = false;
  try {
    for (const id of forget) await invoke('ai:setKey', id, null);
    if (p && values.key.trim()) keptForSession = (await invoke('ai:setKey', p.id, values.key.trim())) === 'session';
  } catch (e) {
    toast({ type: 'error', title: 'Couldn’t save the key', message: e.message });
    return;
  }
  app.aiProviders = await invoke('ai:providers').catch(() => providers);
  app.setSetting('ai', { provider: values.provider, models, baseUrls, instructions: values.instructions.trim() }, { silent: true });
  app.panel.updateCommitButton();
  if (!p) {
    toast({ type: 'success', title: 'AI commit messages are off' });
    return;
  }
  if (keptForSession) keychainToast();
  else toast({ type: 'success', title: 'AI commit messages on', message: `${app.aiConfig().label}. Press Generate in the commit box.` });
  if (thenGenerate && app.repo) app.generateMessage();
}

// ---------------------------------------------------------------- remotes

export async function pushUpstreamDialog(app, branch) {
  const remotes = app.data.remotes.map((r) => r.name);
  const values = await formDialog({
    title: `Push ${branch}`,
    okLabel: 'Push',
    fields: [
      { name: 'remote', label: 'Remote', type: 'select', value: remotes.includes('origin') ? 'origin' : remotes[0], options: remotes.map((r) => ({ value: r, label: r })) },
      { name: 'name', label: 'Remote branch', value: branch, mono: true, hint: `${branch} will track this branch for future pulls and pushes.` },
    ],
    validate: (v) => (!v.name.trim() ? 'Enter a branch name.' : null),
  });
  return values;
}

export async function remoteDialog(app, existing) {
  const values = await formDialog({
    title: existing ? `Edit remote ${existing.name}` : 'Add a remote',
    okLabel: existing ? 'Save' : 'Add remote',
    width: 540,
    fields: [
      { name: 'name', label: 'Name', value: existing ? existing.name : app.data.remotes.length ? '' : 'origin', mono: true, placeholder: 'origin' },
      { name: 'url', label: 'URL', value: existing ? existing.fetchUrl : '', mono: true, placeholder: 'git@github.com:team/project.git' },
      ...(existing ? [] : [{ name: 'fetch', type: 'checkbox', label: 'Fetch after adding', value: true }]),
    ],
    validate: (v) => (!/^[A-Za-z0-9._-]+$/.test(v.name.trim()) ? 'Use letters, numbers, dots, dashes or underscores.' : !v.url.trim() ? 'Enter the remote URL.' : null),
  });
  return values;
}

// ---------------------------------------------------------------- branches & tags

export async function branchDialog(app, { at, atLabel }) {
  const values = await formDialog({
    title: 'Create branch',
    okLabel: 'Create branch',
    fields: [
      { name: 'name', label: `New branch at ${atLabel}`, placeholder: 'feature/short-description', mono: true },
      { name: 'checkout', type: 'checkbox', label: 'Check it out', value: true },
    ],
    validate: async (v) => {
      const name = v.name.trim();
      if (!name) return 'Enter a branch name.';
      if (/\s/.test(name)) return 'Branch names cannot contain spaces.';
      if (app.data.refs.local.some((b) => b.name === name)) return `A branch named ${name} already exists.`;
      const ok = await git(app.repo, 'validateBranchName', name).catch(() => false);
      return ok ? null : `“${name}” is not a valid branch name.`;
    },
  });
  return values ? { name: values.name.trim(), checkout: values.checkout, at } : null;
}

export async function tagDialog(app, { at }) {
  const hasRemote = app.data.remotes.length > 0;
  const values = await formDialog({
    title: `Create tag at ${shortHash(at)}`,
    okLabel: 'Create tag',
    fields: [
      { name: 'name', label: 'Tag name', placeholder: 'v1.2.0', mono: true },
      { name: 'message', label: 'Message', type: 'textarea', rows: 3, placeholder: 'Leave empty for a lightweight tag' },
      ...(hasRemote ? [{ name: 'push', type: 'checkbox', label: `Push to ${app.data.remotes.some((r) => r.name === 'origin') ? 'origin' : app.data.remotes[0].name}`, value: false }] : []),
    ],
    validate: (v) => {
      const name = v.name.trim();
      if (!name) return 'Enter a tag name.';
      if (/\s/.test(name)) return 'Tag names cannot contain spaces.';
      if (app.data.refs.tags.some((t) => t.name === name)) return `Tag ${name} already exists.`;
      return null;
    },
  });
  return values;
}

// ---------------------------------------------------------------- interactive rebase

const ACTIONS = [
  { value: 'pick', label: 'Pick' },
  { value: 'reword', label: 'Reword' },
  { value: 'squash', label: 'Squash' },
  { value: 'fixup', label: 'Fixup' },
  { value: 'drop', label: 'Drop' },
];

export async function interactiveRebaseDialog(app, { base, baseLabel }) {
  let commits;
  try {
    commits = await git(app.repo, 'rangeCommits', base);
  } catch (e) {
    toast({ type: 'error', title: 'Could not list commits', message: e.message });
    return null;
  }
  if (!commits.length) {
    toast({ type: 'info', title: 'Nothing to rebase', message: 'There are no commits after this one on the current branch.' });
    return null;
  }
  if (commits.some((c) => c.parents.length > 1)) {
    toast({ type: 'warn', title: 'Merge commits in range', message: 'Interactive rebase will flatten merge commits in this range.' });
  }
  // Newest first, like the graph.
  const steps = commits.map((c) => ({ ...c, action: 'pick', message: c.subject })).reverse();
  return new Promise((resolve) => {
    const list = h('div', { class: 'irb-list' });
    const err = h('div', { class: 'field-error', role: 'alert' });
    const render = () => {
      clear(list);
      steps.forEach((s, i) => {
        const select = h('select', { class: 'input irb-action', 'aria-label': 'Action' }, ACTIONS.map((a) => h('option', { value: a.value, selected: a.value === s.action }, a.label)));
        select.addEventListener('change', () => {
          s.action = select.value;
          render();
        });
        const msg = s.action === 'reword'
          ? h('input', { class: 'input irb-msg', value: s.message, 'aria-label': 'New message' })
          : h('span', { class: ['irb-subject', s.action === 'drop' && 'dropped'] }, s.subject);
        if (s.action === 'reword') msg.addEventListener('input', () => {
          s.message = msg.value;
        });
        list.appendChild(h('div', { class: ['irb-row', `irb-${s.action}`] },
          h('div', { class: 'irb-move' },
            h('button', { type: 'button', class: 'icon-btn', title: 'Move up (newer)', disabled: i === 0, onClick: () => {
              [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
              render();
            } }, icon('chevron-up', { size: 13 })),
            h('button', { type: 'button', class: 'icon-btn', title: 'Move down (older)', disabled: i === steps.length - 1, onClick: () => {
              [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
              render();
            } }, icon('chevron-down', { size: 13 }))),
          select,
          h('span', { class: 'irb-sha mono' }, shortHash(s.hash)),
          msg,
          h('span', { class: 'irb-meta' }, `${s.author} · ${relativeTime(s.date)}`)));
      });
    };
    render();
    openModal({
      title: `Interactive rebase onto ${baseLabel}`,
      width: 760,
      body: h('div', { class: 'stack' },
        h('p', { class: 'modal-text' }, 'Newest commit at the top. Squash and fixup fold a commit into the one below it.'),
        list, err),
      actions: [
        { label: 'Cancel', run: (close) => close(null) },
        {
          label: 'Start rebase',
          primary: true,
          run: (close) => {
            const oldestFirst = [...steps].reverse();
            const firstKept = oldestFirst.find((s) => s.action !== 'drop');
            if (firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')) {
              err.textContent = 'The oldest kept commit cannot be squashed: there is nothing below it to fold into.';
              return;
            }
            if (oldestFirst.some((s) => s.action === 'reword' && !s.message.trim())) {
              err.textContent = 'Reworded commits need a message.';
              return;
            }
            close(oldestFirst.map((s) => ({ action: s.action, hash: s.hash, message: s.action === 'reword' ? s.message.trim() : undefined })));
          },
        },
      ],
      onClose: (r) => resolve(r || null),
    });
  });
}

// ---------------------------------------------------------------- credentials

const TOKEN_PAGES = {
  'github.com': 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=GitDonkey',
  'gitlab.com': 'https://gitlab.com/-/user_settings/personal_access_tokens?name=GitDonkey&scopes=read_repository,write_repository',
  'bitbucket.org': 'https://bitbucket.org/account/settings/app-passwords/new',
};

/** Answer a Git / SSH credential prompt. Resolves to the answer object or null. */
export async function credentialDialog(app, req) {
  const status = await invoke('credentials:status').catch(() => ({ helpers: [] }));
  const canRemember = !status.helpers || !status.helpers.length;
  const tokenPage = req.host && TOKEN_PAGES[req.host.replace(/^www\./, '')];
  const tokenHint = tokenPage
    ? h('div', { class: 'cred-hint' },
        h('span', null, `${req.host} wants a personal access token here, not your account password.`),
        h('button', { type: 'button', class: 'btn btn-small', onClick: () => invoke('shell:openExternal', tokenPage) }, icon('external-link', { size: 13 }), 'Create a token'))
    : null;
  const intro = (text) => h('p', { class: 'modal-text' }, text);
  const remember = canRemember ? [{ name: 'remember', type: 'checkbox', label: 'Remember this login in the system keychain', value: true }] : [];
  const after = async (v) => {
    if (v && v.remember) await invoke('credentials:remember').catch(() => {});
    return v;
  };

  if (req.kind === 'username') {
    const v = await formDialog({
      title: `Sign in to ${req.host}`,
      okLabel: 'Sign in',
      intro: intro(`Git needs a login for ${req.url}.${canRemember ? '' : ' It is saved after the first successful sign-in, so you will not be asked again.'}`),
      extra: tokenHint,
      fields: [
        { name: 'username', label: 'Username', placeholder: 'your-username' },
        { name: 'password', label: tokenPage ? 'Personal access token' : 'Password or token', type: 'password' },
        ...remember,
      ],
      validate: (x) => (!x.username.trim() ? 'Enter your username.' : !x.password ? 'Enter your password or token.' : null),
    });
    return v ? after({ username: v.username.trim(), password: v.password, remember: v.remember }) : null;
  }
  if (req.kind === 'password') {
    const v = await formDialog({
      title: `Sign in to ${req.host}`,
      okLabel: 'Sign in',
      intro: intro(`Git needs the ${tokenPage ? 'token' : 'password'} for ${req.username || 'your account'} on ${req.host}.`),
      extra: tokenHint,
      fields: [{ name: 'password', label: tokenPage ? 'Personal access token' : 'Password or token', type: 'password' }, ...remember],
      validate: (x) => (!x.password ? 'Enter your password or token.' : null),
    });
    return v ? after({ password: v.password, remember: v.remember }) : null;
  }
  if (req.kind === 'passphrase') {
    const v = await formDialog({
      title: 'Unlock SSH key',
      okLabel: 'Unlock',
      intro: intro(`Enter the passphrase for ${req.key}.`),
      fields: [{ name: 'value', label: 'Passphrase', type: 'password' }],
    });
    return v ? { value: v.value } : null;
  }
  if (req.kind === 'confirm') {
    const ok = await confirmDialog({
      title: req.host ? `Trust ${req.host}?` : 'Trust this host?',
      message: 'This is the first time GitDonkey connects to this server over SSH. Check the fingerprint below matches the one your Git host publishes before trusting it.',
      detail: req.detail,
      okLabel: 'Trust and connect',
    });
    return { confirm: ok };
  }
  const v = await formDialog({
    title: 'Git needs a response',
    okLabel: 'Send',
    intro: intro(req.prompt || ''),
    fields: [{ name: 'value', label: 'Response', type: 'password' }],
  });
  return v ? { value: v.value } : null;
}

// ---------------------------------------------------------------- shortcuts

export function shortcutsDialog() {
  const rows = [
    ['Open repository', `${kb('⌘O')}`], ['Clone repository', `${kb('⌘⇧N')}`], ['New repository', `${kb('⌘⌥N')}`],
    ['New tab / close tab', `${kb('⌘T')} / ${kb('⌘W')}`], ['Find commits', `${kb('⌘F')}`], ['Filter branches', `${kb('⌘⌥F')}`],
    ['Fetch all', `${kb('⌘⇧F')}`], ['Pull', `${kb('⌘⇧L')}`], ['Push', `${kb('⌘⇧P')}`], ['Create branch', `${kb('⌘B')}`],
    ['Stash / pop stash', `${kb('⌘⌥S')} / ${kb('⌘⌥P')}`], ['Stage all / unstage all', `${kb('⌘⇧S')} / ${kb('⌘⇧U')}`],
    ['Commit', `${kb('⌘↵')} in the message`], ['Undo / redo Git action', `${kb('⌘Z')} / ${kb('⌘⇧Z')} (outside text fields)`],
    ['Move through commits', '↑ ↓  or  J K'], ['Move through changed files', '↑ ↓  or  J K, after clicking a file'], ['Next / previous change in a diff', `${kb('⌥↓')} / ${kb('⌥↑')}  or  F7 / ⇧F7`], ['Close diff, search or menu', 'Esc'], ['Toggle sidebar / panel', `${kb('⌘J')} / ${kb('⌘K')}`],
    ['Refresh', `${kb('⌘R')}`],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    width: 520,
    body: h('div', { class: 'shortcuts' }, rows.map(([label, keys]) => h('div', { class: 'sc-row' }, h('span', null, label), h('span', { class: 'sc-keys' }, kbd(keys))))),
    actions: [{ label: 'Done', primary: true, run: (close) => close(null) }],
  });
}

export function aboutBadge() {
  return h('div', { class: 'about' }, logoMark(28), h('span', { class: 'wordmark' }, 'GitDonkey'));
}

export { field, legend };
