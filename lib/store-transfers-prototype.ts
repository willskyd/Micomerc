import type { PrototypeBranch, PrototypeTransfer, StoreReceivingRecord } from '@/components/dashboard/types'

export const STORE_TRANSFERS_STORAGE_KEY = 'micomerc-store-transfers-prototype-v1'

export type StoreTransfersPrototypeState = {
  receivingRecords: StoreReceivingRecord[]
  branches: PrototypeBranch[]
  transfers: PrototypeTransfer[]
}

export function createPrototypeId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  return `${prefix}-${randomId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`
}

export function createPrototypeReference(prefix: 'RCV' | 'TRF', date = new Date()): string {
  const datePart = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('')
  return `${prefix}-${datePart}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

export function createUniquePrototypeReference(prefix: 'RCV' | 'TRF', existingReferences: string[], date = new Date()): string {
  const base = createPrototypeReference(prefix, date)
  const used = new Set(existingReferences)
  let candidate = base
  let suffix = 1
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function localDateValue(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

export function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

export function calculateCartonUnits(cartons: number, unitsPerCarton: number | null): number | null {
  if (!Number.isSafeInteger(cartons) || cartons <= 0 || unitsPerCarton === null) return null
  if (!Number.isSafeInteger(unitsPerCarton) || unitsPerCarton <= 0) return null
  const total = cartons * unitsPerCarton
  return Number.isSafeInteger(total) && total <= 1_000_000_000 ? total : null
}

export function validateBranchName(value: string, branches: PrototypeBranch[], editingId?: string): string | null {
  const name = value.trim()
  if (!name) return 'Enter a branch name.'
  if (name.length > 80) return 'Branch names must be 80 characters or fewer.'
  if (branches.some((branch) => branch.id !== editingId && branch.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return 'A branch with that name already exists.'
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReceivingRecord(value: unknown): value is StoreReceivingRecord {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.reference === 'string' &&
    typeof value.productId === 'number' && typeof value.productName === 'string' &&
    typeof value.sku === 'string' && typeof value.barcode === 'string' &&
    typeof value.supplier === 'string' && typeof value.receivedAt === 'string' &&
    typeof value.cartons === 'number' && (typeof value.unitsPerCarton === 'number' || value.unitsPerCarton === null) &&
    (typeof value.totalUnits === 'number' || value.totalUnits === null) &&
    typeof value.deliveryReference === 'string' && typeof value.notes === 'string' &&
    value.status === 'Recorded' && typeof value.createdAt === 'string'
}

function isBranch(value: unknown): value is PrototypeBranch {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.createdAt === 'string'
}

function isTransfer(value: unknown): value is PrototypeTransfer {
  if (!isRecord(value) || !Array.isArray(value.lines)) return false
  return typeof value.id === 'string' && typeof value.reference === 'string' && typeof value.transferDate === 'string' &&
    typeof value.destinationBranchId === 'string' && typeof value.destinationNameAtTransfer === 'string' &&
    typeof value.sourceLocation === 'string' && value.lines.every((line: unknown) => isRecord(line) &&
      typeof line.productId === 'number' && typeof line.productName === 'string' && typeof line.sku === 'string' &&
      typeof line.barcode === 'string' && typeof line.quantity === 'number') &&
    typeof value.notes === 'string' && value.status === 'Recorded' && typeof value.createdAt === 'string'
}

export function parseStoreTransfersPrototype(value: unknown): StoreTransfersPrototypeState {
  if (!isRecord(value)) {
    return { receivingRecords: [], branches: [], transfers: [] }
  }
  const transfers = Array.isArray(value.transfers) ? value.transfers.filter(isTransfer) : []
  const branches = Array.isArray(value.branches) ? value.branches.filter(isBranch) : []
  const usedBranchIds = new Set(transfers.map((transfer) => transfer.destinationBranchId))
  const savedBranches = branches.filter((branch) => {
    const generatedPlaceholder =
      (branch.id === 'branch-1' && branch.name === 'Branch 1') ||
      (branch.id === 'branch-2' && branch.name === 'Branch 2')
    return !generatedPlaceholder || usedBranchIds.has(branch.id)
  })
  return {
    receivingRecords: Array.isArray(value.receivingRecords) ? value.receivingRecords.filter(isReceivingRecord) : [],
    branches: savedBranches,
    transfers,
  }
}
