'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Cloud, HardDrive, RefreshCw, Search, ShieldCheck, Wifi, WifiOff } from 'lucide-react'
import { isMicomercSyncTarget, listQueuedOperations, markLocalRecordSynchronized, updateQueuedOperation, writeLocalRecord, type QueuedOperation } from '@/lib/offline-queue'
import { money } from '../utils'

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString()
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return ''
}

function operationSources(payload: RecordValue): RecordValue[] {
  return [
    payload.localSale,
    payload.localOrder,
    payload.sale,
    payload.order,
    payload.record,
    payload,
  ].map(asRecord).filter((value): value is RecordValue => value !== null)
}

function formattedValue(key: string, value: unknown, currency: string): string {
  const raw = textValue(value)
  if (!raw) return ''

  const numeric = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(numeric) && ['amount', 'price', 'unitPrice', 'cashTendered'].includes(key)) {
    return money(numeric, currency)
  }
  if (Number.isFinite(numeric) && ['totalMinor', 'subtotalMinor', 'discountMinor', 'taxMinor', 'amountMinor', 'unitPriceMinor', 'lineTotalMinor', 'amountTenderedMinor', 'changeMinor'].includes(key)) {
    return money(numeric / 100, currency)
  }

  if (typeof value === 'string' && /(At|Date|^date$)/i.test(key)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toLocaleString()
  }

  return raw
}

const operationFieldGroups: Array<{ label: string; keys: string[] }> = [
  { label: 'Customer', keys: ['customerName', 'customer'] },
  { label: 'Phone', keys: ['customerPhone'] },
  { label: 'Supplier', keys: ['supplierName', 'supplier'] },
  { label: 'Invoice', keys: ['invoice'] },
  { label: 'Receipt', keys: ['receiptNumber'] },
  { label: 'Reference', keys: ['reference'] },
  { label: 'Product', keys: ['productName', 'name'] },
  { label: 'Model', keys: ['model'] },
  { label: 'SKU', keys: ['sku'] },
  { label: 'Category', keys: ['category'] },
  { label: 'Quantity', keys: ['quantity', 'quantityReturned'] },
  { label: 'Stock', keys: ['stock'] },
  { label: 'Unit price', keys: ['unitPrice', 'price'] },
  { label: 'Amount', keys: ['amount', 'totalMinor'] },
  { label: 'Total units', keys: ['totalUnits', 'stockUnits'] },
  { label: 'Cartons', keys: ['cartons'] },
  { label: 'Units per carton', keys: ['unitsPerCarton'] },
  { label: 'Individual units', keys: ['individualUnits'] },
  { label: 'Date received', keys: ['receivedAt'] },
  { label: 'Transfer date', keys: ['transferDate'] },
  { label: 'Return date', keys: ['returnDate'] },
  { label: 'Created', keys: ['createdAt', 'date'] },
  { label: 'Due', keys: ['due'] },
  { label: 'Destination', keys: ['destinationNameAtTransfer', 'destination'] },
  { label: 'Source', keys: ['sourceLocation'] },
  { label: 'Reason', keys: ['reason'] },
  { label: 'Action', keys: ['action'] },
  { label: 'Status', keys: ['status'] },
  { label: 'Payment method', keys: ['method'] },
  { label: 'Items', keys: ['item', 'manualItems'] },
  { label: 'Notes', keys: ['notes'] },
]

function operationTypeLabel(type: string): string {
  return type.split(/[.-]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}

function OperationReviewCard({ operation, currency }: { operation: QueuedOperation; currency: string }) {
  const sources = operationSources(operation.payload)
  const details = operationFieldGroups.flatMap(({ label, keys }) => {
    for (const source of sources) {
      for (const key of keys) {
        const value = formattedValue(key, source[key], currency)
        if (value) return [{ label, value }]
      }
    }
    return []
  })
  const lineSource = sources.find((source) => Array.isArray(source.items) && source.items.length)
    ?? sources.find((source) => Array.isArray(source.lines) && source.lines.length)
  const lineKey = lineSource && Array.isArray(lineSource.items) && lineSource.items.length ? 'items' : 'lines'
  const lines = lineSource ? lineSource[lineKey] as unknown[] : []
  const payments = sources.flatMap((source) => [
    ...(Array.isArray(source.payments) ? source.payments : []),
    ...(asRecord(source.payment) ? [source.payment] : []),
  ]).map(asRecord).filter((payment): payment is RecordValue => payment !== null)
  const statusClass = operation.status === 'synchronized'
    ? 'success'
    : operation.status === 'failed' || operation.status === 'conflicted'
      ? 'warning'
      : operation.status === 'syncing'
        ? 'syncing'
        : 'pending'
  const createdAt = new Date(operation.createdAt)

  return <article className="sync-review-operation">
    <header className="sync-review-operation-header">
      <div className="sync-review-operation-heading">
        <h3>{operation.label}</h3>
        <span className="sync-operation-id">{operation.id}</span>
      </div>
      <span className={`sync-review-status ${statusClass}`}>{operation.status}</span>
    </header>
    <div className="sync-review-meta">
      <span>{operationTypeLabel(operation.type)}</span>
      <time dateTime={operation.createdAt}>{Number.isNaN(createdAt.getTime()) ? operation.createdAt : createdAt.toLocaleString()}</time>
    </div>
    {details.length > 0 && <dl className="sync-review-fields">{details.map((detail, index) => <div key={`${detail.label}-${index}`}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl>}
    {lines.length > 0 && <section className="sync-review-section" aria-label="Products and quantities">
      <h4>Items</h4>
      <div className="sync-review-lines">{lines.map((value, index) => {
        const line = asRecord(value)
        if (!line) return null
        const name = textValue(line.name) || textValue(line.productName) || textValue(line.description) || textValue(line.manualSourceText) || (line.productId !== undefined ? `Product #${textValue(line.productId)}` : `Item ${index + 1}`)
        const quantity = textValue(line.stockUnits) || textValue(line.quantity) || textValue(line.totalUnits)
        const unit = textValue(line.unit)
        const sku = textValue(line.sku)
        const condition = textValue(line.condition)
        const amountKey = line.lineTotalMinor !== undefined ? 'lineTotalMinor' : line.price !== undefined ? 'price' : line.amount !== undefined ? 'amount' : ''
        const amount = amountKey ? formattedValue(amountKey, line[amountKey], currency) : ''
        const unitPrice = line.unitPriceMinor !== undefined
          ? formattedValue('lineTotalMinor', line.unitPriceMinor, currency)
          : formattedValue('unitPrice', line.unitPrice, currency)
        return <article className="sync-review-line" key={`${name}-${index}`}>
          <div><b>{name}</b><small>{[quantity ? `Qty ${quantity}${unit ? ` ${unit}` : ''}` : '', sku ? `SKU ${sku}` : '', condition].filter(Boolean).join(' · ') || 'Item details'}</small></div>
          <div className="sync-review-line-prices">{unitPrice && <small>Unit {unitPrice}</small>}{amount && <strong>{amount}</strong>}</div>
        </article>
      })}</div>
    </section>}
    {payments.length > 0 && <section className="sync-review-section" aria-label="Payment details">
      <h4>Payments</h4>
      <div className="sync-review-payments">{payments.map((payment, index) => {
        const amountKey = payment.amountTenderedMinor !== undefined ? 'amountTenderedMinor' : payment.amountMinor !== undefined ? 'totalMinor' : payment.amount !== undefined ? 'amount' : ''
        const amount = amountKey ? formattedValue(amountKey, payment[amountKey], currency) : ''
        const method = textValue(payment.method)
        const date = textValue(payment.date) || textValue(payment.createdAt)
        const status = textValue(payment.status)
        const change = formattedValue('changeMinor', payment.changeMinor, currency)
        return <div className="sync-review-payment" key={`payment-${index}`}>
          <b>{payments.length > 1 ? `Payment ${index + 1}` : 'Payment'}</b>
          {amount && <span>Amount <strong>{amount}</strong></span>}
          {method && <span>Method <strong>{method}</strong></span>}
          {date && <span>Date <strong>{formattedValue('date', date, currency)}</strong></span>}
          {status && <span>Status <strong>{status}</strong></span>}
          {change && <span>Change <strong>{change}</strong></span>}
        </div>
      })}</div>
    </section>}
    {operation.error && <p className="sync-review-error"><AlertTriangle size={15} />{operation.error}</p>}
    {operation.dependsOn && <p className="sync-review-dependency">Waiting for operation(s): {(Array.isArray(operation.dependsOn) ? operation.dependsOn : [operation.dependsOn]).map((id) => id.slice(0, 8)).join(', ')}</p>}
    <details className="sync-review-technical">
      <summary>Technical details</summary>
      <pre>{JSON.stringify(operation.payload, null, 2)}</pre>
    </details>
  </article>
}

export function SyncCenter({ currency }: { currency: string }) {
  const [operations, setOperations] = useState<QueuedOperation[]>([])
  const [online, setOnline] = useState(true)
  const [search, setSearch] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState<Array<{ id: string; ok: boolean; message: string }>>([])
  const [storage, setStorage] = useState('Checking local storage…')

  const refresh = useCallback(async () => {
    try {
      const queued = await listQueuedOperations()
      const recovered = queued.map((operation) => operation.status === 'syncing' ? { ...operation, status: 'pending' as const, error: 'Previous synchronization was interrupted; safe to retry.' } : operation)
      for (let index = 0; index < recovered.length; index++) if (recovered[index] !== queued[index]) await updateQueuedOperation(recovered[index])
      setOperations(recovered); setStorage('Local storage available')
    } catch (error) { setStorage(error instanceof Error ? error.message : 'Local storage unavailable') }
  }, [])
  useEffect(() => {
    void refresh()
    const onlineHandler = () => setOnline(true)
    const offlineHandler = () => setOnline(false)
    const changed = () => { void refresh() }
    setOnline(navigator.onLine)
    window.addEventListener('online', onlineHandler); window.addEventListener('offline', offlineHandler); window.addEventListener('micomerc-queue-changed', changed)
    return () => { window.removeEventListener('online', onlineHandler); window.removeEventListener('offline', offlineHandler); window.removeEventListener('micomerc-queue-changed', changed) }
  }, [refresh])

  const pending = operations.filter((operation) => operation.status === 'pending' || operation.status === 'failed')
  const visible = useMemo(() => operations
    .filter((operation) => `${operation.label} ${operation.type} ${operation.status} ${operation.id}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)), [operations, search])
  const lastSync = operations.filter((operation) => operation.status === 'synchronized' && operation.completedAt).map((operation) => operation.completedAt!).sort().at(-1)

  const synchronize = async () => {
    if (!pending.length || running || !online) return
    setConfirm(false); setRunning(true); setResults([])
    const outcomes: typeof results = []
    const inventoryOperations: QueuedOperation[] = []
    const done = new Set(operations.filter((item) => item.status === 'synchronized').map((item) => item.id))
    for (let index = 0; index < pending.length; index++) {
      const operation = pending[index]
      if (!isMicomercSyncTarget(operation.target, operation.method)) {
        const error = 'Blocked: this operation does not target a Micomerc API endpoint. It was preserved for review.'
        await updateQueuedOperation({ ...operation, status: 'failed', error })
        outcomes.push({ id: operation.id, ok: false, message: error })
        setResults([...outcomes])
        continue
      }
      const dependencies = operation.dependsOn ? Array.isArray(operation.dependsOn) ? operation.dependsOn : [operation.dependsOn] : []
      if (dependencies.some((dependency) => !done.has(dependency))) {
        const dependencyError = 'Waiting for a required earlier operation. Resolve or retry that operation first.'
        outcomes.push({ id: operation.id, ok: false, message: dependencyError })
        continue
      }
      setProgress(`Synchronizing ${index + 1} of ${pending.length}: ${operation.label}`)
      try {
        await updateQueuedOperation({ ...operation, status: 'syncing', error: undefined })
        setOperations((current) => current.map((item) => item.id === operation.id ? { ...item, status: 'syncing', error: undefined } : item))
        const response = await fetch(operation.target, { method: operation.method, headers: { 'Content-Type': 'application/json' }, ...(operation.method === 'DELETE' || Object.keys(operation.payload).length ? { body: JSON.stringify(operation.payload) } : {}) })
        const result = await response.json().catch(() => null)
        if (!response.ok) {
          const conflict = response.status === 409
          const failed = { ...operation, status: conflict ? 'conflicted' as const : 'failed' as const, error: typeof result?.message === 'string' ? result.message : `Server returned ${response.status}` }
          await updateQueuedOperation(failed); outcomes.push({ id: operation.id, ok: false, message: failed.error! }); continue
        }
        const complete = { ...operation, status: 'synchronized' as const, completedAt: new Date().toISOString(), error: undefined }
        if (operation.type === 'pending-order.create' && operation.recordId !== undefined) {
          const hasPendingAction = pending.some((candidate) => candidate.recordId === operation.recordId && candidate.type.startsWith('pending-order.') && candidate.type !== 'pending-order.create' && candidate.id !== operation.id && !done.has(candidate.id))
          if (!hasPendingAction) await markLocalRecordSynchronized('pendingOrders', operation.recordId, result?.order ?? result)
        } else if (operation.type === 'pending-order.accept' || operation.type === 'pending-order.reject') {
          if (operation.recordId !== undefined && result?.order) await markLocalRecordSynchronized('pendingOrders', operation.recordId, { ...result.order, ...(result.sale ? { sale: result.sale } : {}) })
          if (result?.sale && typeof result.sale.id === 'string') await writeLocalRecord('sales', result.sale.id, result.sale, false)
        } else if (operation.recordCollection && operation.recordId !== undefined) await markLocalRecordSynchronized(operation.recordCollection, operation.recordId, result)
        if (operation.type === 'sale.create' && result && typeof result === 'object' && 'inventory' in result && Array.isArray(result.inventory)) {
          const unresolvedSales = operations.filter((candidate) => candidate.id !== operation.id && !done.has(candidate.id) && candidate.type === 'sale.create' && candidate.status !== 'synchronized')
          for (const serverProduct of result.inventory) {
            if (!serverProduct || typeof serverProduct !== 'object' || !('id' in serverProduct) || !('stock' in serverProduct) || typeof serverProduct.id !== 'number' || typeof serverProduct.stock !== 'number') continue
            let reserved = 0
            let threshold = Number(operation.payload.lowStockThreshold)
            if (!Number.isFinite(threshold) || threshold < 0) threshold = 0
            for (const queuedSale of unresolvedSales) {
              const items = queuedSale.payload.items
              if (!Array.isArray(items)) continue
              for (const item of items) if (item && typeof item === 'object' && 'productId' in item && item.productId === serverProduct.id && 'quantity' in item && typeof item.quantity === 'number') reserved += item.quantity
            }
            const stock = Math.max(0, Math.round((serverProduct.stock - reserved) * 1000) / 1000)
            const value = { ...serverProduct, stock, status: stock <= 0 ? 'Out of stock' : stock <= threshold ? 'Low stock' : 'In stock' }
            await writeLocalRecord('products', serverProduct.id, value, reserved > 0)
          }
        }
        await updateQueuedOperation(complete); done.add(operation.id); outcomes.push({ id: operation.id, ok: true, message: 'Synchronized' })
        if (/^(store\.receipt\.|transfer\.|sale\.|debt\.create|stock\.|pending-order\.)/.test(operation.type)) inventoryOperations.push(operation)
        if (operation.type === 'debt.create' && operation.recordId !== undefined && result && typeof result.id === 'number') {
          for (const dependent of pending) {
            if (dependent.dependsOn !== operation.id) continue
            dependent.target = dependent.target.replace(encodeURIComponent(String(operation.recordId)), encodeURIComponent(String(result.id)))
            dependent.recordId = result.id
            dependent.payload = { ...dependent.payload, id: result.id }
            await updateQueuedOperation(dependent)
          }
        }
      } catch (error) {
        const failed = { ...operation, status: 'failed' as const, error: error instanceof Error ? error.message : 'Network request failed' }
        await updateQueuedOperation(failed); outcomes.push({ id: operation.id, ok: false, message: failed.error! })
      }
      setResults([...outcomes])
    }
    if (inventoryOperations.length) {
      try {
        const response = await fetch('/api/products', { cache: 'no-store' })
        if (response.ok) {
          const serverProducts: unknown = await response.json()
          if (Array.isArray(serverProducts)) {
            const latestQueue = await listQueuedOperations()
            const affected = new Set<number>()
            const unresolved = new Set<number>()
            const collectIds = (operation: QueuedOperation, into: Set<number>) => {
              if (operation.type.startsWith('product.') && typeof operation.recordId === 'number') into.add(operation.recordId)
              for (const field of ['items', 'lines']) {
                const rows = operation.payload[field]
                if (!Array.isArray(rows)) continue
                for (const row of rows) if (row && typeof row === 'object' && 'productId' in row && typeof row.productId === 'number') into.add(row.productId)
              }
              if (typeof operation.payload.productId === 'number') into.add(operation.payload.productId)
            }
            for (const operation of inventoryOperations) collectIds(operation, affected)
            for (const operation of latestQueue) if (operation.status !== 'synchronized') collectIds(operation, unresolved)
            for (const product of serverProducts) {
              if (!product || typeof product !== 'object' || !('id' in product) || typeof product.id !== 'number' || !affected.has(product.id) || unresolved.has(product.id)) continue
              await writeLocalRecord('products', product.id, product, false)
            }
          }
        }
      } catch (error) { console.warn('Server confirmed operations but inventory cache refresh failed:', error) }
    }
    setProgress(''); setRunning(false); setResults(outcomes); await refresh(); window.dispatchEvent(new Event('micomerc-queue-changed'))
  }

  const retryAfterReview = async (operation: QueuedOperation) => {
    const approved = window.confirm(`Review ${operation.label} before retrying? The same operation ID and payload will be retried. The server will still reject stale revisions and stock conflicts; this will not overwrite newer server data.`)
    if (!approved) return
    const retry = { ...operation, status: 'pending' as const, error: undefined }
    await updateQueuedOperation(retry)
    setOperations((current) => current.map((item) => item.id === retry.id ? retry : item))
  }

  return <div className="sync-page">
    <div className="sync-status-grid">
      <article className="sync-status-card"><div className="sync-status-icon">{online ? <Wifi /> : <WifiOff />}</div><span>Connection</span><b>{online ? 'Online' : 'Offline'}</b><small>Connectivity only; it never starts synchronization.</small></article>
      <article className="sync-status-card"><div className="sync-status-icon"><HardDrive /></div><span>Local storage</span><b>{storage}</b><small>Operations persist on this device in Local Storage.</small></article>
      <article className="sync-status-card"><div className="sync-status-icon"><Cloud /></div><span>Last successful sync</span><b>{lastSync ? new Date(lastSync).toLocaleString() : 'No successful sync yet'}</b><small>Pending records are not represented as synchronized.</small></article>
    </div>
    <div className="stat-grid sync-counts">{[['Pending', operations.filter((item) => item.status === 'pending').length], ['Successful', operations.filter((item) => item.status === 'synchronized').length], ['Failed', operations.filter((item) => item.status === 'failed').length], ['Conflicted', operations.filter((item) => item.status === 'conflicted').length]].map(([label, value]) => <div className="stat-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <section className="panel sync-panel">
      <div className="sync-toolbar">
        <div><h2>Operation queue</h2><p>Review queued changes before authorizing a sync.</p></div>
        <label className="returns-search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search operations" /></label>
        <button className="primary-button" disabled={!online || !pending.length || running} onClick={() => setConfirm(true)}><RefreshCw /> Review and synchronize</button>
      </div>
      {progress && <p className="sync-progress" role="status">{progress}</p>}
      <div className={`table-wrap record-list-scroll record-scroll-30 sync-operations-scroll${visible.length > 30 ? ' is-scrollable' : ''}`}>
        <table>
          <thead><tr><th>Operation</th><th>Type</th><th>Created</th><th>Status</th><th>Details</th></tr></thead>
          <tbody>{visible.map((operation) => <tr key={operation.id}>
            <td><b>{operation.label}</b><small className="sync-operation-id">{operation.id}</small></td>
            <td>{operationTypeLabel(operation.type)}</td>
            <td>{Number.isNaN(Date.parse(operation.createdAt)) ? operation.createdAt : new Date(operation.createdAt).toLocaleString()}</td>
            <td><span className={`status-pill ${operation.status === 'synchronized' ? 'success' : operation.status === 'conflicted' || operation.status === 'failed' ? 'warning' : ''}`}>{operation.status}</span>{(operation.status === 'failed' || operation.status === 'conflicted') && <button className="secondary-button" type="button" onClick={() => void retryAfterReview(operation)}>Review &amp; retry</button>}</td>
            <td>{operation.error ?? (operation.dependsOn ? `Depends on ${(Array.isArray(operation.dependsOn) ? operation.dependsOn : [operation.dependsOn]).map((id) => id.slice(0, 8)).join(', ')}` : 'No additional notes')}</td>
          </tr>)}</tbody>
        </table>
        {visible.length === 0 && <div className="empty"><ShieldCheck /><b>Queue is clear</b><span>New local operations will appear here.</span></div>}
      </div>
      {results.length > 0 && <div className="sync-results"><h3>Synchronization results</h3>{results.map((result) => <p key={result.id}>{result.ok ? <CheckCircle2 /> : <AlertTriangle />} {result.message}</p>)}</div>}
    </section>
    {confirm && <div className="modal-backdrop">
      <section className="modal sync-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="sync-review-title">
        <header className="modal-header"><div><div className="eyebrow">Manual synchronization</div><h2 id="sync-review-title">Review before upload</h2></div></header>
        <p>This will send {pending.length} queued operation(s) to the server in order. Each result will be saved locally. Connectivity alone never starts this process.</p>
        <div className="sync-review-list">{pending.map((item) => <OperationReviewCard key={item.id} operation={item} currency={currency} />)}</div>
        <div className="modal-actions"><button className="secondary-button" onClick={() => setConfirm(false)}>Cancel</button><button className="primary-button" onClick={() => void synchronize()} disabled={!online || running}><ShieldCheck /> Accept &amp; synchronize</button></div>
      </section>
    </div>}
  </div>
}
