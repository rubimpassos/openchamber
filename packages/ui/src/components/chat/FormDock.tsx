import React from 'react';
import { AnimatePresence } from 'motion/react';
import type { FormField } from '@/lib/opencode/model';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { FormRequest } from '@/lib/opencode/model';
import { questionToForm } from '@/lib/opencode/projection';
import { isOrphanedQuestionDismissed, markOrphanedQuestionDismissed, type OrphanedQuestion } from '@/lib/questions/orphanedQuestions';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { getRestartInterruption, type RestartInterruptionCause } from '@/lib/sessionRestartInterruption';
import { questionToolLink, type RecoveredQuestion } from '@/sync/recoverable-questions';
import { readWebSearchConsent } from '@/lib/opencode/websearch';
import { useUIStore } from '@/stores/useUIStore';
import { useScopedBlockingForms, useRecoveredQuestions, useSession, useSessions } from '@/sync/sync-context';
import { revealWaitingPage, useRequestReveal } from '@/sync/request-reveal';
import { useChatSessionSelection } from './chatColumnSession';
import * as sessionActions from '@/sync/session-actions';
import { agentUnavailableFrom, connectionLostMessage, isFormRequestNotFoundError } from '@/sync/form-request-error';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { FormDockModeContext, formWaitingBlockId } from './formsInChat';
import { FormFieldControl } from './FormFieldControl';
import { WebSearchConsentDock } from './WebSearchConsent';
import { FormMarkdown } from './FormMarkdown';
import { serializeFormAnswerAsMarkdown, serializeFormAsJson, serializeFormAsMarkdown } from './formSerializers';
import { formDraftScope, loadFormDraft, saveFormDraft, dropFormDraft } from './formDrafts';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { noteLocalFormCancelled } from '@/sync/recoverable-questions';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
    type FormValues,
    buildFormAnswer,
    initialFormValues,
    isFieldAnswered,
    missingRequiredKeys,
    valueOf,
    visibleFields,
} from './formCardState';


interface FormDockProps {
    sessionId: string | null;
    directory?: string;
    hidden: boolean;
    /** Questions persisted across a restart or inactivity eviction; no live form owns them. */
    orphanedQuestions?: OrphanedQuestion[];
    onOrphanedResolved?: () => void;
}

const NO_ORPHANED_QUESTIONS: OrphanedQuestion[] = [];
const ignoreOrphanedResolved = () => {};
const RESTART_CAUSE_KEYS = {
    'memory-pressure': 'chat.restartInterruption.cause.memoryPressure',
    'health-timeout': 'chat.restartInterruption.cause.healthTimeout',
    'process-exited': 'chat.restartInterruption.cause.processExited',
    unknown: null,
} as const satisfies Record<RestartInterruptionCause, I18nKey | null>;

const dockKey = (form: FormRequest, directory: string | undefined, runtimeKey: string): string =>
    Object.values(formDraftScope(form, directory, runtimeKey)).join('\u0000');

const FormDockView: React.FC<FormDockProps> = ({ sessionId, directory, hidden, orphanedQuestions: questions = NO_ORPHANED_QUESTIONS, onOrphanedResolved = ignoreOrphanedResolved }) => {
    const mode = React.useContext(FormDockModeContext);
    const inChat = mode === 'in-chat';
    const readingHistory = mode === 'reading';
    const forms = useScopedBlockingForms(sessionId, directory);
    const orphanedQuestion = forms.length === 0 ? questions[0] : undefined;
    const form = forms[0] ?? (orphanedQuestion ? questionToForm(orphanedQuestion) : undefined);
    const webSearchConsent = form ? readWebSearchConsent(form) : null;
    const recovered = useRecoveredQuestions(sessionId, directory);
    const recoveredFirst = form ? undefined : recovered.find((question) => {
        const tool = questionToolLink(question.form);
        return !tool || !isOrphanedQuestionDismissed(tool.toolID);
    });
    const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
    if (inChat && !orphanedQuestion) {
        const first = form ?? recoveredFirst?.form;
        return (
            <AnimatePresence>
                {hidden || !first ? null : (
                    <FormDockPointer
                        key="in-chat"
                        sessionId={sessionId}
                        form={first}
                        waitingForms={[...forms, ...recovered.map((item) => item.form)]}
                    />
                )}
            </AnimatePresence>
        );
    }
    return (
        <AnimatePresence>
            {hidden ? null : form ? (
                webSearchConsent
                    ? <WebSearchConsentDock key={dockKey(form, directory, runtimeKey)} form={form} consent={webSearchConsent} />
                    : <FormDockPanel key={dockKey(form, directory, runtimeKey)} form={form} forms={forms} directory={directory}
                        runtimeKey={runtimeKey} readingHistory={readingHistory}
                        waiting={Math.max(0, forms.length + questions.length - 1)}
                        orphanedQuestion={orphanedQuestion} onOrphanedResolved={onOrphanedResolved} />
            ) : recoveredFirst ? (
                <FormDockPanel
                    key={dockKey(recoveredFirst.form, recoveredFirst.directory ?? directory, runtimeKey)}
                    form={recoveredFirst.form}
                    forms={forms}
                    directory={directory}
                    runtimeKey={runtimeKey}
                    readingHistory={readingHistory}
                    recovered={recoveredFirst}
                    waiting={Math.max(0, recovered.length - 1)}
                />
            ) : null}
        </AnimatePresence>
    );
};

const FormDockPointer: React.FC<{
    sessionId: string | null;
    form: FormRequest;
    waitingForms: FormRequest[];
}> = ({ sessionId, form, waitingForms }) => {
    const { t } = useI18n();
    const revealCard = React.useCallback((target: FormRequest) => {
        if (sessionId) revealWaitingPage(sessionId, formWaitingBlockId(target));
    }, [sessionId]);
    const revealRequested = React.useCallback((formId: string) => {
        const target = waitingForms.find((item) => item.id === formId);
        if (target) revealCard(target);
    }, [revealCard, waitingForms]);
    useRequestReveal(waitingForms.map((item) => item.id), revealRequested);
    const title = form.title?.trim() || t('chat.formCard.inputNeeded');
    const waiting = waitingForms.length - 1;
    return (
        <ComposerFloatingPanel
            role="region"
            ariaLabel={title}
            compact
            header={<>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={() => revealCard(form)}
                            aria-label={t('chat.formDock.showInChatAria')}
                            className="flex min-w-0 flex-1 items-center gap-2 text-start text-muted-foreground transition-colors hover:text-foreground"
                        >
                            <Icon name="question" className="size-3.5 shrink-0 text-primary" />
                            <Icon name="arrow-up-s" className="size-4 shrink-0" />
                            <span dir="auto" className="typography-ui-label min-w-0 truncate oc-ui-start-align text-foreground">{title}</span>
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t('chat.formDock.showInChatAria')}</TooltipContent>
                </Tooltip>
                {waiting > 0 ? (
                    <span className="typography-micro shrink-0 text-muted-foreground">
                        {t('chat.formDock.waiting', { count: String(waiting) })}
                    </span>
                ) : null}
            </>}
        />
    );
};

const FormDockPanel: React.FC<{
    form: FormRequest;
    forms: FormRequest[];
    directory?: string;
    runtimeKey: string;
    readingHistory: boolean;
    recovered?: RecoveredQuestion;
    waiting: number;
    orphanedQuestion?: OrphanedQuestion;
    onOrphanedResolved?: () => void;
}> = ({ form, forms, directory, runtimeKey, readingHistory, recovered, waiting, orphanedQuestion, onOrphanedResolved = ignoreOrphanedResolved }) => {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const chatDirectory = useChatSessionSelection().directory ?? undefined;
    const sessions = useSessions(chatDirectory);
    const session = useSession(orphanedQuestion?.sessionID ?? '', chatDirectory);
    const bodyRef = React.useRef<HTMLDivElement | null>(null);

    const fields = form.fields;
    const fieldsSignature = fields.map((field) => `${field.key}:${field.type}`).join('|');
    const draftScope = React.useMemo(
        () => formDraftScope({ id: form.id, sessionID: form.sessionID }, recovered?.directory ?? directory, runtimeKey),
        [directory, form.id, form.sessionID, recovered?.directory, runtimeKey],
    );
    const [restored] = React.useState(() => {
        const draft = loadFormDraft(draftScope);
        return draft?.fieldsSignature === fieldsSignature ? draft : null;
    });
    const [values, setValues] = React.useState<FormValues>(() => restored?.values ?? initialFormValues(fields));
    const [step, setStep] = React.useState(restored?.step ?? 0);
    const [collapse, setCollapse] = React.useState<'open' | 'user' | 'reading'>(readingHistory ? 'reading' : 'open');
    const [answerField, setAnswerField] = React.useState<HTMLElement | null>(null);
    const [seenReadingHistory, setSeenReadingHistory] = React.useState(readingHistory);
    if (seenReadingHistory !== readingHistory) {
        setSeenReadingHistory(readingHistory);
        if (readingHistory && collapse === 'open' && !answerField?.isConnected) setCollapse('reading');
        if (!readingHistory && collapse === 'reading') setCollapse('open');
    }
    const collapsed = collapse !== 'open';
    const toggleCollapsed = () => {
        if (collapsed) setCollapse('open');
        else setCollapse(readingHistory ? 'reading' : 'user');
    };
    const trackAnswerFocus = (event: React.FocusEvent<HTMLDivElement>) => {
        setAnswerField(event.type === 'focus' && event.target.matches('textarea, input') ? event.target : null);
    };
    const [isResponding, setIsResponding] = React.useState(false);
    const respondingRef = React.useRef(false);
    const [showErrors, setShowErrors] = React.useState(false);
    const formIds = React.useMemo(() => forms.map((item) => item.id), [forms]);
    useRequestReveal(formIds, React.useCallback(() => setCollapse('open'), []));

    const appliedSignatureRef = React.useRef(fieldsSignature);
    React.useEffect(() => {
        if (appliedSignatureRef.current === fieldsSignature) return;
        appliedSignatureRef.current = fieldsSignature;
        setValues(initialFormValues(fields));
        setStep(0);
        setShowErrors(false);
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [fieldsSignature]);

    React.useEffect(() => {
        if (appliedSignatureRef.current !== fieldsSignature) return;
        saveFormDraft(draftScope, { fieldsSignature, values, step });
    }, [draftScope, fieldsSignature, step, values]);

    const isFromSubagent = React.useMemo(() => {
        const source = sessions.find((session) => session.id === form.sessionID);
        return Boolean(source?.parentID);
    }, [form.sessionID, sessions]);

    const shown = React.useMemo(() => visibleFields(fields, values), [fields, values]);
    const missing = React.useMemo(() => missingRequiredKeys(fields, values), [fields, values]);
    const canSubmit = missing.length === 0;
    const lastStep = Math.max(0, shown.length - 1);
    const currentStep = Math.min(step, lastStep);
    const currentField = shown[currentStep];
    const answered = React.useMemo(() => shown.map((field) => isFieldAnswered(field, values)), [shown, values]);
    const allAnswered = answered.every(Boolean);
    const submitEnabled = !isResponding && allAnswered;

    const availableMaxHeight = useMobileAutocompleteMaxHeight(bodyRef, !collapsed, 320);

    React.useLayoutEffect(() => {
        const focused = document.activeElement;
        if (!focused || !bodyRef.current?.contains(focused)) return;
        focused.scrollIntoView({ block: 'nearest' });
    }, [availableMaxHeight]);

    const updateValue = React.useCallback((key: string, patch: Partial<FormValues[string]>) => {
        setValues((previous) => ({ ...previous, [key]: { ...valueOf(previous, key), ...patch } }));
    }, []);

    const currentFieldKey = currentField?.key;
    const currentFieldIsExternal = currentField?.type === 'external';
    React.useEffect(() => {
        if (!currentFieldKey || !currentFieldIsExternal) return;
        setValues((previous) => {
            const value = valueOf(previous, currentFieldKey);
            if (value.acknowledged) return previous;
            return { ...previous, [currentFieldKey]: { ...value, acknowledged: true } };
        });
    }, [currentFieldIsExternal, currentFieldKey]);

    const handleSubmit = React.useCallback(async () => {
        if (respondingRef.current) return;
        if (!canSubmit) {
            setShowErrors(true);
            const firstMissing = shown.findIndex((field) => missing.includes(field.key));
            if (firstMissing >= 0) setStep(firstMissing);
            return;
        }
        respondingRef.current = true;
        setIsResponding(true);
        try {
            const answer = buildFormAnswer(fields, values);
            if (orphanedQuestion) {
                await sessionActions.answerOrphanedQuestion(orphanedQuestion, orphanedQuestion.questions.map((_, index) => {
                    const value = answer[`q${index}`];
                    return Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)];
                }));
                if (orphanedQuestion.tool) markOrphanedQuestionDismissed(orphanedQuestion.tool.callID);
                onOrphanedResolved();
            } else if (recovered) {
                await sessionActions.sendRecoveredFormAnswer(recovered, serializeFormAnswerAsMarkdown(form, answer));
            } else {
                await sessionActions.replyToForm(form.sessionID, form.id, answer);
            }
            dropFormDraft(draftScope);
        } catch (error) {
            if (!recovered && !orphanedQuestion && isFormRequestNotFoundError(error)) {
                dropFormDraft(draftScope);
                return;
            }
            const unavailableAgent = agentUnavailableFrom(error instanceof Error ? error : null);
            if (unavailableAgent) {
                toast.error(t('chat.chatInput.toast.agentUnavailable', { agent: unavailableAgent }));
                return;
            }
            const connectionLost = connectionLostMessage(error instanceof Error ? error : null, t);
            if (connectionLost) {
                toast.error(connectionLost);
                return;
            }
            toast.error(t('chat.formCard.submitFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            respondingRef.current = false;
            setIsResponding(false);
        }
    }, [canSubmit, draftScope, fields, form, missing, recovered, shown, t, values, orphanedQuestion, onOrphanedResolved]);

    const handleDismiss = React.useCallback(async () => {
        if (respondingRef.current) return;
        respondingRef.current = true;
        setIsResponding(true);
        try {
            if (orphanedQuestion) {
                // Other devices and the sidebar stop showing it as waiting too.
                await sessionActions.dismissPendingQuestion(orphanedQuestion.sessionID, chatDirectory);
                if (orphanedQuestion.tool) markOrphanedQuestionDismissed(orphanedQuestion.tool.callID);
                onOrphanedResolved();
            } else if (recovered) {
                noteLocalFormCancelled(recovered.sessionID, recovered.form.id);
            } else {
                await sessionActions.cancelForm(form.sessionID, form.id);
            }
            dropFormDraft(draftScope);
        } catch (error) {
            if (!recovered && !orphanedQuestion && isFormRequestNotFoundError(error)) {
                dropFormDraft(draftScope);
                return;
            }
            const connectionLost = connectionLostMessage(error instanceof Error ? error : null, t);
            if (connectionLost) {
                toast.error(connectionLost);
                return;
            }
            toast.error(t('chat.formCard.cancelFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            respondingRef.current = false;
            setIsResponding(false);
        }
    }, [chatDirectory, draftScope, form.id, form.sessionID, recovered, t, orphanedQuestion, onOrphanedResolved]);

    const goNext = React.useCallback(() => {
        setStep(Math.min(currentStep + 1, lastStep));
    }, [currentStep, lastStep]);

    const handleTextKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (isIMECompositionEvent(event)) return;
            if (event.key !== 'Enter' || event.shiftKey) return;
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                void handleSubmit();
                return;
            }
            if (isMobile) return;
            event.preventDefault();
            if (currentStep >= lastStep) void handleSubmit();
            else goNext();
        },
        [currentStep, goNext, handleSubmit, isMobile, lastStep],
    );

    const handlePanelKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !isIMECompositionEvent(event)) {
            event.preventDefault();
            void handleSubmit();
        }
    }, [handleSubmit]);

    const handleCopy = React.useCallback(async (format: 'markdown' | 'json') => {
        const text = format === 'markdown' ? serializeFormAsMarkdown(form) : serializeFormAsJson(form);
        const result = await copyTextToClipboard(text);
        if (result.ok) {
            toast.success(t(format === 'markdown' ? 'chat.questionCard.copiedMarkdown' : 'chat.questionCard.copiedJson'));
            return;
        }
        toast.error(t('chat.questionCard.copyFailed'));
    }, [form, t]);

    const title = form.title?.trim() || t('chat.formCard.inputNeeded');
    const orphanedCause = orphanedQuestion?.cause;
    const severalQuestions = (orphanedQuestion?.questions.length ?? 0) > 1;
    // The restart notice above the composer stays hidden while this card is
    // answerable, so the card names the cause it would have shown.
    const restartRecord = orphanedCause?.kind === 'opencode-restart' ? getRestartInterruption(session) : null;
    const causeKey = restartRecord && orphanedCause?.kind === 'opencode-restart' && restartRecord.at === orphanedCause.at
        ? RESTART_CAUSE_KEYS[restartRecord.cause]
        : null;
    const orphanedNotice = orphanedCause?.kind === 'opencode-restart'
        ? severalQuestions
            ? t('chat.questionCard.orphanedNoticeRestartPlural', { time: formatTimeForPreference(orphanedCause.at, timeFormatPreference) })
            : t('chat.questionCard.orphanedNoticeRestart', { time: formatTimeForPreference(orphanedCause.at, timeFormatPreference) })
        : orphanedCause?.kind === 'inactivity'
            ? severalQuestions ? t('chat.questionCard.orphanedNoticeInactivityPlural') : t('chat.questionCard.orphanedNoticeInactivity')
            : t('chat.questionCard.orphanedNotice');
    const stepLabel = (field: FormField, index: number) => field.title?.trim() || t('chat.questionCard.questionFallback', { index: String(index + 1) });
    const iconButtonClass = 'rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/30 hover:text-foreground';

    return (
        <ComposerFloatingPanel
            role="dialog"
            ariaLabel={title}
            compact={collapsed}
            holdReserve={collapse === 'reading'}
            header={<>
                <Tooltip>
                <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={toggleCollapsed}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? t('chat.formDock.expandAria') : t('chat.formDock.collapseAria')}
                    className="flex min-w-0 flex-1 items-center gap-2 text-start text-muted-foreground transition-colors hover:text-foreground"
                >
                    <Icon name="question" className="size-3.5 shrink-0 text-primary" />
                    <Icon name={collapsed ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" />
                    <span dir="auto" className="typography-ui-label min-w-0 truncate oc-ui-start-align text-foreground">{title}</span>
                    {isFromSubagent ? (
                        <span className="typography-micro shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-muted-foreground">
                            {t('chat.formCard.fromSubagent')}
                        </span>
                    ) : null}
                    {/* On a phone the step dots say the same, and the title needs the room. */}
                    {isMobile && shown.length > 1 ? null : (
                        <span className="typography-micro shrink-0 tabular-nums text-muted-foreground">
                            {t('chat.formDock.progress', { current: String(currentStep + 1), total: String(shown.length) })}
                        </span>
                    )}
                </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{collapsed ? t('chat.formDock.expandAria') : t('chat.formDock.collapseAria')}</TooltipContent>
                </Tooltip>
                {!collapsed ? (
                    <div className="flex shrink-0 items-center gap-1" role="tablist">
                        {shown.map((field, index) => (
                            <Tooltip key={field.key}>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        role="tab"
                                        aria-selected={index === currentStep}
                                        aria-label={t('chat.formDock.stepAria', { index: String(index + 1), title: stepLabel(field, index) })}
                                        onClick={() => setStep(index)}
                                        className="flex size-4 items-center justify-center"
                                    >
                                        <span
                                            className={cn(
                                                'block size-1.5 rounded-full transition-colors',
                                                index === currentStep
                                                    ? 'bg-primary'
                                                    : answered[index]
                                                        ? 'bg-primary/40'
                                                        : 'bg-foreground/15',
                                            )}
                                        />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={6}>{stepLabel(field, index)}</TooltipContent>
                            </Tooltip>
                        ))}
                    </div>
                ) : null}
                {waiting > 0 ? (
                    <span className="typography-micro shrink-0 text-muted-foreground">
                        {t('chat.formDock.waiting', { count: String(waiting) })}
                    </span>
                ) : null}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button type="button" onClick={() => void handleCopy('markdown')} aria-label={t('chat.questionCard.copyMarkdown')} className={iconButtonClass}>
                            <Icon name="file-text" className="size-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t('chat.questionCard.copyMarkdown')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button type="button" onClick={() => void handleCopy('json')} aria-label={t('chat.questionCard.copyJson')} className={iconButtonClass}>
                            <Icon name="code" className="size-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t('chat.questionCard.copyJson')}</TooltipContent>
                </Tooltip>
            </>}
        >
            {!collapsed ? (
                <div onKeyDown={handlePanelKeyDown} onFocus={trackAnswerFocus} onBlur={trackAnswerFocus}>
                    {orphanedQuestion ? (
                        <p className="typography-micro px-3 pb-2 text-muted-foreground">
                            {causeKey ? <>{t(causeKey)} </> : null}
                            {orphanedNotice}
                        </p>
                    ) : null}
                    {recovered || orphanedQuestion ? (
                        <div className="typography-micro mx-1.5 mb-1 rounded bg-[var(--status-warning-background)] px-2 py-1.5 text-[var(--status-warning-text)]">
                            {t(recovered?.evidence === 'deferred-on-send' ? 'chat.formCard.deferredNotice' : 'chat.formCard.recoveredNotice')}
                        </div>
                    ) : null}
                    <ScrollableOverlay
                        ref={bodyRef}
                        outerClassName="max-h-[50vh]"
                        outerStyle={availableMaxHeight === undefined ? undefined : { maxHeight: Math.max(120, availableMaxHeight - 96) }}
                        className="overscroll-contain px-1.5"
                        disableHorizontal
                    >
                        {currentField ? (
                            currentField.type === 'external' ? (
                                <div className="px-1.5 py-1">
                                    <div className="typography-meta font-medium text-foreground">{stepLabel(currentField, currentStep)}</div>
                                    {currentField.description ? (
                                        <FormMarkdown content={currentField.description} size="micro" className="mb-1 text-muted-foreground" />
                                    ) : null}
                                    <a
                                        href={currentField.url}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="typography-meta inline-flex items-center gap-1 text-primary hover:underline"
                                    >
                                        <Icon name="external-link" className="size-3" />
                                        {t('chat.formCard.openLink')}
                                    </a>
                                    <div className="typography-micro mt-1 text-muted-foreground">{t('chat.formDock.linkInfo')}</div>
                                </div>
                            ) : (
                                <FormFieldControl
                                    key={currentField.key}
                                    field={currentField}
                                    values={values}
                                    missing={missing}
                                    showErrors={showErrors}
                                    isResponding={isResponding}
                                    updateValue={updateValue}
                                    onTextKeyDown={handleTextKeyDown}
                                />
                            )
                        ) : null}
                    </ScrollableOverlay>

                    <div className="flex items-center gap-1.5 px-3 pb-2 pt-1">
                        <Button variant="ghost" size="xs" disabled={isResponding} onClick={() => void handleDismiss()}>
                            {t('chat.questionCard.dismiss')}
                        </Button>
                        {showErrors && !canSubmit ? (
                            <span className="typography-micro min-w-0 truncate text-[var(--status-error)]">{t('chat.formCard.missingRequired')}</span>
                        ) : null}
                        <div className="min-w-0 flex-1" />
                        {currentStep > 0 ? (
                            <Button variant="outline" size="xs" disabled={isResponding} onClick={() => setStep(currentStep - 1)}>
                                {t('chat.formDock.back')}
                            </Button>
                        ) : null}
                        {currentStep < lastStep ? (
                            <Button variant="outline" size="xs" disabled={isResponding} onClick={goNext}>
                                {t('chat.questionCard.next')}
                            </Button>
                        ) : (
                            <Button size="xs" disabled={!submitEnabled} onClick={() => void handleSubmit()}>
                                {isResponding ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="check" className="size-3.5" />}
                                {t('chat.formCard.submit')}
                            </Button>
                        )}
                    </div>
                </div>
            ) : null}
        </ComposerFloatingPanel>
    );
};

export const FormDock = React.memo(FormDockView);
