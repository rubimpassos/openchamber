import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { BotItem } from '@/lib/bots/items';

/** Only HTTP(S) URLs become links. Evidence remains text, never executable HTML. */
export function BotLink({ url, children }: { readonly url: string; readonly children?: React.ReactNode }) {
  const safe = /^https?:\/\//i.test(url);
  return safe ? <a href={url} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2" dir="ltr">{children ?? url}</a> : <span className="break-all" dir="ltr">{children ?? url}</span>;
}

const proofKeys = { absent: 'bots.proofAbsent', passed: 'bots.proofPassed', failed: 'bots.proofFailed', inconclusive: 'bots.proofInconclusive' } satisfies Record<BotItem['proof']['status'], I18nKey>;
const judgeKeys = { auto: 'bots.judgeAuto', review: 'bots.judgeReview', ask: 'bots.judgeAsk' } satisfies Record<NonNullable<BotItem['judgment']>['decision'], I18nKey>;

export function BotSourceEvidence({ item }: { readonly item: BotItem }) {
  const { t } = useI18n();
  return <SettingsSection title={t('bots.evidence')} divider={false} contentClassName="space-y-3">
    {item.source.url ? <BotLink url={item.source.url} /> : <p className="typography-meta" dir="auto">{item.source.kind} · {item.source.id}</p>}
    {item.evidence.length === 0 ? <p className="typography-meta text-muted-foreground">{t('bots.empty')}</p> : item.evidence.map((entry, index) => <div key={index} className="min-w-0 space-y-1 typography-meta">
      <p dir="auto" className="font-medium break-words">{entry.source}</p><p dir="auto" className="whitespace-pre-wrap break-words">{entry.summary}</p>
      {entry.url ? <BotLink url={entry.url} /> : null}
    </div>)}
  </SettingsSection>;
}

export function BotProof({ item }: { readonly item: BotItem }) {
  const { t } = useI18n();
  const proof = item.proof;
  return <SettingsSection title={t('bots.proof')} contentClassName="space-y-2 typography-meta">
    <p className={proof.status === 'passed' ? 'text-[var(--status-success-text)]' : 'text-[var(--status-warning-text)]'}>{t(proofKeys[proof.status])}</p>
    {proof.reason ? <p dir="auto" className="whitespace-pre-wrap break-words">{proof.reason}</p> : null}
    {proof.status !== 'absent' ? <>
      <pre dir="ltr" className="whitespace-pre-wrap break-all font-mono">{JSON.stringify([proof.command, ...proof.args])}</pre>
      <dl className="space-y-1" dir="ltr"><dt>{proof.testSha}</dt><dd>{String(proof.testExitCode)}</dd><dt>{proof.fixSha}</dt><dd>{String(proof.fixExitCode)}</dd></dl>
    </> : null}
  </SettingsSection>;
}

export function BotJudgment({ item }: { readonly item: BotItem }) {
  const { t } = useI18n();
  const judgment = item.judgment;
  return <SettingsSection title={t('bots.judgment')} contentClassName="space-y-2 typography-meta">
    {judgment ? <>
      <p className="font-medium">{t(judgeKeys[judgment.decision])}</p>
      <p className="whitespace-pre-wrap break-words" dir="auto">{judgment.reason}</p>
      <p className="break-all font-mono" dir="ltr">{judgment.baseSha} / {judgment.headSha}</p>
      <p className="break-all font-mono" dir="ltr">{judgment.policyFingerprint}</p>
      <p>{t('bots.reviewers')} · {judgment.reviewers.join(', ')}</p>
      {judgment.questions.length ? <ul className="list-disc space-y-1 ps-4">{judgment.questions.map((question, index) => <li key={index} className="break-words" dir="auto">{question}</li>)}</ul> : null}
    </> : <p className="text-muted-foreground">{t('bots.noJudgment')}</p>}
  </SettingsSection>;
}

export function BotEvidence({ item }: { readonly item: BotItem }) {
  return <><BotSourceEvidence item={item} /><BotProof item={item} /><BotJudgment item={item} /></>;
}
