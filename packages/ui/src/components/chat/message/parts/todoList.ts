import type { JsonValue } from '@openchamber/sdk';

export type Todo = { content: string; status: string; priority?: string; id?: string };

const isTodo = (value: JsonValue): value is JsonValue & Todo => (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof value.content === 'string'
    && typeof value.status === 'string'
);

/** The todo items of a todo tool result: the output array or `output.todos`. `null` when there are none. */
export const parseTodoList = (data: JsonValue): Todo[] | null => {
    const list = Array.isArray(data)
        ? data
        : typeof data === 'object' && data !== null && Array.isArray(data.todos) ? data.todos : null;
    if (!list) return null;
    const todos = list.filter(isTodo).map((todo) => ({
        content: todo.content,
        status: todo.status,
        ...(typeof todo.priority === 'string' ? { priority: todo.priority } : {}),
        ...(typeof todo.id === 'string' ? { id: todo.id } : {}),
    }));
    return todos.length > 0 ? todos : null;
};
