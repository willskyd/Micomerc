export const MICOMERC_NAME = "Micomerc";

export function normalizeWorkspaceName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return MICOMERC_NAME;

  return /^electric[\s_-]*house$/i.test(value.trim())
    ? MICOMERC_NAME
    : value.trim();
}