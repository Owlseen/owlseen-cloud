/** What an API key may do. Only reading, for now: nothing a key can do changes anything. */
export const API_SCOPES = ["figures:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_NAMES: Record<ApiScope, string> = { "figures:read": "Read figures" };

/** What a key made through an assistant gets: reading, and nothing else. */
export const READ_SCOPES = API_SCOPES.filter((scope) => scope.endsWith(":read"));

export const onlyScopes = (values: readonly unknown[]): ApiScope[] => API_SCOPES.filter((scope) => values.includes(scope));
