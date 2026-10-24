// What the donkey says. Pure: an event in, a line out, so it's testable and
// he doesn't say the same thing twice in a row.

export const LINES = {
  hello: ['Hee-haw. I’m the donkey. Poke me.', 'Hello. I’ll be down here, judging your commits.'],
  back: ['I’m back. Did you miss me?', 'Hee-haw. Where were we?'],
  poke: ['Hee-haw.', 'Yes?', 'That’s my nose.', 'I’m working here.', 'Poke me again. I dare you.', 'I carry your history. Show some respect.', 'Boop received.', 'Hello to you too.'],
  annoyed: ['Right. That’s it.', 'Do you MIND?', 'I’m filing an issue about you.', 'Stubborn mode: on.'],
  spin: ['Wheee!', 'Do a barrel roll!', 'I’ve gone dizzy.', 'Again! No. Wait.'],
  pet: ['Ooh, that’s the spot.', 'Good human.', 'Yes. More of that.', 'I’ll allow it.'],
  feed: ['Nom.', 'Hay! My favourite.', 'Crunchy. Five stars.', 'That’s the good stuff.'],
  joke: [
    'Why did the commit cross the road? It got cherry-picked.',
    'I’d tell you a rebase joke, but I’d have to rewrite it.',
    'My favourite branch? The one that compiles.',
    'I don’t have trust issues. I have merge conflicts.',
    'git blame says it was me. git blame is a liar.',
    'Force push? I prefer a gentle nudge.',
    'A donkey walks into a repo. HEAD detaches.',
    'What do you call a donkey with a bad commit? An ass-ignee.',
  ],
  idle: ['Still here. Still a donkey.', 'Thinking about hay.', 'Any commits today, or…?', 'I’ve counted your branches. Twice.'],
  quiet: ['Fine. Quiet for an hour.'],
  talk: ['Ahem. I’m talking again.'],

  commit: ['Committed. I’ll carry it.', 'Another one for {branch}.', 'Lovely commit. Hee-haw.', 'Saved to history. No take-backs.', 'That one’s going in the museum.'],
  amend: ['Amended. Nobody saw anything.', 'Rewriting history? I didn’t see that.'],
  push: ['Pushed. It’s {remote}’s problem now.', 'Off it goes to {remote}.', 'Delivered. Hee-haw.'],
  forcePush: ['Force push. I’m not looking.', 'With force? Brave donkey.'],
  pushRejected: ['Rejected! Someone pushed first. Pull, then try again.', '{remote} said no. Pull first.'],
  noUpstream: ['No upstream yet. Push it to set one.'],
  pull: ['Fresh hay from {remote}.', 'Pulled. Smells new.', 'Up to date. Probably.'],
  merge: ['Merged {ref}. Two branches, one donkey.', 'Merge done. Nobody cried.', 'Merged. That’s teamwork.'],
  conflict: ['Conflicts! Pick ours, theirs, or breed a mule.', 'Uh oh. Conflicts. I’ll hold the hay.', 'Merge conflict. Deep breaths.'],
  conflicts: ['{count} conflicted. I believe in you.', '{count} conflicted. Ours, theirs, or both?'],
  rebase: ['Rebased. History is whatever we say it is.', 'Rebased. Very tidy.'],
  checkout: ['Now on {branch}.', '{branch}? Lovely this time of year.', 'Switched to {branch}. New view, same donkey.'],
  branchCreated: ['Branch {name}. Fancy.', 'A new branch! Grow, little {name}.'],
  branchDeleted: ['Bye, {name}. I’ll miss it. Not really.', '{name} is gone. Pour one out.'],
  stash: ['Stashed. Out of sight, out of mind.', 'Hidden under the hay.'],
  stashPop: ['Back from the stash.', 'Found it under the hay.'],
  resetHard: ['reset --hard? Brave.', 'Hard reset. Hope you meant it.'],
  reset: ['Reset. Feels lighter.'],
  cherryPick: ['Cherry-picked. I prefer apples.', 'One cherry, picked.'],
  revert: ['Reverted. It never happened. It did, though.', 'Undone the polite way.'],
  tag: ['Tagged {name}. Ship it?', '{name}. Put it on the fridge.'],
  discard: ['Gone. Hope you meant that.', 'Discarded. Into the void.'],
  abort: ['Aborted. Nobody needs to know.'],
  error: ['That didn’t work. Don’t look at me.', 'Hmm. Git’s grumpy.', 'Something broke. Not me. Probably.'],

  theme: ['Ooh, {name}. Very me.', '{name}? I look great in this.', 'New coat. Hee-haw.'],
  aiMessage: ['A robot wrote that. I could’ve done it.', 'Fine, the AI’s good. I’m still cuter.'],
  update: ['There’s a newer me! Version {version}.', '{version} is out. Same donkey, better hay.'],
  openRepo: ['{name}. Nice stable.', 'Ooh, {name}. Let’s have a look.'],
  manyChanges: ['{count} changes? Commit early, commit often.', '{count} changes. I’m not carrying all that at once.'],
};

/** How he looks while he says it. */
export const MOODS = {
  happy: new Set(['commit', 'push', 'pull', 'merge', 'tag', 'branchCreated', 'stashPop', 'feed', 'pet', 'theme', 'update', 'openRepo', 'back', 'hello']),
  worried: new Set(['conflict', 'conflicts', 'pushRejected', 'error', 'noUpstream', 'manyChanges']),
  shocked: new Set(['forcePush', 'resetHard', 'discard', 'branchDeleted', 'annoyed', 'amend']),
};

export function moodOf(type) {
  for (const [mood, set] of Object.entries(MOODS)) if (set.has(type)) return mood;
  return 'neutral';
}

export function fill(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined || vars[k] === null || vars[k] === '' ? 'it' : String(vars[k])));
}

const lastPick = new Map();

/** A line for `type`, never the same as the last one for that type. */
export function pickLine(type, vars = {}, rand = Math.random) {
  const list = LINES[type];
  if (!list || !list.length) return null;
  let i = Math.floor(rand() * list.length) % list.length;
  if (list.length > 1 && i === lastPick.get(type)) i = (i + 1) % list.length;
  lastPick.set(type, i);
  return fill(list[i], vars);
}

const short = (ref) => {
  const s = String(ref || '');
  return /^[0-9a-f]{40}$/i.test(s) ? s.slice(0, 7) : s.replace(/^refs\/(heads|remotes|tags)\//, '');
};

// Reads (status, log, diff…) and staging happen all the time; he only talks about things you did.
const QUIET = new Set(['info', 'status', 'refs', 'log', 'searchCommits', 'stashes', 'remotes', 'opState', 'commitDetails',
  'changedFiles', 'diff', 'blob', 'showFile', 'fileHistory', 'blame', 'lastCommitMessage', 'isAncestor', 'revParse', 'identity',
  'stage', 'stageAll', 'unstage', 'unstageAll', 'applyPatch', 'readFile', 'validateBranchName', 'rangeCommits', 'conflictDetails',
  'emptyTree', 'hasHead', 'fetch', 'setIdentity', 'setUpstream', 'writeFile', 'resolveConflict', 'markResolved', 'ignore']);

/** What a Git call from the renderer is worth saying, as { type, vars }, or null. */
export function eventForGit({ method, args = [], ok, error }) {
  const a0 = args[0] && typeof args[0] === 'object' ? args[0] : {};
  if (!ok) {
    const kind = error && error.kind;
    if (kind === 'CONFLICT') return { type: 'conflict' };
    if (kind === 'PUSH_REJECTED') return { type: 'pushRejected', vars: { remote: a0.remote || 'origin' } };
    if (kind === 'NO_UPSTREAM') return { type: 'noUpstream' };
    if (QUIET.has(method) || kind === 'CANCELLED' || kind === 'AUTH_CANCELLED') return null;
    return { type: 'error' };
  }
  switch (method) {
    case 'commit': return a0.amend ? { type: 'amend' } : { type: 'commit', vars: { branch: a0.branch } };
    case 'push': return a0.force ? { type: 'forcePush' } : { type: 'push', vars: { remote: a0.remote || 'origin' } };
    case 'pull': return { type: 'pull', vars: { remote: 'origin' } };
    case 'merge': return { type: 'merge', vars: { ref: short(args[0]) } };
    case 'rebase':
    case 'rebaseInteractive': return { type: 'rebase' };
    case 'checkout':
    case 'checkoutDetached': return { type: 'checkout', vars: { branch: short(args[0]) } };
    case 'checkoutRemote': return { type: 'checkout', vars: { branch: short(args[1] || args[0]) } };
    case 'createBranch': return { type: 'branchCreated', vars: { name: args[0] } };
    case 'deleteBranch':
    case 'deleteRemoteBranch': return { type: 'branchDeleted', vars: { name: short(args[args.length > 1 && typeof args[1] === 'string' ? 1 : 0]) } };
    case 'stashSave': return { type: 'stash' };
    case 'stashApply': return { type: 'stashPop' };
    case 'reset': return { type: args[1] === 'hard' ? 'resetHard' : 'reset' };
    case 'cherryPick': return { type: 'cherryPick' };
    case 'revert': return { type: 'revert' };
    case 'createTag': return { type: 'tag', vars: { name: args[0] } };
    case 'discard':
    case 'discardFull':
    case 'discardAll': return { type: 'discard' };
    case 'abortOperation': return { type: 'abort' };
    default: return null;
  }
}
