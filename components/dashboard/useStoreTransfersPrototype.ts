'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Product, PrototypeBranch, PrototypeTransfer, StoreReceivingRecord } from './types'
import { cacheServerCollection, findInventoryDependencies, listQueuedOperations, readLocalCollection, reconcileServerCollection, saveLocalRecordsAndOperation, shouldAttemptServerRequest, shouldQueueAfterServerFailure, type QueuedOperation } from '@/lib/offline-queue'

type StoreTransferState = { receivingRecords: StoreReceivingRecord[]; branches: PrototypeBranch[]; transfers: PrototypeTransfer[] }
const EMPTY: StoreTransferState = { receivingRecords: [], branches: [], transfers: [] }

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string' ? result.message : fallback
    throw new Error(message)
  }
  return result as T
}

export function useStoreTransfersPrototype(onInventoryChanged?: (updates: Product[]) => void) {
  const [state, setState] = useState<StoreTransferState>(EMPTY)
  const [hydrated, setHydrated] = useState(false)
  const [persistenceError, setPersistenceError] = useState('')
  const editRequestKeys = useRef(new Map<string, string>())

  const getEditRequestKey = useCallback((signature: string) => {
    const known = editRequestKeys.current.get(signature)
    if (known) return known
    const key = crypto.randomUUID()
    editRequestKeys.current.set(signature, key)
    return key
  }, [])

  const reload = useCallback(async () => {
    const [cachedReceipts, cachedBranches, cachedTransfers] = await Promise.all([readLocalCollection<StoreReceivingRecord>('storeReceipts'), readLocalCollection<PrototypeBranch>('branches'), readLocalCollection<PrototypeTransfer>('transfers')])
    if (!navigator.onLine) {
      setState({ receivingRecords: cachedReceipts, branches: cachedBranches, transfers: cachedTransfers })
      setPersistenceError('')
      return
    }

    try {
      const [receiptsResponse, branchesResponse, transfersResponse] = await Promise.all([fetch('/api/store', { cache: 'no-store' }), fetch('/api/branches', { cache: 'no-store' }), fetch('/api/transfers', { cache: 'no-store' })])
      const [receivingRecords, branches, transfers] = await Promise.all([readJson<StoreReceivingRecord[]>(receiptsResponse, 'Store records are unavailable'), readJson<PrototypeBranch[]>(branchesResponse, 'Branches are unavailable'), readJson<PrototypeTransfer[]>(transfersResponse, 'Transfer history is unavailable')])
      if (![receivingRecords, branches, transfers].every((records) => Array.isArray(records) && records.every((record) => record && (typeof record.id === 'string' || typeof record.id === 'number')))) {
        throw new Error('The server returned invalid Store or Transfer records')
      }
      await Promise.all([
        reconcileServerCollection('storeReceipts', receivingRecords as Array<StoreReceivingRecord & Record<string, unknown>>),
        reconcileServerCollection('branches', branches as Array<PrototypeBranch & Record<string, unknown>>),
        reconcileServerCollection('transfers', transfers as Array<PrototypeTransfer & Record<string, unknown>>),
      ])
      const [mergedReceipts, mergedBranches, mergedTransfers] = await Promise.all([readLocalCollection<StoreReceivingRecord>('storeReceipts'), readLocalCollection<PrototypeBranch>('branches'), readLocalCollection<PrototypeTransfer>('transfers')])
      setState({ receivingRecords: mergedReceipts, branches: mergedBranches, transfers: mergedTransfers })
      setPersistenceError('')
    } catch (error) {
      setState({ receivingRecords: cachedReceipts, branches: cachedBranches, transfers: cachedTransfers })
      throw error
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void reload().catch((error: unknown) => {
        if (!cancelled) setPersistenceError(error instanceof Error ? error.message : 'Store and Transfer records could not be loaded')
      }).finally(() => { if (!cancelled) setHydrated(true) })
    }
    refresh()
    window.addEventListener('online', refresh)
    window.addEventListener('micomerc-queue-changed', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('online', refresh)
      window.removeEventListener('micomerc-queue-changed', refresh)
    }
  }, [reload])

  const addReceivingRecord = useCallback(async (record: StoreReceivingRecord) => {
    const payload = { ...record, idempotencyKey: record.id }
    const queuedBefore = await listQueuedOperations()
    const dependencies = findInventoryDependencies(queuedBefore, [record.productId])
    let saved: StoreReceivingRecord
    let response: Response | null = null
    if (!dependencies.length && shouldAttemptServerRequest()) try { response = await fetch('/api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch (error) { if (!(error instanceof TypeError)) throw error }
    if (response?.ok) saved = await readJson<StoreReceivingRecord>(response, 'Store receipt could not be saved')
    else {
      if (response && !await shouldQueueAfterServerFailure(response)) await readJson<StoreReceivingRecord>(response, 'Store receipt could not be saved')
      const products = await readLocalCollection<Record<string, unknown> & { id: number; stock: number }>('products')
      const product = products.find((item) => item.id === record.productId)
      if (!product || !Number.isFinite(product.stock) || !Number.isFinite(record.stockUnits)) throw new Error('Cached inventory for this product is unavailable; the receipt was not saved locally.')
      const stock = product.stock + Number(record.stockUnits)
      if (!Number.isFinite(stock) || stock > 1_000_000_000) throw new Error('Receipt quantity exceeds the supported stock limit.')
      const updatedProduct = { ...product, stock, status: stock <= 0 ? 'Out of stock' : stock <= 30 ? 'Low stock' : 'In stock' }
      saved = { ...record, revision: 1, stockAdjusted: true }
      await saveLocalRecordsAndOperation([{ collection: 'products', id: product.id, value: updatedProduct }, { collection: 'storeReceipts', id: record.id, value: saved }], { id: record.id, type: 'store.receipt.create', label: `Receive stock ${record.reference}`, target: '/api/store', method: 'POST', payload, ...(dependencies.length ? { dependsOn: dependencies } : {}), recordCollection: 'storeReceipts', recordId: record.id })
      onInventoryChanged?.([updatedProduct as Product])
    }
    setState((current) => ({ ...current, receivingRecords: [saved, ...current.receivingRecords.filter((item) => item.id !== saved.id)] }))
    if (response?.ok) await cacheServerCollection('storeReceipts', [saved])
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    return saved
  }, [onInventoryChanged])

  const updateReceivingRecord = useCallback(async (id: string, record: StoreReceivingRecord, expectedRevision: number) => {
    const signature = JSON.stringify({ id, expectedRevision, record })
    const operationId = getEditRequestKey(signature)
    const payload = { ...record, expectedRevision, idempotencyKey: operationId }
    const queuedBefore = await listQueuedOperations()
    const dependencies = findInventoryDependencies(queuedBefore, [record.productId])
    let response: Response | null = null
    if (!dependencies.length && shouldAttemptServerRequest()) try { response = await fetch(`/api/store/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch (error) { if (!(error instanceof TypeError)) throw error }
    let saved: StoreReceivingRecord
    if (response?.ok) saved = await readJson<StoreReceivingRecord>(response, 'Store receipt could not be updated')
    else {
      if (response && !await shouldQueueAfterServerFailure(response)) await readJson<StoreReceivingRecord>(response, 'Store receipt could not be updated')
      const old = (await readLocalCollection<StoreReceivingRecord>('storeReceipts')).find((item) => item.id === id)
      if (!old) throw new Error('The original cached receipt is unavailable; this edit cannot be saved offline.')
      const products = await readLocalCollection<Record<string, unknown> & { id: number; stock: number }>('products')
      const product = products.find((item) => item.id === record.productId)
      if (!product || old.productId !== record.productId) throw new Error('Cached product inventory is unavailable for this receipt edit.')
      const stock = product.stock + Number(record.stockUnits ?? 0) - Number(old.stockUnits ?? 0)
      if (!Number.isFinite(stock) || stock < Number(product.reservedStock ?? 0)) throw new Error('This receipt edit would make cached stock lower than pending reservations.')
      saved = { ...record, revision: expectedRevision + 1, stockAdjusted: true }
      await saveLocalRecordsAndOperation([{ collection: 'products', id: product.id, value: { ...product, stock } }, { collection: 'storeReceipts', id, value: saved }], { id: operationId, type: 'store.receipt.update', label: `Edit stock receipt ${record.reference}`, target: `/api/store/${encodeURIComponent(id)}`, method: 'PATCH', payload, ...(dependencies.length ? { dependsOn: dependencies } : {}), recordCollection: 'storeReceipts', recordId: id })
      onInventoryChanged?.([{ ...product, stock } as Product])
    }
    setState((current) => ({ ...current, receivingRecords: current.receivingRecords.map((item) => item.id === saved.id ? saved : item) }))
    if (response?.ok) await cacheServerCollection('storeReceipts', [saved])
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    return saved
  }, [getEditRequestKey, onInventoryChanged])

  const addTransfer = useCallback(async (transfer: PrototypeTransfer) => {
    const payload = { ...transfer, idempotencyKey: transfer.id }
    const queuedBefore = await listQueuedOperations()
    const dependencies = findInventoryDependencies(queuedBefore, transfer.lines.map((line) => line.productId))
    let response: Response | null = null
    if (!dependencies.length && shouldAttemptServerRequest()) try { response = await fetch('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch (error) { if (!(error instanceof TypeError)) throw error }
    let saved: PrototypeTransfer
    if (response?.ok) saved = await readJson<PrototypeTransfer>(response, 'Transfer could not be saved')
    else {
      if (response && !await shouldQueueAfterServerFailure(response)) await readJson<PrototypeTransfer>(response, 'Transfer could not be saved')
      const products = await readLocalCollection<Record<string, unknown> & { id: number; stock: number }>('products')
      const updates = transfer.lines.map((line) => {
        const product = products.find((item) => item.id === line.productId)
        if (!product || !Number.isFinite(line.stockUnits) || product.stock - Number(product.reservedStock ?? 0) < line.stockUnits) throw new Error(`Cached available stock is unavailable or insufficient for ${line.productName}.`)
        return { ...product, stock: product.stock - line.stockUnits }
      })
      saved = { ...transfer, revision: 1 }
      await saveLocalRecordsAndOperation([...updates.map((value) => ({ collection: 'products', id: value.id, value })), { collection: 'transfers', id: transfer.id, value: saved }], { id: transfer.id, type: 'transfer.create', label: `Record transfer ${transfer.reference}`, target: '/api/transfers', method: 'POST', payload, ...(dependencies.length ? { dependsOn: dependencies } : {}), recordCollection: 'transfers', recordId: transfer.id })
      onInventoryChanged?.(updates as Product[])
    }
    setState((current) => ({ ...current, transfers: [saved, ...current.transfers.filter((item) => item.id !== saved.id)] }))
    if (response?.ok) await cacheServerCollection('transfers', [saved])
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    return saved
  }, [onInventoryChanged])

  const updateTransfer = useCallback(async (id: string, transfer: PrototypeTransfer, expectedRevision: number) => {
    const signature = JSON.stringify({ id, expectedRevision, transfer })
    const operationId = getEditRequestKey(signature)
    const payload = { ...transfer, expectedRevision, idempotencyKey: operationId }
    const previousTransfer = (await readLocalCollection<PrototypeTransfer>('transfers')).find((item) => item.id === id)
    const queuedBefore = await listQueuedOperations()
    const affectedProductIds = [...new Set([...transfer.lines, ...(previousTransfer?.lines ?? [])].map((line) => line.productId))]
    const dependencies = findInventoryDependencies(queuedBefore, affectedProductIds)
    let response: Response | null = null
    if (!dependencies.length && shouldAttemptServerRequest()) try { response = await fetch(`/api/transfers/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch (error) { if (!(error instanceof TypeError)) throw error }
    let saved: PrototypeTransfer
    if (response?.ok) saved = await readJson<PrototypeTransfer>(response, 'Transfer could not be updated')
    else {
      if (response && !await shouldQueueAfterServerFailure(response)) await readJson<PrototypeTransfer>(response, 'Transfer could not be updated')
      const old = previousTransfer
      if (!old) throw new Error('The original cached transfer is unavailable; this edit cannot be saved offline.')
      const deltas = new Map<number, number>()
      for (const line of old.lines) deltas.set(line.productId, (deltas.get(line.productId) ?? 0) + line.stockUnits)
      for (const line of transfer.lines) deltas.set(line.productId, (deltas.get(line.productId) ?? 0) - line.stockUnits)
      const products = await readLocalCollection<Record<string, unknown> & { id: number; stock: number }>('products')
      const updates = [...deltas].map(([productId, delta]) => { const product = products.find((item) => item.id === productId); const stock = product ? product.stock + delta : NaN; if (!product || !Number.isFinite(stock) || stock < Number(product.reservedStock ?? 0)) throw new Error(`Cached available stock is unavailable or insufficient for product ${productId}.`); return { ...product, stock } })
      saved = { ...transfer, revision: expectedRevision + 1 }
      await saveLocalRecordsAndOperation([...updates.map((value) => ({ collection: 'products', id: value.id, value })), { collection: 'transfers', id, value: saved }], { id: operationId, type: 'transfer.update', label: `Edit transfer ${transfer.reference}`, target: `/api/transfers/${encodeURIComponent(id)}`, method: 'PATCH', payload, ...(dependencies.length ? { dependsOn: dependencies } : {}), recordCollection: 'transfers', recordId: id })
      onInventoryChanged?.(updates as Product[])
    }
    setState((current) => ({ ...current, transfers: current.transfers.map((item) => item.id === saved.id ? saved : item) }))
    if (response?.ok) await cacheServerCollection('transfers', [saved])
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    return saved
  }, [getEditRequestKey, onInventoryChanged])

  const addBranch = useCallback(async (name: string): Promise<string | null> => {
    const id = crypto.randomUUID()
    const payload = { id, name, operationId: id }
    let response: Response | null = null
    if (shouldAttemptServerRequest()) try { response = await fetch('/api/branches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch (error) { if (!(error instanceof TypeError)) throw error }
    try {
      let branch: PrototypeBranch
      if (response?.ok) branch = await readJson<PrototypeBranch>(response, 'Branch could not be saved')
      else {
        if (response && !await shouldQueueAfterServerFailure(response)) await readJson<PrototypeBranch>(response, 'Branch could not be saved')
        branch = { id, name: name.trim(), createdAt: new Date().toISOString(), revision: 0 }
        await saveLocalRecordsAndOperation([{ collection: 'branches', id, value: branch }], { id, type: 'branch.create', label: `Add branch ${branch.name}`, target: '/api/branches', method: 'POST', payload, recordCollection: 'branches', recordId: id })
      }
      setState((current) => ({ ...current, branches: [...current.branches.filter((item) => item.id !== branch.id), branch] }))
      if (response?.ok) await cacheServerCollection('branches', [branch])
      window.dispatchEvent(new Event('micomerc-queue-changed'))
      return null
    } catch (error) { return error instanceof Error ? error.message : 'Branch could not be saved' }
  }, [])

  const renameBranch = useCallback(async (id: string, name: string): Promise<string | null> => {
    const branchBefore = state.branches.find((item) => item.id === id)
    if (!branchBefore) return 'The branch is not available in local data.'
    const operationId = crypto.randomUUID()
    const payload = { name, operationId, expectedRevision: branchBefore.revision ?? 0 }
    let response: Response | null = null
    if (shouldAttemptServerRequest()) try { response = await fetch(`/api/branches/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch (error) { if (!(error instanceof TypeError)) throw error }
    try {
      let branch: PrototypeBranch
      if (response?.ok) branch = await readJson<PrototypeBranch>(response, 'Branch could not be renamed')
      else {
        if (response && !await shouldQueueAfterServerFailure(response)) await readJson<PrototypeBranch>(response, 'Branch could not be renamed')
        branch = { ...branchBefore, name: name.trim(), revision: (branchBefore.revision ?? 0) + 1 }
        const queued = await listQueuedOperations(); const prior = queued.filter((item) => item.type.startsWith('branch.') && item.recordId === id && item.status !== 'synchronized').map((item) => item.id)
        await saveLocalRecordsAndOperation([{ collection: 'branches', id, value: branch }], { id: operationId, type: 'branch.rename', label: `Rename branch ${id}`, target: `/api/branches/${encodeURIComponent(id)}`, method: 'PATCH', payload, ...(prior.length ? { dependsOn: prior } : {}), recordCollection: 'branches', recordId: id })
      }
      setState((current) => ({ ...current, branches: current.branches.map((item) => item.id === branch.id ? branch : item) }))
      if (response?.ok) await cacheServerCollection('branches', [branch])
      window.dispatchEvent(new Event('micomerc-queue-changed'))
      return null
    } catch (error) { return error instanceof Error ? error.message : 'Branch could not be renamed' }
  }, [state.branches])

  return {
    receivingRecords: state.receivingRecords,
    branches: state.branches,
    transfers: state.transfers,
    persistenceError,
    hydrated,
    addReceivingRecord,
    updateReceivingRecord,
    addTransfer,
    updateTransfer,
    addBranch,
    renameBranch,
    reload,
  }
}
