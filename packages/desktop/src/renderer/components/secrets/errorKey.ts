/** Translate only known backend codes; never render arbitrary response bodies or values. */
export function secretErrorKey(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('REVISION_CONFLICT') || code.includes('MESSAGE_BUSY')) return 'settings.secrets.conflict' as const;
  if (code.includes('VAULT_LOCKED')) return 'settings.secrets.locked' as const;
  if (
    code.includes('FORBIDDEN') ||
    code.includes('PLUGIN_DISABLED') ||
    code.includes('CONTEXT_REQUIRED') ||
    code.includes('PROJECT_SCOPE_REQUIRED')
  )
    return 'settings.secrets.forbidden' as const;
  return 'settings.secrets.operationFailed' as const;
}
