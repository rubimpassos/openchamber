import React from 'react';

export function useCommittedLayoutReady(ready: boolean, onReady?: () => void): void {
    React.useLayoutEffect(() => {
        if (ready) onReady?.();
    }, [ready, onReady]);
}
