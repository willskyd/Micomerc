'use client'

export type QueueStatus = 'pending' | 'syncing' | 'synchronized' | 'failed' | 'conflicted'
export type QueuedOperation = {
  id: string
  type: string
  label: string
  createdAt: string
  status: QueueStatus
  payload: Record<string, unknown>
  target: string
  method: 'POST' | 'PATCH' | 'DELETE'
  dependsOn?: string | string[]
  recordCollection?: string
  recordId?: string | number
  error?: string
  completedAt?: string
}

export type CachedRecord = {
  key: string
  collection: string
  id: string | number
  value: unknown
  dirty: boolean
  tombstone?: boolean
  updatedAt: string
}

const DB_NAME = 'micomerc-offline-v1'
const STORE = 'operations'
const RECORDS = 'records'

/** Connectivity hint only: callers must still handle fetch failures when it returns true. */
export function shouldAttemptServerRequest(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine
}

export async function shouldQueueAfterServerFailure(response: Response): Promise<boolean> {
  const { status } = response
  if (!(status === 408 || status === 429 || (status >= 500 && status <= 599))) return false
  if (status !== 503) return true
  const result: unknown = await response.clone().json().catch(() => null)
  const message = typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string'
    ? result.message
    : ''
  return !/transaction support|transactions? (?:are only allowed|not supported)|does not support transactions/i.test(message)
}

function storageError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    return new Error(`${fallback}${name ? ` (${name}${error.message})` : error.message ? ` (${error.message})` : ''}`)
  }
  return new Error(fallback)
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('Offline storage is unavailable in this browser'))
    const request = indexedDB.open(DB_NAME, 3)
    let blockedTimer: ReturnType<typeof setTimeout> | undefined
    let blockedTimedOut = false
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
        store.createIndex('status', 'status')
      }
      if (!db.objectStoreNames.contains(RECORDS)) {
        const records = db.createObjectStore(RECORDS, { keyPath: 'key' })
        records.createIndex('collection', 'collection')
        records.createIndex('dirty', 'dirty')
      }
      const transaction = request.transaction
      const operations = transaction?.objectStore(STORE)
      if (operations && !operations.indexNames.contains('createdAt')) operations.createIndex('createdAt', 'createdAt')
      if (operations && !operations.indexNames.contains('status')) operations.createIndex('status', 'status')
      const records = transaction?.objectStore(RECORDS)
      if (records && !records.indexNames.contains('collection')) records.createIndex('collection', 'collection')
      if (records && !records.indexNames.contains('dirty')) records.createIndex('dirty', 'dirty')
    }
    // A blocked upgrade can still finish after another tab closes. Do not reject
    // immediately: that would make every offline create fail during a normal upgrade.
    request.onblocked = () => {
      if (!blockedTimer) blockedTimer = setTimeout(() => {
        blockedTimedOut = true
        reject(new Error('Offline database upgrade is blocked by another open Micomerc tab. Close older tabs, then retry.'))
      }, 10_000)
    }
    request.onsuccess = () => {
      if (blockedTimer) clearTimeout(blockedTimer)
      if (blockedTimedOut) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => {
      if (blockedTimer) clearTimeout(blockedTimer)
      reject(storageError(request.error, 'Could not open offline storage'))
    }
  })
}

export async function readLocalCollection<T>(collection: string): Promise<T[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(RECORDS, 'readonly').objectStore(RECORDS).index('collection').getAll(collection)
    request.onsuccess = () => resolve((request.result as CachedRecord[]).filter((record) => !record.tombstone).map((record) => record.value as T))
    request.onerror = () => reject(request.error ?? new Error(`Could not read local ${collection}`))
  })
}

export async function cacheServerCollection<T extends Record<string, unknown>>(collection: string, values: T[], idField = 'id'): Promise<void> {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(RECORDS, 'readwrite')
    const store = transaction.objectStore(RECORDS)
    const request = store.index('collection').getAll(collection)
    request.onsuccess = () => {
      const existing = request.result as CachedRecord[]
      // Server collection responses can be paginated or incomplete. Preserve cached
      // records unless an explicit delete operation is confirmed by the server.
      for (const value of values) {
        const id = value[idField]
        if (typeof id !== 'string' && typeof id !== 'number') continue
        const key = `${collection}:${String(id)}`
        const previous = existing.find((record) => record.key === key)
        if (!previous?.dirty) store.put({ key, collection, id, value, dirty: false, updatedAt: new Date().toISOString() } satisfies CachedRecord)
      }
    }
    request.onerror = () => transaction.abort()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not cache ${collection}`))
    transaction.onabort = () => reject(transaction.error ?? new Error(`Could not cache ${collection}`))
  })
}

/**
 * Reconcile a complete server collection response with the local cache.
 * Only clean records absent from the authoritative server response are removed.
 * Dirty records and tombstones are always preserved.
 */
export async function reconcileServerCollection<T extends Record<string, unknown>>(
  collection: string,
  values: T[],
  idField = 'id',
): Promise<void> {
  const db = await openDatabase()

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(RECORDS, 'readwrite')
    const store = transaction.objectStore(RECORDS)
    const request = store.index('collection').getAll(collection)

    request.onsuccess = () => {
      const existing = request.result as CachedRecord[]
      const serverIds = new Set(
        values
          .map((value) => value[idField])
          .filter((id): id is string | number =>
            typeof id === 'string' || typeof id === 'number',
          )
          .map(String),
      )

      for (const record of existing) {
        if (record.dirty || record.tombstone) continue

        if (!serverIds.has(String(record.id))) {
          store.delete(record.key)
        }
      }

      for (const value of values) {
        const id = value[idField]

        if (typeof id !== 'string' && typeof id !== 'number') continue

        const previous = existing.find(
          (record) => record.key === `${collection}:${String(id)}`,
        )

        if (previous?.dirty || previous?.tombstone) continue

        store.put({
          key: `${collection}:${String(id)}`,
          collection,
          id,
          value,
          dirty: false,
          updatedAt: new Date().toISOString(),
        } satisfies CachedRecord)
      }
    }

    request.onerror = () => transaction.abort()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(`Could not reconcile ${collection}`))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(`Could not reconcile ${collection}`))
  })
}

export async function saveLocalRecordAndOperation<T>(
  collection: string,
  id: string | number,
  value: T,
  operation: Omit<QueuedOperation, 'id' | 'createdAt' | 'status'> & { id?: string },
): Promise<QueuedOperation> {
  return saveLocalRecordsAndOperation([{ collection, id, value }], operation)
}

export async function saveLocalDeletionAndOperation(
  collection: string,
  id: string | number,
  operation: Omit<QueuedOperation, 'id' | 'createdAt' | 'status'> & { id?: string },
): Promise<QueuedOperation> {
  const operationValue: QueuedOperation = { ...operation, id: operation.id ?? crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending' }
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([RECORDS, STORE], 'readwrite')
    const records = transaction.objectStore(RECORDS)
    const existing = records.get(`${collection}:${String(id)}`)
    existing.onsuccess = () => {
      const previous = existing.result as CachedRecord | undefined
      records.put({ key: `${collection}:${String(id)}`, collection, id, value: previous?.value ?? null, dirty: true, tombstone: true, updatedAt: operationValue.createdAt } satisfies CachedRecord)
      transaction.objectStore(STORE).add(operationValue)
    }
    existing.onerror = () => transaction.abort()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Local deletion and pending operation could not be saved'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Local deletion and pending operation could not be saved'))
  })
  return operationValue
}

export async function deleteLocalRecord(collection: string, id: string | number): Promise<void> {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(RECORDS, 'readwrite').objectStore(RECORDS).delete(`${collection}:${String(id)}`)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error(`Could not delete local ${collection} record`))
  })
}

export async function saveLocalRecordsAndOperation(
  values: Array<{ collection: string; id: string | number; value: unknown }>,
  operation: Omit<QueuedOperation, 'id' | 'createdAt' | 'status'> & { id?: string },
): Promise<QueuedOperation> {
  const operationValue: QueuedOperation = { ...operation, id: operation.id ?? crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending' }
  if (!operationValue.id.trim() || !operationValue.type.trim() || !operationValue.target.trim() || !operationValue.payload || typeof operationValue.payload !== 'object' || !Array.isArray(values) || values.some((record) => !record || typeof record.collection !== 'string' || !record.collection.trim() || (typeof record.id === 'number' && !Number.isSafeInteger(record.id)) || (typeof record.id === 'string' && !record.id.trim()) || (typeof record.id !== 'number' && typeof record.id !== 'string'))) {
    throw new Error('Offline record details are invalid; nothing was saved.')
  }
  const db = await openDatabase()
  let savedOperation = operationValue
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([RECORDS, STORE], 'readwrite')
    const operations = transaction.objectStore(STORE)
    const existingRequest = operations.get(operationValue.id)
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as QueuedOperation | undefined
      if (existing) {
        const sameRequest = existing.type === operationValue.type && existing.target === operationValue.target && existing.method === operationValue.method && JSON.stringify(existing.payload) === JSON.stringify(operationValue.payload)
        if (!sameRequest) {
          transaction.abort()
          reject(new Error(`Operation ID ${operationValue.id} already exists with different data; nothing was saved.`))
          return
        }
        if (existing.status === 'synchronized') {
          transaction.abort()
          reject(new Error(`Operation ${operationValue.id} was already synchronized; create a new operation to make another change.`))
          return
        }
        // A retry of the same locally persisted operation is idempotent.
        savedOperation = existing
        for (const record of values) {
          const recordRequest = transaction.objectStore(RECORDS).get(`${record.collection}:${String(record.id)}`)
          recordRequest.onsuccess = () => {
            if (!recordRequest.result) transaction.objectStore(RECORDS).put({ key: `${record.collection}:${String(record.id)}`, ...record, dirty: true, updatedAt: existing.createdAt } satisfies CachedRecord)
          }
        }
        return
      }
      for (const record of values) transaction.objectStore(RECORDS).put({ key: `${record.collection}:${String(record.id)}`, ...record, dirty: true, updatedAt: operationValue.createdAt } satisfies CachedRecord)
      operations.add(operationValue)
    }
    existingRequest.onerror = () => transaction.abort()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(storageError(transaction.error, 'Local record and pending operation could not be saved'))
    transaction.onabort = () => reject(storageError(transaction.error, 'Local record and pending operation could not be saved'))
  })
  return savedOperation
}

export async function saveOfflineSaleAndOperation<T extends { id: string }>(
  sale: T,
  operation: Omit<QueuedOperation, 'id' | 'createdAt' | 'status'> & { id?: string },
  items: Array<{ productId: number; quantity: number; unitPriceMinor: number }>,
  lowStockThreshold: number,
): Promise<Array<Record<string, unknown>>> {
  const operationValue: QueuedOperation = { ...operation, id: operation.id ?? crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending', recordCollection: 'sales', recordId: sale.id }
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RECORDS, STORE], 'readwrite')
    const records = transaction.objectStore(RECORDS)
    const updates: Array<Record<string, unknown>> = []
    let validationError = ''
    let remaining = items.length
    const commit = () => {
      if (remaining !== 0 || validationError) return
      const now = new Date().toISOString()
      for (const product of updates) {
        records.put({ key: `products:${String(product.id)}`, collection: 'products', id: product.id as number, value: product, dirty: true, updatedAt: now } satisfies CachedRecord)
      }
      records.put({ key: `sales:${sale.id}`, collection: 'sales', id: sale.id, value: sale, dirty: true, updatedAt: now } satisfies CachedRecord)
      transaction.objectStore(STORE).add(operationValue)
    }
    if (!items.length) {
      validationError = 'The sale has no items.'
      transaction.abort()
    } else {
      for (const item of items) {
        const request = records.get(`products:${String(item.productId)}`)
        request.onsuccess = () => {
          const cached = request.result as CachedRecord | undefined
          const product = cached?.value as Record<string, unknown> | undefined
          const availableStock = Number(product?.stock) - Number(product?.reservedStock ?? 0)
          if (!cached || cached.tombstone || !product || product.id !== item.productId) validationError ||= `Product ${item.productId} is not available in local inventory.`
          else if (typeof product.stock !== 'number' || !Number.isFinite(product.stock) || !Number.isFinite(availableStock) || !Number.isFinite(item.quantity) || item.quantity <= 0 || availableStock < item.quantity) validationError ||= `Insufficient locally available stock for ${String(product.name ?? 'product')}. Available: ${Math.max(0, availableStock)}.`
          else if (typeof product.price !== 'number' || !Number.isFinite(product.price) || Math.round(product.price * 100) !== item.unitPriceMinor) validationError ||= `${String(product.name ?? 'Product')} changed in local inventory. Review the cart price before checkout.`
          else if (String(product.status ?? '').trim().toLowerCase() === 'discontinued') validationError ||= `${String(product.name ?? 'Product')} is discontinued and cannot be sold.`
          else {
            const stock = Math.round((product.stock - item.quantity) * 1000) / 1000
            updates.push({ ...product, stock, status: stock <= 0 ? 'Out of stock' : stock <= lowStockThreshold ? 'Low stock' : 'In stock' })
          }
          remaining -= 1
          if (validationError) transaction.abort()
          else commit()
        }
        request.onerror = () => { validationError ||= 'Could not read cached inventory.'; transaction.abort() }
      }
    }
    transaction.oncomplete = () => resolve(updates)
    transaction.onerror = () => reject(new Error(validationError || 'Sale, stock, and sync operation could not be saved locally'))
    transaction.onabort = () => reject(new Error(validationError || 'Sale, stock, and sync operation could not be saved locally'))
  })
}

export async function savePendingOrderAndOperation<T extends { id: string; items: Array<{ productId: number; quantity: number; unitPriceMinor?: number }> }>(
  order: T,
  operation: Omit<QueuedOperation, 'id' | 'createdAt' | 'status'> & { id?: string },
  action: 'reserve' | 'accept' | 'reject',
  lowStockThreshold = 0,
  sale?: { id: string },
): Promise<Array<Record<string, unknown>>> {
  const operationValue: QueuedOperation = { ...operation, id: operation.id ?? crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending', recordCollection: 'pendingOrders', recordId: order.id }
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RECORDS, STORE], 'readwrite')
    const records = transaction.objectStore(RECORDS)
    const operations = transaction.objectStore(STORE)
    const updates: Array<Record<string, unknown>> = []
    let remaining = order.items.length
    let validationError = ''
    let duplicateOperation = false
    const existingOperation = operations.get(operationValue.id)
    existingOperation.onsuccess = () => {
      if (existingOperation.result) {
        duplicateOperation = true
        if (JSON.stringify((existingOperation.result as QueuedOperation).payload) !== JSON.stringify(operationValue.payload)) {
          validationError = 'This operation ID is already attached to different pending-order data.'
          transaction.abort()
        }
        return
      }
      if (!order.items.length) { validationError = 'A pending order must contain at least one item.'; transaction.abort(); return }
      for (const item of order.items) {
        if (!Number.isSafeInteger(item.productId) || item.productId <= 0 || !Number.isFinite(item.quantity) || item.quantity <= 0 || Math.abs(item.quantity * 1000 - Math.round(item.quantity * 1000)) > 0.000001) {
          validationError = 'Pending order quantities are invalid.'
          transaction.abort()
          return
        }
        const request = records.get(`products:${String(item.productId)}`)
        request.onsuccess = () => {
          const cached = request.result as CachedRecord | undefined
          const product = cached?.value as Record<string, unknown> | undefined
          const stock = Number(product?.stock)
          const reserved = Number(product?.reservedStock ?? 0)
          if (!cached || cached.tombstone || !product || product.id !== item.productId || !Number.isFinite(stock) || !Number.isFinite(reserved)) validationError ||= `Product ${item.productId} is not available in local inventory.`
          else if (action === 'reserve' && stock - reserved < item.quantity) validationError ||= `Insufficient available stock for ${String(product.name ?? 'product')}. Available: ${Math.max(0, stock - reserved)}.`
          else if (action === 'reserve' && typeof item.unitPriceMinor === 'number' && (!Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0 || typeof product.price !== 'number' || Math.round(product.price * 100) !== item.unitPriceMinor)) validationError ||= `${String(product.name ?? 'Product')} changed in local inventory. Review the order price before submitting.`
          else if (action !== 'reserve' && reserved < item.quantity) validationError ||= `The local reservation for ${String(product.name ?? 'product')} is missing or changed.`
          else {
            const nextStock = action === 'accept' ? Math.round((stock - item.quantity) * 1000) / 1000 : stock
            const nextReserved = Math.round((reserved + (action === 'reserve' ? item.quantity : -item.quantity)) * 1000) / 1000
            if (nextStock < 0 || nextReserved < 0) validationError ||= `The local stock reservation for ${String(product.name ?? 'product')} is invalid.`
            else updates.push({ ...product, stock: nextStock, reservedStock: nextReserved, ...(action === 'accept' ? { status: nextStock <= 0 ? 'Out of stock' : nextStock <= lowStockThreshold ? 'Low stock' : 'In stock' } : {}) })
          }
          remaining -= 1
          if (validationError) transaction.abort()
          else if (remaining === 0) {
            const now = operationValue.createdAt
            for (const productUpdate of updates) records.put({ key: `products:${String(productUpdate.id)}`, collection: 'products', id: productUpdate.id as number, value: productUpdate, dirty: true, updatedAt: now } satisfies CachedRecord)
            records.put({ key: `pendingOrders:${order.id}`, collection: 'pendingOrders', id: order.id, value: order, dirty: true, updatedAt: now } satisfies CachedRecord)
            if (sale) records.put({ key: `sales:${sale.id}`, collection: 'sales', id: sale.id, value: sale, dirty: true, updatedAt: now } satisfies CachedRecord)
            operations.add(operationValue)
          }
        }
        request.onerror = () => { validationError ||= 'Could not read cached inventory.'; transaction.abort() }
      }
    }
    existingOperation.onerror = () => { validationError = 'Could not check local operation history.'; transaction.abort() }
    transaction.oncomplete = () => resolve(duplicateOperation ? [] : updates)
    transaction.onerror = () => reject(new Error(validationError || 'Pending order, inventory, and sync operation could not be saved locally'))
    transaction.onabort = () => reject(new Error(validationError || 'Pending order, inventory, and sync operation could not be saved locally'))
  })
}

export async function markLocalRecordSynchronized(collection: string, id: string | number, serverValue?: unknown): Promise<void> {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(RECORDS, 'readwrite')
    const store = transaction.objectStore(RECORDS)
    const key = `${collection}:${String(id)}`
    const request = store.get(key)
    request.onsuccess = () => {
      const record = request.result as CachedRecord | undefined
      if (!record) return
      if (record.tombstone) store.delete(key)
      else {
        const value = (serverValue ?? record.value) as Record<string, unknown>
        const serverId = value && (typeof value.id === 'string' || typeof value.id === 'number') ? value.id : id
        const serverKey = `${collection}:${String(serverId)}`
        if (serverKey !== key) store.delete(key)
        store.put({ key: serverKey, collection, id: serverId, value, dirty: false, updatedAt: new Date().toISOString() } satisfies CachedRecord)
      }
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not mark local record synchronized'))
  })
}

export async function writeLocalRecord<T>(collection: string, id: string | number, value: T, dirty = true): Promise<void> {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(RECORDS, 'readwrite')
    transaction.objectStore(RECORDS).put({ key: `${collection}:${String(id)}`, collection, id, value, dirty, updatedAt: new Date().toISOString() } satisfies CachedRecord)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not save local ${collection} record`))
    transaction.onabort = () => reject(transaction.error ?? new Error(`Could not save local ${collection} record`))
  })
}

export async function listQueuedOperations(): Promise<QueuedOperation[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    request.onsuccess = () => resolve((request.result as QueuedOperation[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    request.onerror = () => reject(request.error ?? new Error('Could not read offline operations'))
  })
}

/** Return unsynchronized inventory operations that touch any of the supplied products. */
export function findInventoryDependencies(operations: QueuedOperation[], productIds: number[]): string[] {
  const wanted = new Set(productIds)
  const inventoryTypes = /^(product\.|stock\.|sale\.|pending-order\.|store\.receipt\.|transfer\.)/
  const idsIn = (value: unknown, found = new Set<number>()): Set<number> => {
    if (!value || typeof value !== 'object') return found
    if (Array.isArray(value)) { for (const item of value) idsIn(item, found); return found }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'productId' || key === 'id') && typeof item === 'number' && Number.isSafeInteger(item)) found.add(item)
      else if (item && typeof item === 'object') idsIn(item, found)
    }
    return found
  }
  return operations.filter((operation) => {
    if (operation.status === 'synchronized' || !inventoryTypes.test(operation.type)) return false
    const operationProductIds = idsIn(operation.payload)
    if (operation.recordCollection === 'products' && typeof operation.recordId === 'number') operationProductIds.add(operation.recordId)
    return [...wanted].some((id) => operationProductIds.has(id))
  }).map((operation) => operation.id)
}

export async function saveQueuedOperation(operation: Omit<QueuedOperation, 'id' | 'createdAt' | 'status'> & { id?: string }): Promise<QueuedOperation> {
  const value: QueuedOperation = { ...operation, id: operation.id ?? crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending' }
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).add(value)
    request.onsuccess = () => resolve(value)
    request.onerror = () => reject(request.error ?? new Error('Could not save offline operation'))
  })
}

export async function updateQueuedOperation(operation: QueuedOperation): Promise<void> {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(operation)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('Could not update offline operation'))
  })
}
