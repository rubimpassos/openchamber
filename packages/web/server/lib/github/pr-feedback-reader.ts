type Repository = { readonly owner: string; readonly repo: string };
type Response = Promise<{ readonly data: unknown }>;

export type GitHubFeedbackQueryData = {
  readonly viewer?: unknown; readonly repository?: unknown; readonly errors?: unknown;
};

export type GitHubFeedbackReader = {
  readonly graphql: (query: string, variables: Repository & { readonly number: number }) => Promise<GitHubFeedbackQueryData>;
  readonly rest: {
    readonly repos: {
      readonly getCollaboratorPermissionLevel: (input: Repository & { readonly username: string }) => Response;
    };
    readonly checks: {
      readonly listAnnotations: (input: Repository & { readonly check_run_id: number; readonly per_page: number }) => Response;
    };
    readonly actions: {
      readonly getJobForWorkflowRun: (input: Repository & { readonly job_id: number }) => Response;
      readonly downloadJobLogsForWorkflowRun: (input: Repository & { readonly job_id: number }) => Response;
    };
  };
};
