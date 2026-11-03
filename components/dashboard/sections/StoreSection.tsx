'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Archive, CalendarDays, ChevronDown, ClipboardList, Eye, History, MoreVertical, PackageCheck, Pencil, Plus, Search, Truck, X } from 'lucide-react'
import type { Product, StoreReceivingRecord } from '../types'
import { SearchableProductSelect } from '../SearchableProductSelect'
import { createUniquePrototypeReference } from '@/lib/store-transfers-prototype'

type StoreSectionProps = {
  products: Product[]
  productsLoading: boolean
  productsError: string
  persistenceError: string
  records: StoreReceivingRecord[]
  onCreate: (record: StoreReceivingRecord) => Promise<StoreReceivingRecord>
  onUpdate: (id: string, record: StoreReceivingRecord, expectedRevision: number) => Promise<StoreReceivingRecord>
}

const MAX_CARTONS = 100_000
const MAX_UNITS_PER_CARTON = 100_000

function localDateTimeValue(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function localInputToIso(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function inputValue(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? localDateTimeValue() : localDateTimeValue(date)
}

type ReceiptDraft = { productId: string; receivedAt: string; individualUnits: string; cartons: string; unitsPerCarton: string; supplier: string; deliveryReference: string; notes: string }

function draftFromRecord(record: StoreReceivingRecord): ReceiptDraft {
  return { productId: String(record.productId), receivedAt: inputValue(record.receivedAt), individualUnits: String(record.individualUnits ?? 0), cartons: String(record.cartons), unitsPerCarton: record.unitsPerCarton === null ? '' : String(record.unitsPerCarton), supplier: record.supplier, deliveryReference: record.deliveryReference, notes: record.notes }
}

function emptyDraft(): ReceiptDraft {
  return { productId: '', receivedAt: localDateTimeValue(), individualUnits: '0', cartons: '0', unitsPerCarton: '', supplier: '', deliveryReference: '', notes: '' }
}

function calculateTotal(draft: ReceiptDraft) {
  const units = draft.individualUnits === '' ? NaN : Number(draft.individualUnits)
  const cartons = draft.cartons === '' ? NaN : Number(draft.cartons)
  const perCarton = draft.unitsPerCarton === '' ? 0 : Number(draft.unitsPerCarton)
  if (!Number.isSafeInteger(units) || units < 0 || !Number.isSafeInteger(cartons) || cartons < 0 || (cartons > 0 && (!Number.isSafeInteger(perCarton) || perCarton < 1))) return null
  const total = units + cartons * perCarton
  return Number.isSafeInteger(total) && total > 0 && total <= 1_000_000_000 ? total : null
}

export function StoreSection({ products, productsLoading, productsError, persistenceError, records, onCreate, onUpdate }: StoreSectionProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<ReceiptDraft>(emptyDraft)
  const [search, setSearch] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [menuRecordId, setMenuRecordId] = useState('')
  const [expandedRecordId, setExpandedRecordId] = useState('')
  const [editingRecord, setEditingRecord] = useState<StoreReceivingRecord | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [saving, setSaving] = useState(false)
  const submitLock = useRef(false)
  const editorLock = useRef(false)
  const createRequestKey = useRef('')
  const totalUnits = calculateTotal(draft)

  useEffect(() => {
    if (!menuRecordId) return
    const close = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.prototype-record-menu-wrap')) setMenuRecordId('')
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuRecordId('') }
    document.addEventListener('click', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', key) }
  }, [menuRecordId])

  const visibleRecords = useMemo(() => records
    .filter((record) => `${record.reference} ${record.productName} ${record.sku} ${record.supplier} ${record.deliveryReference}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.receivedAt.localeCompare(a.receivedAt)), [records, search])
  const displayedRecords = showHistory ? visibleRecords : visibleRecords.slice(0, 20)

  const knownUnits = records.reduce((total, record) => total + (record.stockUnits ?? record.totalUnits ?? 0), 0)
  const cartonsTotal = records.reduce((total, record) => total + record.cartons, 0)
  const latest = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.receivedAt.localeCompare(a.receivedAt))[0]

  const validate = (value: ReceiptDraft) => {
    const product = products.find((item) => String(item.id) === value.productId)
    if (!product) return 'Choose a product from the live product catalog.'
    if (!localInputToIso(value.receivedAt)) return 'Choose a valid receiving date and time.'
    if (value.individualUnits === '' || !Number.isSafeInteger(Number(value.individualUnits)) || Number(value.individualUnits) < 0) return 'Individual units must be a whole number of zero or more.'
    if (value.cartons === '' || !Number.isSafeInteger(Number(value.cartons)) || Number(value.cartons) < 0 || Number(value.cartons) > MAX_CARTONS) return `Cartons must be a whole number from 0 to ${MAX_CARTONS.toLocaleString()}.`
    if (value.unitsPerCarton !== '' && (!Number.isSafeInteger(Number(value.unitsPerCarton)) || Number(value.unitsPerCarton) < 1 || Number(value.unitsPerCarton) > MAX_UNITS_PER_CARTON)) return `Units per carton must be a whole number from 1 to ${MAX_UNITS_PER_CARTON.toLocaleString()}.`
    if (Number(value.cartons) > 0 && value.unitsPerCarton === '') return 'Enter units per carton when recording cartons.'
    if (calculateTotal(value) === null) return 'Enter a positive receipt quantity within the supported limit.'
    if (value.supplier.trim().length > 120 || value.deliveryReference.trim().length > 100 || value.notes.trim().length > 500) return 'Supplier, reference, or notes exceed the allowed length.'
    return ''
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitLock.current || saving) return
    setError(''); setSuccess('')
    const validation = validate(draft)
    if (validation) { setError(validation); return }
    const product = products.find((item) => String(item.id) === draft.productId)!
    submitLock.current = true
    setSaving(true)
    const id = createRequestKey.current || (createRequestKey.current = crypto.randomUUID())
    try {
      const saved = await onCreate({
        id,
        reference: '',
        productId: product.id,
        productName: product.name,
        sku: product.sku || product.model,
        barcode: product.barcode ?? '',
        supplier: draft.supplier.trim(),
        receivedAt: localInputToIso(draft.receivedAt),
        cartons: Number(draft.cartons),
        individualUnits: Number(draft.individualUnits),
        unitsPerCarton: draft.unitsPerCarton === '' ? null : Number(draft.unitsPerCarton),
        totalUnits,
        stockUnits: totalUnits ?? undefined,
        deliveryReference: draft.deliveryReference.trim(),
        notes: draft.notes.trim(),
        status: 'Recorded',
        createdAt: new Date().toISOString(),
      })
      createRequestKey.current = ''
      setSuccess(`${saved.reference} saved. ${saved.totalUnits?.toLocaleString()} units were added to live inventory.`)
      setDraft({ ...emptyDraft(), productId: String(product.id) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the Store receipt.')
    } finally { submitLock.current = false; setSaving(false) }
  }

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editingRecord || editorLock.current || saving) return
    const validation = validate(draft)
    if (validation) { setError(validation); return }
    if (String(editingRecord.productId) !== draft.productId) { setError('A saved receipt stays linked to its original product. Change only the received quantities and receipt details.'); return }
    editorLock.current = true
    setSaving(true); setError(''); setSuccess('')
    try {
      const updated = await onUpdate(editingRecord.id, {
        ...editingRecord,
        receivedAt: localInputToIso(draft.receivedAt),
        individualUnits: Number(draft.individualUnits),
        cartons: Number(draft.cartons),
        unitsPerCarton: draft.unitsPerCarton === '' ? null : Number(draft.unitsPerCarton),
        totalUnits,
        stockUnits: totalUnits ?? undefined,
        supplier: draft.supplier.trim(),
        deliveryReference: draft.deliveryReference.trim(),
        notes: draft.notes.trim(),
      }, editingRecord.revision ?? 1)
      setEditingRecord(null)
      setSuccess(`${updated.reference} updated. Inventory was adjusted by ${Number(updated.stockUnits ?? 0) - Number(editingRecord.stockUnits ?? editingRecord.totalUnits ?? 0)} units.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update the Store receipt.') }
    finally { editorLock.current = false; setSaving(false) }
  }

  const beginEdit = (record: StoreReceivingRecord) => {
    setEditingRecord(record); setDraft(draftFromRecord(record)); setError(''); setSuccess(''); setMenuRecordId('')
  }

  return <div className="prototype-module">
    {persistenceError && <p className="prototype-storage-warning" role="alert"><Archive size={15} />{persistenceError}</p>}
    <div className="prototype-actions"><div><span className="prototype-local-label"><Archive size={14} /> Live stock inventory</span><p>Each saved receipt posts its confirmed unit quantity to the selected product’s stock.</p></div>
      <button type="button" className="primary-button" onClick={() => { setFormOpen((open) => !open); setError(''); setSuccess('') }} aria-expanded={formOpen}><Plus />{formOpen ? 'Close form' : 'Receive stock'}</button>
    </div>
    <div className="prototype-stats"><SummaryCard icon={<ClipboardList />} label="Receiving records" value={records.length.toLocaleString()} detail="Saved in the database" /><SummaryCard icon={<Truck />} label="Cartons received" value={cartonsTotal.toLocaleString()} detail="Across saved deliveries" /><SummaryCard icon={<PackageCheck />} label="Units received" value={knownUnits.toLocaleString()} detail="Posted to product stock" /><SummaryCard icon={<CalendarDays />} label="Latest receiving" value={latest ? formatDate(latest.receivedAt) : '—'} detail={latest?.reference ?? 'No receiving activity yet'} /></div>

    {formOpen && <section className="prototype-panel" aria-labelledby="receive-stock-title"><div className="prototype-panel-heading"><div><span className="prototype-kicker">Incoming delivery</span><h2 id="receive-stock-title">Receive stock</h2><p>Stock is added once when the receipt is committed.</p></div></div>
      <form className="prototype-form" onSubmit={submit} noValidate>
        <label className="prototype-field prototype-field-wide">Product <span className="required-mark">*</span><SearchableProductSelect products={products} value={draft.productId} onChange={(productId) => setDraft((current) => ({ ...current, productId }))} disabled={productsLoading || !!productsError || saving} label="Search Store products" includeOutOfStock />{productsLoading && <small role="status">Loading products…</small>}{productsError && <small role="alert">{productsError}</small>}</label>
        <label className="prototype-field">Date received <span className="required-mark">*</span><input type="datetime-local" required value={draft.receivedAt} onChange={(event) => setDraft((current) => ({ ...current, receivedAt: event.target.value }))} /></label>
        <label className="prototype-field">Individual units <span className="required-mark">*</span><input type="number" min="0" max="1000000000" step="1" inputMode="numeric" value={draft.individualUnits} onChange={(event) => setDraft((current) => ({ ...current, individualUnits: event.target.value }))} /></label>
        <label className="prototype-field">Cartons <span className="required-mark">*</span><input type="number" min="0" max={MAX_CARTONS} step="1" value={draft.cartons} onChange={(event) => setDraft((current) => ({ ...current, cartons: event.target.value }))} /></label>
        <label className="prototype-field">Units per carton <span className="prototype-optional">required when cartons &gt; 0</span><input type="number" min="1" max={MAX_UNITS_PER_CARTON} step="1" value={draft.unitsPerCarton} onChange={(event) => setDraft((current) => ({ ...current, unitsPerCarton: event.target.value }))} placeholder="Enter carton size" /></label>
        <div className="prototype-calculation"><PackageCheck size={18} /><div><span>Total units to add to stock</span><strong>{totalUnits === null ? 'Check quantities' : totalUnits.toLocaleString()}</strong></div><small>{Number(draft.individualUnits || 0).toLocaleString()} individual + {Number(draft.cartons || 0).toLocaleString()} cartons × {draft.unitsPerCarton || '0'}</small></div>
        <label className="prototype-field">Supplier or source<input maxLength={120} value={draft.supplier} onChange={(event) => setDraft((current) => ({ ...current, supplier: event.target.value }))} placeholder="Supplier name" /></label><label className="prototype-field">Delivery reference<input maxLength={100} value={draft.deliveryReference} onChange={(event) => setDraft((current) => ({ ...current, deliveryReference: event.target.value }))} placeholder="Invoice or delivery note" /></label>
        <label className="prototype-field prototype-field-wide">Notes <span className="prototype-optional">optional</span><textarea maxLength={500} rows={3} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Condition, discrepancies, or handling notes" /></label>
        {error && !editingRecord && <p className="prototype-feedback error" role="alert">{error}</p>}{success && <p className="prototype-feedback success" role="status">{success}</p>}
        <div className="prototype-form-actions prototype-field-wide"><span className="prototype-status"><i /> Stock posting enabled</span><button type="submit" className="primary-button" disabled={saving || productsLoading || !!productsError || !products.length}>{saving ? 'Saving…' : 'Save receiving record'}</button></div>
      </form>
    </section>}

    <section className="prototype-panel"><div className="prototype-history-heading"><div><span className="prototype-kicker">Receiving log</span><h2>Receiving history</h2><p>{records.length} saved receipt{records.length === 1 ? '' : 's'} · edits adjust stock by the quantity difference</p></div><div className="prototype-history-controls"><label className="prototype-search"><Search size={16} /><input aria-label="Search receiving records" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search records" /></label>{visibleRecords.length > 20 && <button type="button" className="secondary-button prototype-history-toggle" onClick={() => setShowHistory((value) => !value)} aria-expanded={showHistory}>{showHistory ? 'Back to Recent' : 'View History'}</button>}</div></div>
      {visibleRecords.length === 0 ? <div className="prototype-empty"><PackageCheck size={25} /><b>{records.length ? 'No matching receipts' : 'No receiving records yet'}</b><span>{records.length ? 'Try another product, supplier, or reference.' : 'Use Receive Stock to post the first incoming delivery.'}</span></div> : <>
        <div className="prototype-table-wrap"><table className="prototype-table prototype-store-table"><thead><tr><th>Reference / date</th><th>Product</th><th>Cartons</th><th>Units per carton</th><th>Individual units</th><th>Posted units</th><th>Source</th><th>Actions</th></tr></thead><tbody>{displayedRecords.map((record) => <ReceivingTableRow key={record.id} record={record} expanded={expandedRecordId === record.id} menuOpen={menuRecordId === record.id} onToggle={() => setExpandedRecordId((current) => current === record.id ? '' : record.id)} onMenu={() => setMenuRecordId((current) => current === record.id ? '' : record.id)} onCloseMenu={() => setMenuRecordId('')} onEdit={() => beginEdit(record)} onView={() => { setExpandedRecordId(record.id); setMenuRecordId('') }} onHistory={() => { setExpandedRecordId(record.id); setMenuRecordId('') }} />)}</tbody></table></div>
        <div className="prototype-mobile-list">{displayedRecords.map((record) => <article className="prototype-record-card" key={record.id}><div className="prototype-record-card-heading"><span><b>{record.productName}</b><small>{record.reference} · {formatDate(record.receivedAt)}</small></span><RecordMenu record={record} open={menuRecordId === record.id} onToggle={() => setMenuRecordId((current) => current === record.id ? '' : record.id)} onClose={() => setMenuRecordId('')} onEdit={() => beginEdit(record)} onView={() => { setExpandedRecordId(record.id); setMenuRecordId('') }} onHistory={() => { setExpandedRecordId(record.id); setMenuRecordId('') }} /></div><div className="prototype-record-details"><span>Cartons <b>{record.cartons.toLocaleString()}</b></span><span>Units per carton <b>{record.unitsPerCarton?.toLocaleString() ?? 'Unknown'}</b></span><span>Individual units <b>{record.individualUnits ?? 0}</b></span><span>Stock posted <b>{(record.stockUnits ?? record.totalUnits ?? 0).toLocaleString()}</b></span><span>Source <b>{record.supplier || record.deliveryReference || '—'}</b></span></div><button type="button" className="prototype-detail-button" aria-expanded={expandedRecordId === record.id} onClick={() => setExpandedRecordId((current) => current === record.id ? '' : record.id)}>{expandedRecordId === record.id ? 'Hide' : 'View'} details <ChevronDown size={14} /></button>{expandedRecordId === record.id && <ReceivingDetails record={record} />}</article>)}</div>
      </>}
      {visibleRecords.length > 0 && <p className="prototype-result-count">Showing {displayedRecords.length} of {visibleRecords.length} matching receipts</p>}
    </section>

    {editingRecord && <div className="modal-backdrop" role="presentation"><section className="modal wide store-edit-modal" role="dialog" aria-modal="true" aria-labelledby="store-edit-title"><header className="modal-header"><div><div className="eyebrow">Adjust saved receipt</div><h2 id="store-edit-title">{editingRecord.reference}</h2><p>Live stock changes by the difference from the saved quantity.</p></div><button type="button" className="icon-button" onClick={() => { setEditingRecord(null); setError('') }} aria-label="Close edit receipt"><X /></button></header>
      <form className="prototype-form" onSubmit={saveEdit} noValidate><label className="prototype-field prototype-field-wide">Product<input disabled value={`${editingRecord.productName} · ${editingRecord.sku}`} /><small>The source product stays fixed to preserve stock history.</small></label><label className="prototype-field">Date received<input type="datetime-local" value={draft.receivedAt} onChange={(event) => setDraft((current) => ({ ...current, receivedAt: event.target.value }))} /></label><label className="prototype-field">Individual units<input type="number" min="0" step="1" value={draft.individualUnits} onChange={(event) => setDraft((current) => ({ ...current, individualUnits: event.target.value }))} /></label><label className="prototype-field">Cartons<input type="number" min="0" step="1" value={draft.cartons} onChange={(event) => setDraft((current) => ({ ...current, cartons: event.target.value }))} /></label><label className="prototype-field">Units per carton<input type="number" min="1" step="1" value={draft.unitsPerCarton} onChange={(event) => setDraft((current) => ({ ...current, unitsPerCarton: event.target.value }))} /></label><div className="prototype-calculation"><PackageCheck size={18} /><div><span>New receipt quantity</span><strong>{totalUnits === null ? 'Check quantities' : totalUnits.toLocaleString()}</strong></div><small>Previously posted: {(editingRecord.stockUnits ?? editingRecord.totalUnits ?? 0).toLocaleString()} units</small></div><label className="prototype-field">Supplier or source<input maxLength={120} value={draft.supplier} onChange={(event) => setDraft((current) => ({ ...current, supplier: event.target.value }))} /></label><label className="prototype-field">Delivery reference<input maxLength={100} value={draft.deliveryReference} onChange={(event) => setDraft((current) => ({ ...current, deliveryReference: event.target.value }))} /></label><label className="prototype-field prototype-field-wide">Notes<textarea maxLength={500} rows={3} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /></label>{error && <p className="prototype-feedback error" role="alert">{error}</p>}<div className="prototype-feedback store-edit-note">If the lower quantity has already been sold or transferred, the server will block the edit rather than create negative stock.</div><div className="prototype-form-actions prototype-field-wide"><button type="button" className="secondary-button" onClick={() => { setEditingRecord(null); setError('') }} disabled={saving}>Cancel</button><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button></div></form>
      </section></div>}
  </div>
}

function SummaryCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <article className="prototype-stat"><div className="prototype-stat-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>
}

function RecordMenu({ record, open, onToggle, onClose, onEdit, onView, onHistory }: { record: StoreReceivingRecord; open: boolean; onToggle: () => void; onClose: () => void; onEdit: () => void; onView: () => void; onHistory: () => void }) {
  return <div className="prototype-record-menu-wrap"><button type="button" className="prototype-menu-button" aria-label={`Actions for receipt ${record.reference}`} aria-expanded={open} onClick={onToggle}><MoreVertical size={18} /></button>{open && <div className="prototype-branch-menu prototype-record-menu" role="menu"><button role="menuitem" type="button" onClick={onEdit}><Pencil size={14} />Edit store record</button><button role="menuitem" type="button" onClick={onView}><Eye size={14} />View details</button>{(record.history?.length ?? 0) > 0 && <button role="menuitem" type="button" onClick={onHistory}><History size={14} />View update history</button>}<button role="menuitem" type="button" onClick={onClose}><X size={14} />Close menu</button></div>}</div>
}

function ReceivingTableRow({ record, expanded, menuOpen, onToggle, onMenu, onCloseMenu, onEdit, onView, onHistory }: { record: StoreReceivingRecord; expanded: boolean; menuOpen: boolean; onToggle: () => void; onMenu: () => void; onCloseMenu: () => void; onEdit: () => void; onView: () => void; onHistory: () => void }) {
  return <><tr><td><b>{record.reference}</b><small>{formatDate(record.receivedAt)}</small></td><td><b>{record.productName}</b><small>{record.sku}{record.barcode ? ` · ${record.barcode}` : ''}</small></td><td>{record.cartons.toLocaleString()}</td><td>{record.unitsPerCarton?.toLocaleString() ?? 'Unknown'}</td><td>{(record.individualUnits ?? 0).toLocaleString()}</td><td>{(record.stockUnits ?? record.totalUnits ?? 0).toLocaleString()}</td><td>{record.supplier || record.deliveryReference || '—'}</td><td><RecordMenu record={record} open={menuOpen} onToggle={onMenu} onClose={onCloseMenu} onEdit={onEdit} onView={onView} onHistory={onHistory} /></td></tr>{expanded && <tr className="prototype-expanded-row"><td colSpan={8}><ReceivingDetails record={record} /></td></tr>}</>
}

function ReceivingDetails({ record }: { record: StoreReceivingRecord }) {
  return <div className="prototype-transfer-details"><div className="prototype-transfer-meta"><span>Reference <b>{record.reference}</b></span><span>Received <b>{formatDate(record.receivedAt)}</b></span><span>Product <b>{record.productName}</b></span><span>SKU <b>{record.sku}</b></span>{record.barcode && <span>Barcode <b>{record.barcode}</b></span>}<span>Individual units <b>{(record.individualUnits ?? 0).toLocaleString()}</b></span><span>Cartons <b>{record.cartons.toLocaleString()}</b></span><span>Units per carton <b>{record.unitsPerCarton?.toLocaleString() ?? 'Unknown'}</b></span><span>Stock posted <b>{(record.stockUnits ?? record.totalUnits ?? 0).toLocaleString()}</b></span><span>Supplier/source <b>{record.supplier || '—'}</b></span><span>Delivery reference <b>{record.deliveryReference || '—'}</b></span><span>Status <b>{record.status}</b></span></div>{record.notes && <p className="prototype-transfer-notes"><b>Notes:</b> {record.notes}</p>}{(record.history?.length ?? 0) > 0 && <div className="prototype-update-history"><b>Update history</b>{record.history?.map((entry, index) => <p key={`${entry.at}-${index}`}>{formatDate(entry.at)} · stock adjustment {entry.stockDeltaUnits > 0 ? '+' : ''}{entry.stockDeltaUnits} units</p>)}</div>}</div>
}
