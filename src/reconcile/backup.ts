import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DesiredState } from '../synth/manifest.ts';
import type { ApplyRecord } from './applier.ts';
import type { Change } from './changes.ts';
import type { LiveState } from './live.ts';

export interface Backup {
  /** Directory the backup was written to. */
  readonly dir: string;
  /** Append one journal entry; called by `apply` after every attempted change. */
  readonly journal: (record: ApplyRecord) => void;
}

/**
 * Persist what is needed to understand and undo an apply, before it writes.
 *
 * `live-state.json` is the account as it stood: every visible vault, every
 * group, and every grant, which is enough to restore any access the apply
 * changes by hand or with `op`. `manifest.json` is the definition applied,
 * `plan.json` the change list about to execute, and `journal.jsonl` grows a
 * line per attempted change, so an aborted run says exactly where it stopped.
 */
export function writeBackup(
  outdir: string,
  desired: DesiredState,
  live: LiveState,
  changes: readonly Change[],
): Backup {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(outdir, 'backups', stamp);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'live-state.json'), `${JSON.stringify(live, null, 2)}\n`);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(desired, null, 2)}\n`);
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(changes, null, 2)}\n`);

  const journalPath = join(dir, 'journal.jsonl');
  return {
    dir,
    journal: (record) => {
      appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    },
  };
}
