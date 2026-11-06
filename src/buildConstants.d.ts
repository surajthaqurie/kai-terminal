/**
 * Values injected into the CLI bundle at build time by `vite.cli.config.ts`
 * (from `KAI_BUILD_AZURE_CLIENT_ID` / `KAI_BUILD_TEAMS_CLIENT_ID`). They are
 * undeclared at runtime in source builds and in tests, so always read them through
 * `typeof`. They are public Microsoft Entra client IDs, not secrets.
 */
declare const __KAI_BUILD_AZURE_CLIENT_ID__: string | undefined;
declare const __KAI_BUILD_TEAMS_CLIENT_ID__: string | undefined;
