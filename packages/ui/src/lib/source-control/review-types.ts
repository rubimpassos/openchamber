import type {
  MergeMethod,
  SourceControlExistingMutationTarget,
  SourceControlMutationContext,
  SourceControlUser,
} from './types';

export type ReviewerStateValue = 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface ChangeRequestReviewerState {
  user: SourceControlUser;
  state: ReviewerStateValue;
}

export interface MergeChangeRequestInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  method: MergeMethod;
  cancel?: boolean;
  /**
   * GitHub only, on a base branch with a merge queue: `queue` joins it once
   * the requirements pass, `direct` bypasses it and merges now.
   */
  action?: 'queue' | 'direct';
}
