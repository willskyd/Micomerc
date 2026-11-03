'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Check, ClipboardCheck, History, PackageCheck, Plus, RotateCcw, Search, Store, X } from 'lucide-react'
import { cacheServerCollection, listQueuedOperations, readLocalCollection, saveLocalRecordAndOperation, shouldAttemptServerRequest, writeLocalRecord, type QueuedOperation } from '@/lib/offline-queue'
import type { Product, Sale } from '../types'
import { money } from '../utils'

type Line = { productId: number; name: string; quantity: number; condition: 'sellable' | 'damaged' | 'quarantined'; unitPriceMinor: number }
type ReturnRecord = { id: string; operationId: string; reference: string; saleId: string | null; reason: string; notes: string; items: Line[]; amountMinor: number; status: string; refundStatus: string; inventoryStatus: string; createdAt: string; history: Array<{ at: string; event: string; detail: string }>; localPending?: boolean }

type CompanyReplacement = { id: string; supplierName: string; originalReturnReference: string; productId: number; productName: string; quantityReceived: number; receivedAt: string; condition: 'New' | 'Used' | 'Damaged'; notes: string; createdAt: string }
type CompanyReturnRecord = {
  id: string
  reference: string
  supplierName: string
  productId: number
  productName: string
  quantityReturned: number
  unitCostMinor: number
  reason: string
  returnDate: string
  notes: string
  status: 'Draft' | 'Awaiting Replacement' | 'Partially Replaced' | 'Fully Replaced' | 'Closed'
  outstandingQuantity: number
  totalReceived: number
  replacements: CompanyReplacement[]
  createdAt: string
  updatedAt: string
  history: Array<{ at: string; event: string; detail: string }>
  localPending?: boolean
}

const statusPill = (value: string) => ({
  Draft: '#e8eefc',
  'Awaiting Replacement': '#fff0d9',
  'Partially Replaced': '#fef3c7',
  'Fully Replaced': '#dcfce7',
  Closed: '#f1f5f9',
}[value] ?? '#eef2ff')

function dateTimestamp(value: string) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function ReturnsSection({ currency }: { currency: string }) {
  const [tab, setTab] = useState<'company' | 'customer'>('company')
  const [customerRecords, setCustomerRecords] = useState<ReturnRecord[]>([])
  const [companyRecords, setCompanyRecords] = useState<CompanyReturnRecord[]>([])
  const [sales, setSales] = useState<Sale[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [showHistory, setShowHistory] = useState(false)
  const [openCustomer, setOpenCustomer] = useState(false)
  const [openCompany, setOpenCompany] = useState(false)
  const [openReplacement, setOpenReplacement] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<ReturnRecord | null>(null)
  const [selectedCompany, setSelectedCompany] = useState<CompanyReturnRecord | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [queue, setQueue] = useState<QueuedOperation[]>([])
  const [refundReference, setRefundReference] = useState('')

  const loadCustomerData = useCallback(async () => {
    const [localQueue, cachedReturns, cachedSales, cachedProducts] = await Promise.all([listQueuedOperations(), readLocalCollection<ReturnRecord>('returns'), readLocalCollection<Sale>('sales'), readLocalCollection<Product>('products')])
    setQueue(localQueue)
    if (!sales.length && cachedSales.length) setSales(cachedSales)
    if (!products.length && cachedProducts.length) setProducts(cachedProducts)
    let rows = cachedReturns
    if (navigator.onLine) try {
      const response = await fetch('/api/returns', { cache: 'no-store' })
      if (response.ok) {
        const remote = await response.json()
        if (Array.isArray(remote)) {
          await cacheServerCollection('returns', remote)
          rows = await readLocalCollection<ReturnRecord>('returns')
        }
      }
    } catch {
      // keep local cache visible
    }
    const pendingCreates = localQueue.filter((item) => item.type === 'return.create' && item.status !== 'synchronized')
    const localRecords = pendingCreates.filter((item) => !rows.some((row) => row.id === item.id)).map((item) => {
      const payload = item.payload as unknown as { saleId?: string | null; reason: string; notes: string; items: Line[] }
      return {
        id: item.id,
        operationId: item.id,
        reference: `LOCAL-${item.id.slice(0, 8).toUpperCase()}`,
        saleId: payload.saleId ?? null,
        reason: payload.reason,
        notes: payload.notes,
        items: payload.items,
        amountMinor: payload.items.reduce((n, line) => n + Math.round(line.unitPriceMinor * line.quantity), 0),
        status: 'pending-review',
        refundStatus: 'pending',
        inventoryStatus: 'not-restocked',
        createdAt: item.createdAt,
        history: [{ at: item.createdAt, event: 'Saved on this device', detail: 'Pending explicit synchronization' }],
        localPending: true,
      } satisfies ReturnRecord
    })
    setCustomerRecords([...rows, ...localRecords])
  }, [products.length, sales.length])

  const loadCompanyData = useCallback(async () => {
    const localQueue = await listQueuedOperations()
    const cachedCompanyReturns = await readLocalCollection<CompanyReturnRecord>('company-returns')
    let rows = cachedCompanyReturns
    if (navigator.onLine) try {
      const response = await fetch('/api/company-returns', { cache: 'no-store' })
      if (response.ok) {
        const remote = await response.json()
        if (Array.isArray(remote)) {
          await cacheServerCollection('company-returns', remote)
          rows = await readLocalCollection<CompanyReturnRecord>('company-returns')
        }
      }
    } catch {
      // keep cached data visible
    }
    const pendingCreates = localQueue.filter((item) => item.type === 'company-return.create' && item.status !== 'synchronized')
    const localRecords = pendingCreates.filter((item) => !rows.some((row) => row.id === item.id)).map((item) => {
      const payload = item.payload as unknown as { supplierName: string; productId: number; productName: string; quantityReturned: number; unitCostMinor: number; reason: string; returnDate: string; notes: string }
      const record: CompanyReturnRecord = {
        id: item.id,
        reference: `LOCAL-${item.id.slice(0, 8).toUpperCase()}`,
        supplierName: payload.supplierName,
        productId: payload.productId,
        productName: payload.productName,
        quantityReturned: payload.quantityReturned,
        unitCostMinor: payload.unitCostMinor,
        reason: payload.reason,
        returnDate: payload.returnDate,
        notes: payload.notes,
        status: 'Awaiting Replacement',
        outstandingQuantity: payload.quantityReturned,
        totalReceived: 0,
        replacements: [],
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        history: [{ at: item.createdAt, event: 'Saved on this device', detail: 'Pending explicit synchronization' }],
        localPending: true,
      }
      return record
    })
    setCompanyRecords([...rows, ...localRecords])
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([loadCustomerData(), loadCompanyData()])
  }, [loadCompanyData, loadCustomerData])

  useEffect(() => {
    void refresh()
    let cancelled = false
    if (navigator.onLine) {
      fetch('/api/sales?limit=50').then(async (res) => { if (!res.ok) return; const rows = await res.json(); if (Array.isArray(rows)) { await cacheServerCollection('sales', rows); if (!cancelled) setSales(rows) } }).catch(() => undefined)
      fetch('/api/products').then(async (res) => { if (!res.ok) return; const rows = await res.json(); if (Array.isArray(rows)) { await cacheServerCollection('products', rows); if (!cancelled) setProducts(rows) } }).catch(() => undefined)
    }
    const handler = () => { void refresh() }
    window.addEventListener('micomerc-queue-changed', handler)
    return () => { cancelled = true; window.removeEventListener('micomerc-queue-changed', handler) }
  }, [refresh])

  const customerVisible = useMemo(() => customerRecords
    .filter((row) => (filter === 'all' || row.status === filter || row.refundStatus === filter) && `${row.reference} ${row.reason} ${row.saleId ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => dateTimestamp(b.createdAt) - dateTimestamp(a.createdAt)), [customerRecords, filter, query])
  const companyVisible = useMemo(() => companyRecords
    .filter((row) => (filter === 'all' || row.status === filter) && `${row.reference} ${row.supplierName} ${row.productName} ${row.reason}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => dateTimestamp(b.createdAt) - dateTimestamp(a.createdAt)), [companyRecords, filter, query])
  const displayedCustomerReturns = showHistory ? customerVisible : customerVisible.slice(0, 20)
  const displayedCompanyReturns = showHistory ? companyVisible : companyVisible.slice(0, 20)

  const companyTotals = useMemo(() => ({
    totalReturns: companyRecords.length,
    totalCustomerReturns: customerRecords.length,
    outstandingReplacementQty: companyRecords.reduce((sum, row) => sum + row.outstandingQuantity, 0),
    completedReturns: companyRecords.filter((row) => row.status === 'Fully Replaced' || row.status === 'Closed').length,
  }), [companyRecords, customerRecords])

  const customerCounts = {
    review: customerRecords.filter((row) => row.status === 'pending-review').length,
    approved: customerRecords.filter((row) => row.status === 'approved').length,
    refundPending: customerRecords.filter((row) => row.refundStatus === 'pending').length,
    refunded: customerRecords.filter((row) => row.refundStatus === 'completed').length,
    rejected: customerRecords.filter((row) => row.status === 'rejected').length,
  }

  const queueCustomerAction = async (record: ReturnRecord, action: string, extra: Record<string, unknown> = {}) => {
    const operationId = crypto.randomUUID()
    const dependsOn = [...queue].reverse().find((item) => (item.id === record.id || item.target === `/api/returns/${record.id}`) && item.status !== 'synchronized')?.id
    const payload = { action, operationId, ...extra }
    let queuedLocally = false
    if (!record.localPending && !dependsOn && shouldAttemptServerRequest()) {
      let response: Response | null = null
      try { response = await fetch(`/api/returns/${encodeURIComponent(record.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch (error) { if (!(error instanceof TypeError)) throw error }
      const result = response ? await response.json().catch(() => null) : null
      if (response?.ok) await writeLocalRecord('returns', record.id, result, false)
      else if (response) throw new Error(typeof result?.message === 'string' ? result.message : `Return update failed (${response.status})`)
      else {
        queuedLocally = true
        const history = [...record.history, { at: new Date().toISOString(), event: `${action} queued locally`, detail: 'Pending explicit synchronization' }]
        const next: ReturnRecord = { ...record, history, localPending: true }
        await saveLocalRecordAndOperation('returns', record.id, next, { id: operationId, type: `return.${action}`, label: `${action.replace('-', ' ')} ${record.reference}`, target: `/api/returns/${record.id}`, method: 'PATCH', payload, ...(dependsOn ? { dependsOn } : {}), recordCollection: 'returns', recordId: record.id })
        setNotice('Customer return action saved on this device and is waiting for manual synchronization.')
      }
    } else {
      queuedLocally = true
      const history = [...record.history, { at: new Date().toISOString(), event: `${action} queued locally`, detail: 'Pending explicit synchronization' }]
      const next: ReturnRecord = { ...record, history, localPending: true }
      await saveLocalRecordAndOperation('returns', record.id, next, { id: operationId, type: `return.${action}`, label: `${action.replace('-', ' ')} ${record.reference}`, target: `/api/returns/${record.id}`, method: 'PATCH', payload, ...(dependsOn ? { dependsOn } : {}), recordCollection: 'returns', recordId: record.id })
      setNotice('Customer return action saved on this device and is waiting for manual synchronization.')
    }
    if (!queuedLocally) setNotice('Customer return action confirmed by the server.')
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    setSelectedCustomer(null)
    await refresh()
  }

  const handleCustomerSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setNotice('')
    const data = new FormData(event.currentTarget)
    const saleId = String(data.get('saleId') || '')
    const sale = sales.find((item) => item.id === saleId)
    const productId = Number(data.get('productId'))
    const saleLine = sale?.items.find((item) => item.productId === productId)
    const productName = saleLine?.name ?? products.find((product) => product.id === productId)?.name ?? String(data.get('productName') ?? '').trim()
    const quantity = Number(data.get('quantity'))
    const previouslyReturned = sale ? customerRecords.filter((record) => record.saleId === sale.id && record.status !== 'rejected').flatMap((record) => record.items).filter((line) => line.productId === productId).reduce((total, line) => total + line.quantity, 0) : 0
    const eligibleQuantity = saleLine ? Math.max(0, saleLine.quantity - previouslyReturned) : Number.POSITIVE_INFINITY
    if (!productId || !productName || !Number.isFinite(quantity) || quantity <= 0 || (sale && !saleLine) || (saleLine && quantity > eligibleQuantity)) {
      setError(saleLine ? `Choose a valid item and a quantity within ${eligibleQuantity} remaining eligible units.` : sale ? 'The selected product is not part of the original transaction.' : 'Choose a valid return item and quantity.')
      return
    }
    const operationId = crypto.randomUUID()
    const payload = {
      operationId,
      saleId: sale?.id ?? null,
      reason: String(data.get('reason') || ''),
      notes: String(data.get('notes') ?? ''),
      items: [{ productId, name: productName, quantity, condition: String(data.get('condition')) as Line['condition'], unitPriceMinor: saleLine?.unitPriceMinor ?? 0 }],
    }
    const queuedOperations = await listQueuedOperations()
    const saleDependency = sale ? queuedOperations.find((item) => item.status !== 'synchronized' && (item.recordCollection === 'sales' && item.recordId === sale.id || item.type === 'sale.create' && ((item.payload.saleId === sale.id) || ((item.payload.localSale as { id?: string } | undefined)?.id === sale.id))))?.id : undefined
    const saveLocally = async () => {
      const at = new Date().toISOString()
      const local: ReturnRecord = {
        id: operationId,
        operationId,
        reference: `LOCAL-${operationId.slice(0, 8).toUpperCase()}`,
        saleId: sale?.id ?? null,
        reason: payload.reason,
        notes: payload.notes,
        items: payload.items,
        amountMinor: payload.items.reduce((n, line) => n + Math.round(line.unitPriceMinor * line.quantity), 0),
        status: 'pending-review',
        refundStatus: 'pending',
        inventoryStatus: 'not-restocked',
        createdAt: at,
        history: [{ at, event: 'Saved on this device', detail: 'Pending explicit synchronization' }],
        localPending: true,
      }
      await saveLocalRecordAndOperation('returns', operationId, local, { id: operationId, type: 'return.create', label: `Create return${sale ? ` for ${sale.receiptNumber}` : ''}`, target: '/api/returns', method: 'POST', payload, ...(saleDependency ? { dependsOn: saleDependency } : {}), recordCollection: 'returns', recordId: operationId })
    }
    let response: Response | null = null
    if (!saleDependency && shouldAttemptServerRequest()) {
      try { response = await fetch('/api/returns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch (error) { if (!(error instanceof TypeError)) throw error }
    }
    const result = response ? await response.json().catch(() => null) : null
    if (response?.ok) {
      await writeLocalRecord('returns', operationId, result, false)
      setNotice('Customer return saved to the server.')
    } else if (response) {
      setError(typeof result?.message === 'string' ? result.message : `Customer return save failed (${response.status})`)
      return
    } else {
      await saveLocally()
      setNotice('Customer return saved locally and is waiting for manual synchronization.')
    }
    setOpenCustomer(false)
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    await refresh()
  }

  const handleCompanySubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setNotice('')
    const data = new FormData(event.currentTarget)
    const supplierName = String(data.get('supplierName') ?? '').trim()
    const productId = Number(data.get('productId'))
    const product = products.find((item) => item.id === productId)
    const quantityReturned = Number(data.get('quantityReturned'))
    const unitCostMinor = Math.round(Number(data.get('unitCost') ?? 0) * 100)
    const reason = String(data.get('reason') ?? '').trim()
    const returnDate = String(data.get('returnDate') ?? '').trim()
    const notes = String(data.get('notes') ?? '').trim()
    if (!supplierName || !product || !Number.isFinite(quantityReturned) || quantityReturned <= 0 || !reason || !returnDate || !Number.isFinite(unitCostMinor) || unitCostMinor <= 0) {
      setError('Complete the supplier, product, quantity, cost, reason and return date before saving.')
      return
    }
    const operationId = crypto.randomUUID()
    const payload = {
      operationId,
      supplierName,
      productId,
      productName: product.name,
      quantityReturned,
      unitCostMinor,
      reason,
      returnDate,
      notes,
    }
    const saveLocal = async () => {
      const at = new Date().toISOString()
      const local: CompanyReturnRecord = {
        id: operationId,
        reference: `LOCAL-${operationId.slice(0, 8).toUpperCase()}`,
        supplierName,
        productId,
        productName: product.name,
        quantityReturned,
        unitCostMinor,
        reason,
        returnDate,
        notes,
        status: 'Awaiting Replacement',
        outstandingQuantity: quantityReturned,
        totalReceived: 0,
        replacements: [],
        createdAt: at,
        updatedAt: at,
        history: [{ at, event: 'Return saved on this device', detail: 'Awaiting explicit synchronization' }],
        localPending: true,
      }
      await saveLocalRecordAndOperation('company-returns', operationId, local, { id: operationId, type: 'company-return.create', label: `Create company return ${supplierName}`, target: '/api/company-returns', method: 'POST', payload, recordCollection: 'company-returns', recordId: operationId })
    }
    try {
      let response: Response | null = null
      if (shouldAttemptServerRequest()) {
        try { response = await fetch('/api/company-returns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
        catch (error) { if (!(error instanceof TypeError)) throw error }
      }
      const result = response ? await response.json().catch(() => null) : null
      if (response?.ok) {
        await writeLocalRecord('company-returns', operationId, result, false)
        setNotice('Company return saved to the server.')
      } else if (response) {
        setError(typeof result?.message === 'string' ? result.message : `Company return save failed (${response.status})`)
        return
      } else {
        await saveLocal()
        setNotice('Company return saved locally and is waiting for manual synchronization.')
      }
      setOpenCompany(false)
      window.dispatchEvent(new Event('micomerc-queue-changed'))
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Company return could not be saved')
    }
  }

  const handleReplacementSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setNotice('')
    if (!selectedCompany) {
      setError('Select a company return before recording a replacement receipt.')
      return
    }
    const data = new FormData(event.currentTarget)
    const quantityReceived = Number(data.get('quantityReceived'))
    const condition = String(data.get('condition') || 'New') as CompanyReplacement['condition']
    const notes = String(data.get('notes') ?? '').trim()
    const receivedAt = String(data.get('receivedAt') ?? '').trim()
    if (!Number.isFinite(quantityReceived) || quantityReceived <= 0 || !receivedAt || !['New', 'Used', 'Damaged'].includes(condition)) {
      setError('Enter a valid received quantity, date and condition for the replacement receipt.')
      return
    }
    try {
      const payload = {
        operationId: crypto.randomUUID(),
        action: 'receive-replacement',
        supplierName: selectedCompany.supplierName,
        originalReturnReference: selectedCompany.reference,
        productId: selectedCompany.productId,
        productName: selectedCompany.productName,
        quantityReceived,
        condition,
        notes,
        receivedAt,
      }
      const queued = await listQueuedOperations()
      const dependencies = queued.filter((item) => item.status !== 'synchronized' && item.recordId === selectedCompany.id && item.type.startsWith('company-return.')).map((item) => item.id)
      const at = new Date().toISOString()
      const updated: CompanyReturnRecord = {
        ...selectedCompany,
        totalReceived: selectedCompany.totalReceived + quantityReceived,
        outstandingQuantity: Math.max(0, selectedCompany.outstandingQuantity - quantityReceived),
        status: Math.max(0, selectedCompany.outstandingQuantity - quantityReceived) === 0 ? 'Fully Replaced' : 'Partially Replaced',
        replacements: [...selectedCompany.replacements, { id: payload.operationId, supplierName: selectedCompany.supplierName, originalReturnReference: selectedCompany.reference, productId: selectedCompany.productId, productName: selectedCompany.productName, quantityReceived, receivedAt, condition, notes, createdAt: at }],
        updatedAt: at,
        history: [...selectedCompany.history, { at, event: 'Replacement received', detail: `${quantityReceived} ${selectedCompany.productName} units · ${dependencies.length ? 'pending synchronization' : 'server confirmed'}` }],
      }
      const saveLocally = async () => {
        const local = { ...updated, localPending: true }
        await saveLocalRecordAndOperation('company-returns', selectedCompany.id, local, { id: payload.operationId, type: 'company-return.replacement', label: `Receive replacement for ${selectedCompany.reference}`, target: `/api/company-returns/${selectedCompany.id}`, method: 'PATCH', payload, ...(dependencies.length ? { dependsOn: dependencies } : {}), recordCollection: 'company-returns', recordId: selectedCompany.id })
        return local
      }
      let response: Response | null = null
      if (!dependencies.length && shouldAttemptServerRequest()) {
        try { response = await fetch(`/api/company-returns/${selectedCompany.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
        catch (error) { if (!(error instanceof TypeError)) throw error }
      }
      if (response?.ok) {
        const result = await response.json()
        await writeLocalRecord('company-returns', selectedCompany.id, result, false)
        setNotice('Replacement receipt recorded and stock adjusted.')
      } else if (response) {
        const result = await response.json().catch(() => null)
        setError(typeof result?.message === 'string' ? result.message : `Replacement receipt could not be saved (${response.status}).`)
        return
      } else {
        await saveLocally()
        setNotice('Replacement receipt saved locally · waiting for Sync Now.')
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Replacement receipt could not be saved')
      return
    }
    setOpenReplacement(false)
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    await refresh()
  }

  return <div className="returns-page" style={{ display: 'grid', gap: 18 }}>
    {notice && <p className="offline-note" role="status" style={{ margin: 0 }}>{notice}</p>}
    <div className="stat-grid returns-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
      <div className="stat-card" style={{ padding: 16, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Total company returns</span>
        <strong style={{ fontSize: 24 }}>{companyTotals.totalReturns}</strong>
      </div>
      <div className="stat-card" style={{ padding: 16, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Total customer returns</span>
        <strong style={{ fontSize: 24 }}>{companyTotals.totalCustomerReturns}</strong>
      </div>
      <div className="stat-card" style={{ padding: 16, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Outstanding replacement qty</span>
        <strong style={{ fontSize: 24 }}>{companyTotals.outstandingReplacementQty}</strong>
      </div>
      <div className="stat-card" style={{ padding: 16, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Completed returns</span>
        <strong style={{ fontSize: 24 }}>{companyTotals.completedReturns}</strong>
      </div>
    </div>

    <div style={{ display: 'flex', gap: 8, padding: 4, borderRadius: 12, background: 'var(--panel)', border: '1px solid var(--line)', width: 'fit-content' }}>
      <button className="secondary-button" onClick={() => { setTab('company'); setShowHistory(false) }} style={{ border: tab === 'company' ? '1px solid var(--green)' : '1px solid var(--line)', background: tab === 'company' ? 'var(--soft)' : 'transparent' }}>Company Returns</button>
      <button className="secondary-button" onClick={() => { setTab('customer'); setShowHistory(false) }} style={{ border: tab === 'customer' ? '1px solid var(--green)' : '1px solid var(--line)', background: tab === 'customer' ? 'var(--soft)' : 'transparent' }}>Customer Returns</button>
    </div>

    {tab === 'company' ? (
      <section className="panel returns-panel" style={{ display: 'grid', gap: 0, overflow: 'hidden' }}>
        <div className="returns-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 16, borderBottom: '1px solid var(--line)', alignItems: 'center' }}>
          <label className="returns-search" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 180, minHeight: 38, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search supplier, product or reference" style={{ width: '100%', border: 0, background: 'transparent', color: 'var(--fg)', outline: 'none' }} />
          </label>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} style={{ minHeight: 38, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}>
            <option value="all">All company returns</option>
            <option value="Draft">Draft</option>
            <option value="Awaiting Replacement">Awaiting Replacement</option>
            <option value="Partially Replaced">Partially Replaced</option>
            <option value="Fully Replaced">Fully Replaced</option>
            <option value="Closed">Closed</option>
          </select>
          {companyVisible.length > 20 && <button type="button" className="secondary-button" onClick={() => setShowHistory((value) => !value)} aria-expanded={showHistory}><History size={15} />{showHistory ? 'Back to Recent' : 'View History'}</button>}
          <button className="primary-button" onClick={() => setOpenCompany(true)}><Plus size={16} /> New return</button>
        </div>
        <div style={{ padding: 16, overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11 }}>
                <th style={{ padding: '10px 8px' }}>Reference</th>
                <th style={{ padding: '10px 8px' }}>Supplier</th>
                <th style={{ padding: '10px 8px' }}>Product</th>
                <th style={{ padding: '10px 8px' }}>Qty returned</th>
                <th style={{ padding: '10px 8px' }}>Outstanding</th>
                <th style={{ padding: '10px 8px' }}>Status</th>
                <th style={{ padding: '10px 8px' }}>Date</th>
                <th style={{ padding: '10px 8px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedCompanyReturns.map((row) => (
                <tr key={row.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '12px 8px', fontWeight: 700 }}>{row.reference}</td>
                  <td style={{ padding: '12px 8px' }}>{row.supplierName}</td>
                  <td style={{ padding: '12px 8px' }}>{row.productName}</td>
                  <td style={{ padding: '12px 8px' }}>{row.quantityReturned}</td>
                  <td style={{ padding: '12px 8px' }}>{row.outstandingQuantity}</td>
                  <td style={{ padding: '12px 8px' }}><span className="status-pill" style={{ background: statusPill(row.status), color: '#1f2937', padding: '4px 8px', borderRadius: 999, fontSize: 10 }}>{row.status}</span></td>
                  <td style={{ padding: '12px 8px' }}>{new Date(row.returnDate).toLocaleDateString()}</td>
                  <td style={{ padding: '12px 8px' }}><button className="secondary-button" onClick={() => setSelectedCompany(row)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {companyVisible.length === 0 && <div className="empty" style={{ padding: '18px 12px' }}><RotateCcw size={18} /><b>No company returns yet</b><span>Add a supplier return to track replacements and stock movement.</span></div>}
        </div>
      </section>
    ) : (
      <section className="panel returns-panel" style={{ display: 'grid', gap: 0, overflow: 'hidden' }}>
        <div className="returns-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 16, borderBottom: '1px solid var(--line)', alignItems: 'center' }}>
          <label className="returns-search" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 180, minHeight: 38, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer, product or reference" style={{ width: '100%', border: 0, background: 'transparent', color: 'var(--fg)', outline: 'none' }} />
          </label>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} style={{ minHeight: 38, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}>
            <option value="all">All customer returns</option>
            <option value="pending-review">Pending Inspection</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="pending">Refund pending</option>
            <option value="completed">Completed</option>
          </select>
          {customerVisible.length > 20 && <button type="button" className="secondary-button" onClick={() => setShowHistory((value) => !value)} aria-expanded={showHistory}><History size={15} />{showHistory ? 'Back to Recent' : 'View History'}</button>}
          <button className="primary-button" onClick={() => setOpenCustomer(true)}><Plus size={16} /> New return</button>
        </div>
        <div style={{ padding: 16, overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11 }}>
                <th style={{ padding: '10px 8px' }}>Reference</th>
                <th style={{ padding: '10px 8px' }}>Original sale</th>
                <th style={{ padding: '10px 8px' }}>Reason</th>
                <th style={{ padding: '10px 8px' }}>Amount</th>
                <th style={{ padding: '10px 8px' }}>Status</th>
                <th style={{ padding: '10px 8px' }}>Refund</th>
                <th style={{ padding: '10px 8px' }}>Sync</th>
                <th style={{ padding: '10px 8px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedCustomerReturns.map((row) => (
                <tr key={row.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '12px 8px', fontWeight: 700 }}>{row.reference}</td>
                  <td style={{ padding: '12px 8px' }}>{sales.find((sale) => sale.id === row.saleId)?.receiptNumber ?? (row.saleId ? row.saleId.slice(0, 12) : 'No sale linked')}</td>
                  <td style={{ padding: '12px 8px' }}>{row.reason}</td>
                  <td style={{ padding: '12px 8px' }}>{money(row.amountMinor / 100, currency)}</td>
                  <td style={{ padding: '12px 8px' }}><span className="status-pill" style={{ background: '#eef2ff', padding: '4px 8px', borderRadius: 999, fontSize: 10 }}>{row.status}</span></td>
                  <td style={{ padding: '12px 8px' }}>{row.refundStatus}</td>
                  <td style={{ padding: '12px 8px' }}>{row.localPending ? 'Local' : 'Synced'}</td>
                  <td style={{ padding: '12px 8px' }}><button className="secondary-button" onClick={() => setSelectedCustomer(row)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {customerVisible.length === 0 && <div className="empty" style={{ padding: '18px 12px' }}><RotateCcw size={18} /><b>No customer returns found</b><span>Use the form to log a customer return and keep inspection and refunds separate.</span></div>}
        </div>
      </section>
    )}

    {openCompany && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpenCompany(false)}><section className="modal" style={{ width: 'min(640px, calc(100vw - 24px))' }}>
      <div className="modal-header"><div><div className="eyebrow">Company returns</div><h2>Create return to company</h2></div><button className="icon-button" onClick={() => setOpenCompany(false)}><X /></button></div>
      <form onSubmit={(event) => void handleCompanySubmit(event)} style={{ display: 'grid', gap: 14, padding: 18 }}>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Supplier / company name<input name="supplierName" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Product<select name="productId" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}><option value="">Choose product</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Quantity returned<input type="number" name="quantityReturned" min="1" step="1" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Unit cost<input type="number" name="unitCost" min="0.01" step="0.01" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Return reason<select name="reason" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}><option value="">Choose reason</option><option value="Defective product">Defective product</option><option value="Wrong delivery">Wrong delivery</option><option value="Damaged in transit">Damaged in transit</option><option value="Supplier quality issue">Supplier quality issue</option><option value="Other">Other</option></select></label>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Return date<input type="date" name="returnDate" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        </div>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Notes<textarea name="notes" rows={3} style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        {error && <p className="field-error" style={{ margin: 0, color: '#b91c1c' }}>{error}</p>}
        <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="secondary-button" onClick={() => setOpenCompany(false)}>Cancel</button>
          <button className="primary-button" type="submit"><Check size={16} /> Save company return</button>
        </div>
      </form>
    </section></div>}

    {openCustomer && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpenCustomer(false)}><section className="modal" style={{ width: 'min(640px, calc(100vw - 24px))' }}>
      <div className="modal-header"><div><div className="eyebrow">Customer returns</div><h2>Create customer return</h2></div><button className="icon-button" onClick={() => setOpenCustomer(false)}><X /></button></div>
      <form onSubmit={(event) => void handleCustomerSubmit(event)} style={{ display: 'grid', gap: 14, padding: 18 }}>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Original sale<select name="saleId" defaultValue="" style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}><option value="">Choose sale</option>{sales.map((sale) => <option value={sale.id} key={sale.id}>{sale.receiptNumber}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Returned product<select name="productId" required onChange={(event) => { const input = event.currentTarget.form?.elements.namedItem('productName') as HTMLInputElement | null; if (input) input.value = products.find((product) => product.id === Number(event.target.value))?.name ?? '' }} style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}><option value="">Choose product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select><input type="hidden" name="productName" /></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Quantity<input name="quantity" type="number" min="0.001" step="0.001" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Return reason<select name="reason" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}><option value="">Choose reason</option><option>Defective item</option><option>Wrong item</option><option>Customer changed mind</option><option>Other</option></select></label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Condition<select name="condition" style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}><option value="sellable">Sellable</option><option value="damaged">Damaged</option><option value="quarantined">Quarantined</option></select></label>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Resolution<select name="resolution" style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}><option value="refund">Refund</option><option value="exchange">Exchange</option><option value="store-credit">Store credit</option></select></label>
        </div>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Notes<textarea name="notes" rows={3} style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        {error && <p className="field-error" style={{ margin: 0, color: '#b91c1c' }}>{error}</p>}
        <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="secondary-button" onClick={() => setOpenCustomer(false)}>Cancel</button>
          <button className="primary-button" type="submit"><Check size={16} /> Save customer return</button>
        </div>
      </form>
    </section></div>}

    {selectedCustomer && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedCustomer(null)}><section className="modal" style={{ width: 'min(700px, calc(100vw - 24px))' }}>
      <div className="modal-header"><div><div className="eyebrow">{selectedCustomer.reference}</div><h2>Customer return detail</h2></div><button className="icon-button" onClick={() => setSelectedCustomer(null)}><X /></button></div>
      <div style={{ display: 'grid', gap: 16, padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
          <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}><small style={{ color: 'var(--muted)', display: 'block' }}>Status</small><b>{selectedCustomer.status}</b></div>
          <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}><small style={{ color: 'var(--muted)', display: 'block' }}>Refund status</small><b>{selectedCustomer.refundStatus}</b></div>
          <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}><small style={{ color: 'var(--muted)', display: 'block' }}>Inventory</small><b>{selectedCustomer.inventoryStatus}</b></div>
          <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}><small style={{ color: 'var(--muted)', display: 'block' }}>Amount</small><b>{money(selectedCustomer.amountMinor / 100, currency)}</b></div>
        </div>
        <div>
          <h3 style={{ margin: '0 0 8px' }}>Items</h3>
          {selectedCustomer.items.map((line, index) => <p key={`${line.productId}-${index}`} style={{ margin: '0 0 6px' }}>{line.name} · {line.quantity} · {line.condition}</p>)}
        </div>
        <div>
          <h3 style={{ margin: '0 0 8px' }}>Timeline</h3>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8 }}>
            {selectedCustomer.history.map((event, index) => <li key={`${event.at}-${index}`}><b>{event.event}</b><span style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>{event.detail} · {new Date(event.at).toLocaleString()}</span></li>)}
          </ol>
        </div>
        <div className="return-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
{selectedCustomer.status === 'approved' && (
  <>
    <button
      className="secondary-button"
      onClick={() =>
        void queueCustomerAction(selectedCustomer, 'inspect', {
          condition: 'sellable',
        })
      }
    >
      <PackageCheck size={16} /> Inspect sellable
    </button>

    <button
      className="secondary-button"
      onClick={() =>
        void queueCustomerAction(selectedCustomer, 'restock', {
          confirmed: true,
        })
      }
    >
      Confirm restock
    </button>

    <div style={{ display: 'grid', gap: 8, width: '100%', maxWidth: 360 }}>
      <label style={{ fontSize: 12, color: 'var(--muted)' }}>
        Processed refund reference
      </label>

      <input
        type="text"
        value={refundReference}
        onChange={(event) => setRefundReference(event.target.value)}
        placeholder="Enter refund reference"
        style={{
          width: '100%',
          padding: '10px 12px',
          border: '1px solid var(--line)',
          borderRadius: 8,
          background: 'var(--panel)',
          color: 'var(--fg)',
        }}
      />

      <button
        className="primary-button"
        disabled={!refundReference.trim()}
        onClick={() =>
          void queueCustomerAction(selectedCustomer, 'confirm-refund', {
            confirmed: true,
            refundReference: refundReference.trim(),
          })
        }
      >
        Confirm refund processed
      </button>
    </div>
  </>
)}          {selectedCustomer.status === 'approved' && <><button className="secondary-button" onClick={() => void queueCustomerAction(selectedCustomer, 'inspect', { condition: 'sellable' })}><PackageCheck size={16} /> Inspect sellable</button><button className="secondary-button" onClick={() => void queueCustomerAction(selectedCustomer, 'restock', { confirmed: true })}>Confirm restock</button><button className="primary-button" onClick={() => { const refundReference = window.prompt('Enter the processed refund reference before confirming.'); if (refundReference?.trim()) void queueCustomerAction(selectedCustomer, 'confirm-refund', { confirmed: true, refundReference: refundReference.trim() }) }}>Confirm refund processed</button></>}
        </div>
      </div>
    </section></div>}

    {selectedCompany && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedCompany(null)}><section className="modal" style={{ width: 'min(760px, calc(100vw - 24px))' }}>
      <div className="modal-header"><div><div className="eyebrow">{selectedCompany.reference}</div><h2>Company return overview</h2></div><button className="icon-button" onClick={() => setSelectedCompany(null)}><X /></button></div>
      <div style={{ display: 'grid', gap: 18, padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10 }}>
          <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}><small style={{ color: 'var(--muted)', display: 'block' }}>Supplier</small><b>{selectedCompany.supplierName}</b></div>
          <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}><small style={{ color: 'var(--muted)', display: 'block' }}>Product</small><b>{selectedCompany.productName}</b></div>
          <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}><small style={{ color: 'var(--muted)', display: 'block' }}>Returned</small><b>{selectedCompany.quantityReturned}</b></div>
          <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}><small style={{ color: 'var(--muted)', display: 'block' }}>Outstanding</small><b>{selectedCompany.outstandingQuantity}</b></div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="status-pill" style={{ background: statusPill(selectedCompany.status), padding: '6px 10px', borderRadius: 999 }}>{selectedCompany.status}</span>
          <button className="secondary-button" onClick={() => { setOpenReplacement(true); setSelectedCompany(selectedCompany) }}><ArrowDownLeft size={16} /> Record replacement</button>
        </div>
        <div>
          <h3 style={{ margin: '0 0 8px' }}>Replacement receipts</h3>
          {selectedCompany.replacements.length === 0 ? <p style={{ margin: 0, color: 'var(--muted)' }}>No replacement receipts recorded yet.</p> : <div style={{ display: 'grid', gap: 8 }}>{selectedCompany.replacements.map((replacement) => <div key={replacement.id} style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8, display: 'grid', gap: 4 }}><strong>{replacement.productName} · {replacement.quantityReceived} units</strong><span style={{ color: 'var(--muted)', fontSize: 11 }}>{replacement.supplierName || selectedCompany.supplierName} · {replacement.originalReturnReference || selectedCompany.reference}</span><span style={{ color: 'var(--muted)', fontSize: 11 }}>{replacement.condition} · {new Date(replacement.receivedAt).toLocaleDateString()}</span>{replacement.notes && <span style={{ color: 'var(--muted)', fontSize: 11 }}>{replacement.notes}</span>}</div>)}</div>}
        </div>
        <div>
          <h3 style={{ margin: '0 0 8px' }}>History</h3>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8 }}>
            {selectedCompany.history.map((event, index) => <li key={`${event.at}-${index}`}><b>{event.event}</b><span style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>{event.detail} · {new Date(event.at).toLocaleString()}</span></li>)}
          </ol>
        </div>
      </div>
    </section></div>}

    {openReplacement && selectedCompany && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpenReplacement(false)}><section className="modal" style={{ width: 'min(540px, calc(100vw - 24px))' }}>
      <div className="modal-header"><div><div className="eyebrow">Replacement receipt</div><h2>Record goods received</h2></div><button className="icon-button" onClick={() => setOpenReplacement(false)}><X /></button></div>
      <form onSubmit={(event) => void handleReplacementSubmit(event)} style={{ display: 'grid', gap: 12, padding: 18 }}>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Supplier / company name<input value={selectedCompany.supplierName} readOnly style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Original return reference<input value={selectedCompany.reference} readOnly style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Replacement product<input value={selectedCompany.productName} readOnly style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Quantity received<input type="number" name="quantityReceived" min="1" max={selectedCompany.outstandingQuantity} required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Date received<input type="date" name="receivedAt" required style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Product condition<select name="condition" defaultValue="New" style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }}><option>New</option><option>Used</option><option>Damaged</option></select></label>
        </div>
        <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 11 }}>Notes<textarea name="notes" rows={3} style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--fg)' }} /></label>
        {error && <p className="field-error" style={{ margin: 0, color: '#b91c1c' }}>{error}</p>}
        <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="secondary-button" onClick={() => setOpenReplacement(false)}>Cancel</button>
          <button className="primary-button" type="submit"><ArrowUpRight size={16} /> Record receipt</button>
        </div>
      </form>
    </section></div>}
  </div>
}
