import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { typography } from '@/lib/typography';
import { coerceToText } from '../toolRenderers';
import type { Todo } from './todoList';


const STATUSES = ['in_progress', 'pending', 'completed', 'cancelled'] as const;
type TodoStatus = (typeof STATUSES)[number];

const PRIORITY_COLOR: Record<string, string> = {
    high: 'var(--status-error)',
    medium: 'var(--primary)',
    low: 'var(--status-info)',
};

const PriorityDot: React.FC<{ priority?: string }> = ({ priority }) => (
    <div
        className="mt-1 h-2 w-2 flex-shrink-0 rounded-full"
        style={priority && PRIORITY_COLOR[priority]
            ? { backgroundColor: PRIORITY_COLOR[priority] }
            : { backgroundColor: 'var(--muted-foreground)', opacity: 0.5 }}
    />
);

/**
 * The expanded body of a `todowrite` / `todoread` call (OpenCode 1.x, or a
 * plugin such as oh-my-openagent on 2.x): the counts line, then the items
 * grouped by status with priority dots. Same layout the 1.x chat drew.
 */
export const TodoListOutput: React.FC<{ todos: readonly Todo[] }> = ({ todos }) => {
    const { t } = useI18n();
    const groups: Record<TodoStatus, Todo[]> = { in_progress: [], pending: [], completed: [], cancelled: [] };
    for (const todo of todos) {
        if ((STATUSES as readonly string[]).includes(todo.status)) groups[todo.status as TodoStatus].push(todo);
    }
    const label: Record<TodoStatus, string> = {
        in_progress: t('chat.todo.inProgress'),
        pending: t('chat.todo.pending'),
        completed: t('chat.todo.completed'),
        cancelled: t('chat.todo.cancelled'),
    };
    const item = (todo: Todo, index: number, lead: React.ReactNode, textClass = 'text-foreground') => (
        <div key={todo.id ?? index} className="flex items-start gap-2">
            {lead}
            <span className={`typography-code flex-1 leading-relaxed ${textClass}`}>{coerceToText(todo.content)}</span>
        </div>
    );

    return (
        <div className="w-full min-w-0 space-y-3" style={typography.tool.popup} data-todo-list>
            <div className="typography-meta flex flex-wrap gap-x-4 gap-y-1 border-b border-border/20 pb-2">
                <span className="font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('chat.todo.total')}: {todos.length}</span>
                {groups.in_progress.length > 0 && (
                    <span className="font-medium" style={{ color: 'var(--foreground)' }}>{label.in_progress}: {groups.in_progress.length}</span>
                )}
                {groups.pending.length > 0 && (
                    <span style={{ color: 'var(--muted-foreground)' }}>{label.pending}: {groups.pending.length}</span>
                )}
                {groups.completed.length > 0 && (
                    <span style={{ color: 'var(--status-success)' }}>{label.completed}: {groups.completed.length}</span>
                )}
                {groups.cancelled.length > 0 && (
                    <span style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>{label.cancelled}: {groups.cancelled.length}</span>
                )}
            </div>

            {groups.in_progress.length > 0 && (
                <div className="space-y-2">
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-2 animate-pulse rounded-full" style={{ backgroundColor: 'var(--foreground)' }} />
                        <span className="typography-meta font-semibold uppercase tracking-wide text-foreground">{label.in_progress}</span>
                    </div>
                    <div className="space-y-1.5 pl-4">
                        {groups.in_progress.map((todo, index) => item(todo, index, <PriorityDot priority={todo.priority} />))}
                    </div>
                </div>
            )}

            {groups.pending.length > 0 && (
                <div className="space-y-2">
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-muted-foreground/50" />
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{label.pending}</span>
                    </div>
                    <div className="space-y-1.5 pl-4">
                        {groups.pending.map((todo, index) => item(todo, index, <PriorityDot priority={todo.priority} />))}
                    </div>
                </div>
            )}

            {groups.completed.length > 0 && (
                <div className="space-y-2">
                    <div className="flex items-center gap-2">
                        <Icon name="check" className="h-3 w-3" style={{ color: 'var(--status-success)' }} />
                        <span className="typography-meta font-semibold uppercase tracking-wide" style={{ color: 'var(--status-success)' }}>{label.completed}</span>
                    </div>
                    <div className="space-y-1.5 pl-4">
                        {groups.completed.map((todo, index) => item(
                            todo,
                            index,
                            <Icon name="check" className="mt-0.5 h-3 w-3 flex-shrink-0" style={{ color: 'var(--status-success)', opacity: 0.7 }} />,
                        ))}
                    </div>
                </div>
            )}

            {groups.cancelled.length > 0 && (
                <div className="space-y-2">
                    <div className="flex items-center gap-2">
                        <span className="h-3 w-3 text-muted-foreground/50">×</span>
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/50">{label.cancelled}</span>
                    </div>
                    <div className="space-y-1.5 pl-4">
                        {groups.cancelled.map((todo, index) => item(
                            todo,
                            index,
                            <span className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground/50">×</span>,
                            'text-muted-foreground/50 line-through',
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
