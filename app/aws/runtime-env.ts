/**
 * Node's process object is available in Lambda. Keeping access behind this
 * tiny helper lets these adapter seams type-check without requiring the Nuxt
 * client build to include Node ambient types.
 */
export function environmentValue(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }

  return runtime.process?.env?.[name]
}
