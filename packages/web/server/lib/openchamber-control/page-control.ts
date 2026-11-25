import { asNonEmptyString } from '../shared/guards.js';
import { controlErrorFields } from './error.js';
import { createPageAnswers, createRenderPageAction, isAgentPrompt } from './render-page.js';
import type { RenderPageDependencies } from './render-page.js';
import { createPageRecovery } from './page-recovery.js';
import { createRenderedPageProjection } from './page-projection.js';
import type { ControlClient } from './opencode-client.js';
import type { ControlDependencies, ControlOptions } from './service.js';
import type { ControlInput } from './contracts.js';

type PageControlOptions = Pick<ControlDependencies, 'onPageWaitChange' | 'artifacts' | 'laterPages' | 'sharePages'> & {
  readonly getClient: (directory?: string | null) => Promise<ControlClient>;
  readonly isEnabled: RenderPageDependencies['isEnabled'];
};

export function createPageControl({ getClient, isEnabled, onPageWaitChange, artifacts, laterPages = null, sharePages = null }: PageControlOptions) {
  const hasUnreadChat = async (sessionID: string) => {
    try {
      const items = await (await getClient()).session.inbox.list({ sessionID });
      return items.some((item) => item.type === 'user' && item.delivery === 'steer' && !isAgentPrompt(item.payload?.metadata));
    } catch (error) {
      console.warn('[render.page] could not read the session inbox:', controlErrorFields(error)?.message ?? error);
      return false;
    }
  };
  const pageAnswers = createPageAnswers({ onWaitChange: onPageWaitChange });
  const readPageProjection = createRenderedPageProjection({ getClient, pageAnswers, laterPages });
  const { recover: recoverPage, answer: answerPage } = createPageRecovery({ getClient, pageAnswers, laterPages, artifacts });
  const readSession = async (sessionID: string) => (await getClient()).session.get({ sessionID });
  let renderOptions: RenderPageDependencies = { isEnabled, pageAnswers, hasUnreadChat, readSession, laterPages, sharePages };
  if (artifacts !== undefined) renderOptions = { ...renderOptions, artifacts };
  const renderPage = createRenderPageAction(renderOptions);
  return {
    hasUnreadChat, readSession, readPageProjection, recoverPage, answerPage,
    release: pageAnswers.release,
    render: (input: ControlInput, directory: ControlInput['directory'], options: ControlOptions) => renderPage(input, {
      sessionId: asNonEmptyString(options.contextSessionId),
      callId: asNonEmptyString(options.contextCallId),
      messageId: options.contextMessageId,
      onArtifactCaptured: options.onArtifactCaptured,
      directory: asNonEmptyString(directory),
      signal: options.signal,
    }),
  };
}
