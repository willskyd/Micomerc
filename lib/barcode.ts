export function normalizeBarcode(value: string): string {
  return value.trim()
}

export function isValidBarcode(value: string): boolean {
  return value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
}
