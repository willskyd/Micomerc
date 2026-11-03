'use client'

import { useMemo, useRef, useState } from 'react'
import { Check, Clock3, Package, Printer, Search, ShieldAlert, X } from 'lucide-react'
import { listQueuedOperations, savePendingOrderAndOperation, shouldAttemptServerRequest, writeLocalRecord } from '@/lib/offline-queue'
import type { PendingOrder, Product, Sale } from '../types'
import { money } from '../utils'

type Filter = 'All' | 'Pending' | 'Accepted' | 'Rejected'

export function PendingOrdersSection({ orders, setOrders, setProducts, currency, workspace, onPrint, onActivity }: {
  orders: PendingOrder[]
  setOrders: React.Dispatch<React.SetStateAction<PendingOrder[]>>
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>
  currency: string
  workspace: string
  onPrint: (sale: Sale) => Promise<void>
  onActivity: (text: string, detail: string) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('All')
  const [selected, setSelected] = useState<PendingOrder | null>(null)
  const [confirm, setConfirm] = useState<'accept' | 'reject' | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const pending = orders.filter((order) => order.status === 'Pending')
  const visible = useMemo(() => orders.filter((order) => (filter === 'All' || order.status === filter) && `${order.reference} ${order.customerName} ${order.customerPhone}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [orders, filter, query])
  const accepted = orders.filter((order) => order.status === 'Accepted')
  const pendingValue = pending.reduce((sum, order) => sum + order.totalMinor, 0)

  const confirmAction = async () => {
    if (!selected || !confirm || lock.current) return
    lock.current = true
    setSaving(true); setError(''); setNotice('')
    const action = confirm
    const operationId = crypto.randomUUID()
    const saleId = action === 'accept' ? crypto.randomUUID() : undefined
    const operationHistory = { at: new Date().toISOString(), actor: 'You (this device)', event: action === 'accept' ? 'Order accepted and payment confirmed' : 'Order rejected', ...(action === 'reject' && reason.trim() ? { detail: reason.trim() } : {}) }
    const sale: Sale | undefined = action === 'accept' ? {
      id: saleId!,
      receiptNumber: `LOCAL-${saleId!.slice(0, 8).toUpperCase()}`,
      businessName: workspace,
      currency,
      createdAt: new Date().toISOString(),
      items: selected.items.map((line) => ({ productId: line.productId, name: line.name, sku: line.sku, barcode: line.barcode ?? '', quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, lineTotalMinor: line.lineTotalMinor })),
      subtotalMinor: selected.totalMinor, discountMinor: 0, taxMinor: 0, totalMinor: selected.totalMinor,
      payment: { method: 'cash', status: 'paid', amountTenderedMinor: selected.totalMinor, changeMinor: 0 },
      customerName: selected.customerName, customerPhone: selected.customerPhone,
      pendingOrderId: selected.id, pendingOrderReference: selected.reference,
      localPending: true,
    } : undefined
    const payload = { orderId: selected.id, action, operationId, ...(saleId ? { saleId } : {}), reason: action === 'reject' ? reason.trim() : '', items: selected.items.map((line) => ({ productId: line.productId, quantity: line.quantity })) }
    const saveLocally = async () => {
      const queue = await listQueuedOperations()
      const productIds = new Set(selected.items.map((line) => line.productId))
      const dependencies = queue.filter((item) => {
        if (item.status === 'synchronized') return false
        const affected = new Set<number>()
        if (item.type.startsWith('product.') && typeof item.recordId === 'number') affected.add(item.recordId)
        if (typeof item.payload.productId === 'number') affected.add(item.payload.productId)
        for (const key of ['items', 'lines']) {
          const rows = item.payload[key]
          if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === 'object' && 'productId' in row && typeof row.productId === 'number') affected.add(row.productId)
        }
        return (item.recordId === selected.id && item.type.startsWith('pending-order.')) || ([...productIds].some((id) => affected.has(id)) && /^(product\.|store\.receipt\.|transfer\.|pending-order\.|sale\.)/.test(item.type))
      }).map((item) => item.id)
      const updated: PendingOrder = { ...selected, status: action === 'accept' ? 'Accepted' : 'Rejected', ...(sale ? { sale } : {}), ...(action === 'reject' && reason.trim() ? { rejectionReason: reason.trim() } : {}), history: [...selected.history, operationHistory], localPending: true }
      const stockUpdates = await savePendingOrderAndOperation(updated, { id: operationId, type: `pending-order.${action}`, label: `${action === 'accept' ? 'Accept' : 'Reject'} ${selected.reference}`, target: '/api/pending-orders', method: 'PATCH', payload, ...(dependencies.length ? { dependsOn: dependencies } : {}), recordCollection: 'pendingOrders', recordId: selected.id }, action, 0, sale)
      if (stockUpdates.length) setProducts((current) => current.map((product) => stockUpdates.find((item) => item.id === product.id) as Product ?? product))
      return updated
    }
    try {
      const queue = await listQueuedOperations()
      const productIds = new Set(selected.items.map((line) => line.productId))
      const earlierOrderOperations = queue.filter((item) => {
        if (item.status === 'synchronized') return false
        const affected = new Set<number>()
        if (item.type.startsWith('product.') && typeof item.recordId === 'number') affected.add(item.recordId)
        if (typeof item.payload.productId === 'number') affected.add(item.payload.productId)
        for (const key of ['items', 'lines']) {
          const rows = item.payload[key]
          if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === 'object' && 'productId' in row && typeof row.productId === 'number') affected.add(row.productId)
        }
        return (item.recordId === selected.id && item.type.startsWith('pending-order.')) || ([...productIds].some((id) => affected.has(id)) && /^(product\.|store\.receipt\.|transfer\.|pending-order\.|sale\.)/.test(item.type))
      })
      let updated: PendingOrder
      if (!selected.localPending && earlierOrderOperations.length === 0 && shouldAttemptServerRequest()) {
        let response: Response | null = null
        try { response = await fetch('/api/pending-orders', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
        catch (error) { if (!(error instanceof TypeError)) throw error }
        const result = response ? await response.json().catch(() => null) : null
        if (response?.ok && result?.order) {
          updated = result.order as PendingOrder
          if (Array.isArray(result.inventory)) {
            setProducts((current) => current.map((product) => result.inventory.find((item: Product) => item.id === product.id) ?? product))
          }
          try {
            await writeLocalRecord('pendingOrders', updated.id, updated, false)
            if (result.sale) await writeLocalRecord('sales', (result.sale as Sale).id, result.sale, false)
            if (Array.isArray(result.inventory)) for (const product of result.inventory) if (product && typeof product.id === 'number') await writeLocalRecord('products', product.id, product, false)
          } catch (cacheError) { console.warn('Order action was confirmed by the server, but its local cache could not be refreshed:', cacheError) }
        } else if (response) {
          throw new Error(typeof result?.message === 'string' ? result.message : `Order action failed (${response.status})`)
        } else updated = await saveLocally()
      } else updated = await saveLocally()
      setOrders((current) => current.map((order) => order.id === updated.id ? updated : order))
      setSelected(updated); setConfirm(null); setReason('')
      const savedLocally = updated.localPending === true
      setNotice(savedLocally ? `Order ${updated.reference} saved on this device · waiting for Sync Now.` : `Order ${updated.reference} ${action === 'accept' ? 'accepted and payment confirmed' : 'rejected'} by the server.`)
      onActivity(savedLocally ? `Pending order ${action} saved locally` : `Pending order ${action} confirmed`, `${updated.reference} · ${updated.customerName} · ${money(updated.totalMinor / 100, currency)}`)
      window.dispatchEvent(new Event('micomerc-queue-changed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Order action could not be saved')
    } finally { lock.current = false; setSaving(false) }
  }

  return <div className="pending-orders-page">
    {notice && <p className="offline-note" role="status">{notice}</p>}
    <div className="stat-grid pending-order-stats">
      <article className="stat-card"><span>Total pending orders</span><strong>{pending.length}</strong></article>
      <article className="stat-card"><span>Pending value</span><strong>{money(pendingValue / 100, currency)}</strong></article>
      <article className="stat-card"><span>Accepted orders</span><strong>{accepted.length}</strong></article>
      <article className="stat-card"><span>Rejected orders</span><strong>{orders.filter((order) => order.status === 'Rejected').length}</strong></article>
    </div>
    <section className="panel pending-orders-panel">
      <div className="pending-orders-toolbar"><label className="returns-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search reference or customer" /></label><div className="pending-order-filters">{(['All', 'Pending', 'Accepted', 'Rejected'] as Filter[]).map((value) => <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value}</button>)}</div></div>
      {visible.length ? <div className="pending-order-grid">{visible.map((order) => <button type="button" key={order.id} className="pending-order-card" onClick={() => { setSelected(order); setError(''); setConfirm(null) }}><div className="pending-order-card-top"><span className={`pending-order-badge ${order.status.toLowerCase()}`}>{order.status}{order.localPending ? ' · Local' : ''}</span><small>{new Date(order.createdAt).toLocaleString()}</small></div><strong>{order.reference}</strong><span>{order.customerName || 'Walk-in customer'}{order.customerPhone ? ` · ${order.customerPhone}` : ''}</span><div className="pending-order-card-bottom"><span><Package /> {order.items.length} item{order.items.length === 1 ? '' : 's'}</span><b>{money(order.totalMinor / 100, currency)}</b></div></button>)}</div> : <div className="empty"><Clock3 /><b>{query || filter !== 'All' ? 'No matching orders' : 'No pending orders yet'}</b><span>Use Supply from the Cart to save an order for review.</span></div>}
    </section>
    {selected && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}><section className="modal pending-order-modal"><div className="modal-header"><div><div className="eyebrow">{selected.reference}</div><h2>Pending order details</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close order details"><X /></button></div><div className="pending-order-detail"><div className="pending-order-detail-summary"><div><small>Customer</small><b>{selected.customerName || 'Walk-in customer'}</b><span>{selected.customerPhone || 'No phone provided'}</span></div><div><small>Status</small><b className={`pending-order-badge ${selected.status.toLowerCase()}`}>{selected.status}{selected.localPending ? ' · Local' : ''}</b></div><div><small>Submitted</small><b>{new Date(selected.createdAt).toLocaleString()}</b></div></div><div className="table-wrap"><table><thead><tr><th>Product</th><th>Quantity</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>{selected.items.map((line) => <tr key={line.productId}><td>{line.name}<small>{line.sku}</small></td><td>{line.quantity}</td><td>{money(line.unitPriceMinor / 100, currency)}</td><td>{money(line.lineTotalMinor / 100, currency)}</td></tr>)}</tbody></table></div><div className="pending-order-total"><span>Total</span><b>{money(selected.totalMinor / 100, currency)}</b></div><h3>Order activity</h3><ol className="pending-order-history">{selected.history.map((item, index) => <li key={`${item.at}-${index}`}><b>{item.event}</b><span>{item.actor} · {new Date(item.at).toLocaleString()}{item.detail ? ` · ${item.detail}` : ''}</span></li>)}</ol>{selected.rejectionReason && <p className="offline-note">Rejection reason: {selected.rejectionReason}</p>}{error && <p className="field-error" role="alert">{error}</p>}{confirm && <div className="pending-order-confirm"><ShieldAlert /><p>{confirm === 'accept' ? <>Accept <b>{selected.reference}</b> for <b>{selected.customerName || 'Walk-in customer'}</b> totaling <b>{money(selected.totalMinor / 100, currency)}</b>? This confirms payment and creates one paid sale and receipt.</> : <>Reject <b>{selected.reference}</b> for <b>{selected.customerName || 'Walk-in customer'}</b>?</>}</p>{confirm === 'reject' && <label>Optional rejection reason<textarea maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}<div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setConfirm(null)} disabled={saving}>Cancel</button><button className="primary-button" type="button" onClick={() => void confirmAction()} disabled={saving}>{saving ? 'Saving…' : confirm === 'accept' ? 'Confirm acceptance' : 'Confirm rejection'}</button></div></div>}{selected.status === 'Pending' && !confirm && <div className="pending-order-actions"><button className="secondary-button" onClick={() => { setConfirm('reject'); setError('') }}><X /> Reject order</button><button className="primary-button" onClick={() => { setConfirm('accept'); setError('') }}><Check /> Accept order</button></div>}{selected.status === 'Accepted' && selected.sale && <button className="primary-button" onClick={() => void onPrint(selected.sale!)}><Printer /> Print receipt</button>}</div></section></div>}
  </div>
}
