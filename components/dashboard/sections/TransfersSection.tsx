'use client'

import { useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeftRight, Building2, CalendarDays, ChevronDown, ClipboardList, Eye, History, MoreVertical, Package, Pencil, Plus, Search, Send, X } from 'lucide-react'
import type { Product, PrototypeBranch, PrototypeTransfer, PrototypeTransferLine } from '../types'
import { localDateValue, validateBranchName } from '@/lib/store-transfers-prototype'
import { SearchableProductSelect } from '../SearchableProductSelect'

type TransfersSectionProps = {
  products: Product[]
  productsLoading: boolean
  productsError: string
  persistenceError: string
  branches: PrototypeBranch[]
  transfers: PrototypeTransfer[]
  onCreate: (transfer: PrototypeTransfer) => Promise<PrototypeTransfer>
  onUpdate: (id: string, transfer: PrototypeTransfer, expectedRevision: number) => Promise<PrototypeTransfer>
  onAddBranch: (name: string) => Promise<string | null>
  onRenameBranch: (id: string, name: string) => Promise<string | null>
}

type DraftLine = { productId: string; unit: 'units' | 'cartons'; quantity: string; unitsPerCarton: string; manualSourceText?: string }
type Draft = { transferDate: string; destinationBranchId: string; sourceLocation: string; lines: DraftLine[]; manualItems: string; notes: string }
type ManualProposal = { index: number; text: string; product: Product | null; ambiguous: boolean; quantity: number; unit: 'units' | 'cartons' }

function localDateTimeValue(date = new Date()) { return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }
function dateOnly(value: string) { return value.slice(0, 10) }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function emptyDraft(): Draft { return { transferDate: localDateTimeValue(), destinationBranchId: '', sourceLocation: 'Main Store', lines: [{ productId: '', unit: 'units', quantity: '', unitsPerCarton: '' }], manualItems: '', notes: '' } }
function draftFromTransfer(transfer: PrototypeTransfer): Draft { return { transferDate: localDateTimeValue(new Date(transfer.transferDate)), destinationBranchId: transfer.destinationBranchId, sourceLocation: transfer.sourceLocation, lines: transfer.lines.map((line) => ({ productId: String(line.productId), unit: line.unit ?? 'units', quantity: String(line.quantity), unitsPerCarton: line.unitsPerCarton ? String(line.unitsPerCarton) : '', manualSourceText: line.manualSourceText })), manualItems: transfer.manualItems ?? '', notes: transfer.notes ?? '' } }

function parseManualItems(value: string, products: Product[]): ManualProposal[] {
  return value.split(/\r?\n/).map((text, index) => ({ text: text.trim(), index })).filter((line) => line.text).map(({ text, index }) => {
    const match = text.match(/^(.+?)\s*[-–:]\s*(\d+(?:\.\d+)?)\s*(units?|pieces?|pcs?|cartons?|ctns?)$/i)
    if (!match) return { index, text, product: null, ambiguous: false, quantity: 0, unit: 'units' as const }
    const needle = match[1].trim().toLocaleLowerCase()
    const exact = products.filter((product) => product.name.trim().toLocaleLowerCase() === needle)
    const unit = /carton|ctn/i.test(match[3]) ? 'cartons' as const : 'units' as const
    return { index, text, product: exact.length === 1 ? exact[0] : null, ambiguous: exact.length > 1, quantity: Number(match[2]), unit }
  })
}

function getLineStockUnits(line: DraftLine): number | null {
  const quantity = Number(line.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0) return null
  if (line.unit === 'units') return Math.abs(quantity * 1000 - Math.round(quantity * 1000)) <= 0.000001 ? Math.round(quantity * 1000) / 1000 : null
  const unitsPerCarton = Number(line.unitsPerCarton)
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(unitsPerCarton) || unitsPerCarton <= 0) return null
  const total = quantity * unitsPerCarton
  return Number.isSafeInteger(total) && total <= 1_000_000_000 ? total : null
}

export function TransfersSection({ products, productsLoading, productsError, persistenceError, branches, transfers, onCreate, onUpdate, onAddBranch, onRenameBranch }: TransfersSectionProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [branchManagerOpen, setBranchManagerOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [editingTransfer, setEditingTransfer] = useState<PrototypeTransfer | null>(null)
  const [branchName, setBranchName] = useState('')
  const [branchError, setBranchError] = useState('')
  const [editingBranchId, setEditingBranchId] = useState('')
  const [editingBranchName, setEditingBranchName] = useState('')
  const [openMenuId, setOpenMenuId] = useState('')
  const [expandedTransferId, setExpandedTransferId] = useState('')
  const [search, setSearch] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [branchFilter, setBranchFilter] = useState('All')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')
  const [saving, setSaving] = useState(false)
  const submitLock = useRef(false)
  const branchLock = useRef(false)
  const createRequestKey = useRef('')
  const proposals = useMemo(() => parseManualItems(draft.manualItems, products), [draft.manualItems, products])
  const today = localDateValue()

  const records = useMemo(() => transfers.filter((transfer) => {
    const currentBranchName = branches.find((branch) => branch.id === transfer.destinationBranchId)?.name ?? transfer.destinationNameAtTransfer
    const searchable = `${transfer.reference} ${transfer.destinationNameAtTransfer} ${currentBranchName} ${transfer.sourceLocation} ${transfer.manualItems ?? ''} ${transfer.notes} ${transfer.lines.map((line) => `${line.productName} ${line.sku} ${line.manualSourceText ?? ''}`).join(' ')}`.toLocaleLowerCase()
    const day = dateOnly(transfer.transferDate)
    return searchable.includes(search.trim().toLocaleLowerCase()) && (branchFilter === 'All' || transfer.destinationBranchId === branchFilter) && (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo)
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.transferDate.localeCompare(a.transferDate)), [transfers, branches, search, branchFilter, dateFrom, dateTo])
  const displayedRecords = showHistory ? records : records.slice(0, 20)

  const totalLines = transfers.reduce((total, transfer) => total + transfer.lines.length, 0)
  const latestTransfer = [...transfers].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.transferDate.localeCompare(a.transferDate))[0]
  const updateLine = (index: number, key: keyof DraftLine, value: string) => setDraft((current) => ({ ...current, lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line) }))

  const addManualProposal = (proposal: ManualProposal) => {
    if (!proposal.product) return
    if (draft.lines.some((line) => line.productId === String(proposal.product!.id))) { setFormError(`${proposal.product.name} is already selected. Keep one stock row for that product to avoid duplicate deductions.`); return }
    const line: DraftLine = { productId: String(proposal.product.id), unit: proposal.unit, quantity: String(proposal.quantity), unitsPerCarton: '', manualSourceText: proposal.text }
    setDraft((current) => {
      const emptyIndex = current.lines.findIndex((item) => !item.productId && !item.quantity.trim() && !item.unitsPerCarton.trim())
      return { ...current, lines: emptyIndex < 0 ? [...current.lines, line] : current.lines.map((item, index) => index === emptyIndex ? line : item) }
    })
    setFormError('')
  }

  const removeLine = (index: number) => setDraft((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }))
  const openCreate = () => { setEditingTransfer(null); if (!createRequestKey.current) setDraft({ ...emptyDraft(), destinationBranchId: branches[0]?.id ?? '' }); setFormOpen(true); setFormError(''); setFormSuccess('') }
  const openEdit = (transfer: PrototypeTransfer) => { setEditingTransfer(transfer); setDraft(draftFromTransfer(transfer)); setFormOpen(true); setFormError(''); setFormSuccess(''); setOpenMenuId('') }

  const submitTransfer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitLock.current || saving) return
    setFormError(''); setFormSuccess('')
    const branch = branches.find((item) => item.id === draft.destinationBranchId)
    if (!branch) return setFormError('Choose a valid destination branch.')
    const localDate = new Date(draft.transferDate)
    if (!draft.transferDate || Number.isNaN(localDate.getTime())) return setFormError('Choose a valid transfer date and time.')
    if (!draft.sourceLocation.trim() || draft.sourceLocation.trim().length > 100) return setFormError('Enter a source location of 1 to 100 characters.')
    if (draft.lines.length > 30) return setFormError('A transfer can have no more than 30 stock product rows.')
    if (draft.notes.trim().length > 1000 || draft.manualItems.trim().length > 4000) return setFormError('Manual descriptions or notes exceed the allowed length.')
    const completedDraftLines = draft.lines.filter((line) => line.productId || line.quantity.trim() || line.unitsPerCarton.trim())
    if (!completedDraftLines.length && !draft.manualItems.trim()) return setFormError('Add a stock product or describe at least one manual transfer item.')
    const seen = new Set<number>()
    const transferLines: PrototypeTransferLine[] = []
    const totals = new Map<number, number>()
    for (const line of completedDraftLines) {
      const product = products.find((item) => String(item.id) === line.productId)
      const stockUnits = getLineStockUnits(line)
      if (!product || stockUnits === null) return setFormError('Choose a product and enter a valid quantity and unit conversion on every stock row.')
      if (seen.has(product.id)) return setFormError(`Use one stock row per product (${product.name}); combine its quantities in that row.`)
      seen.add(product.id)
      const total = stockUnits + (totals.get(product.id) ?? 0)
      if (total > product.stock) return setFormError(`Insufficient stock for ${product.name}. Available: ${product.stock}; requested: ${total}.`)
      totals.set(product.id, total)
      transferLines.push({ productId: product.id, productName: product.name, sku: product.sku || product.model, barcode: product.barcode ?? '', unit: line.unit, quantity: Number(line.quantity), unitsPerCarton: line.unit === 'cartons' ? Number(line.unitsPerCarton) : null, stockUnits, ...(line.manualSourceText ? { manualSourceText: line.manualSourceText } : {}) })
    }
    submitLock.current = true; setSaving(true)
    try {
      const transfer: PrototypeTransfer = {
        id: editingTransfer?.id ?? (createRequestKey.current || (createRequestKey.current = crypto.randomUUID())),
        reference: editingTransfer?.reference ?? '',
        transferDate: localDate.toISOString(),
        destinationBranchId: branch.id,
        destinationNameAtTransfer: branch.name,
        sourceLocation: draft.sourceLocation.trim(),
        lines: transferLines,
        manualItems: draft.manualItems.trim(),
        notes: draft.notes.trim(),
        status: 'Recorded',
        createdAt: editingTransfer?.createdAt ?? new Date().toISOString(),
        revision: editingTransfer?.revision,
        history: editingTransfer?.history,
      }
      const saved = editingTransfer ? await onUpdate(editingTransfer.id, transfer, editingTransfer.revision ?? 1) : await onCreate(transfer)
      if (!editingTransfer) createRequestKey.current = ''
      setFormSuccess(editingTransfer ? `${saved.reference} updated. Stock was adjusted only by the transfer difference.` : `${saved.reference} saved. Confirmed stock products were deducted once.`)
      setEditingTransfer(saved)
      setDraft(draftFromTransfer(saved))
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : 'Transfer could not be saved.') }
    finally { submitLock.current = false; setSaving(false) }
  }

  const submitBranch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (branchLock.current) return
    const validation = validateBranchName(branchName, branches)
    if (validation) { setBranchError(validation); return }
    branchLock.current = true
    const error = await onAddBranch(branchName)
    setBranchError(error ?? '')
    if (!error) setBranchName('')
    branchLock.current = false
  }

  const saveBranchEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (branchLock.current) return
    const validation = validateBranchName(editingBranchName, branches, editingBranchId)
    if (validation) { setBranchError(validation); return }
    branchLock.current = true
    const error = await onRenameBranch(editingBranchId, editingBranchName)
    setBranchError(error ?? '')
    if (!error) { setEditingBranchId(''); setEditingBranchName('') }
    branchLock.current = false
  }

  return <div className="prototype-module">
    {persistenceError && <p className="prototype-storage-warning" role="alert">{persistenceError}</p>}
    <div className="prototype-actions"><div><span className="prototype-local-label"><ArrowLeftRight size={14} /> Inventory transfers</span><p>Transfers deduct confirmed stock from the source inventory and keep an audit trail.</p></div><div className="prototype-action-group"><button type="button" className="secondary-button" onClick={() => setBranchManagerOpen((open) => !open)} aria-expanded={branchManagerOpen}><Building2 size={16} /> Manage branches</button><button type="button" className="primary-button" onClick={openCreate}><Plus /> New Transfer</button></div></div>
    <div className="prototype-stats prototype-stats-four"><SummaryCard icon={<ClipboardList />} label="Recorded transfers" value={transfers.length.toLocaleString()} detail="Saved in database" /><SummaryCard icon={<Building2 />} label="Destination branches" value={branches.length.toLocaleString()} detail="Stable branch identities" /><SummaryCard icon={<Package />} label="Product lines" value={totalLines.toLocaleString()} detail="Across saved transfers" /><SummaryCard icon={<CalendarDays />} label="Latest transfer" value={latestTransfer ? formatDate(latestTransfer.transferDate) : '—'} detail={latestTransfer?.reference ?? 'No transfer activity yet'} /></div>

    {branchManagerOpen && <section className="prototype-panel" aria-labelledby="branch-manager-title"><div className="prototype-history-heading"><div><span className="prototype-kicker">Destinations</span><h2 id="branch-manager-title">Branch management</h2><p>Branch IDs stay stable when names change.</p></div></div><div className="prototype-branch-list">{branches.map((branch) => <article className="prototype-branch-row" key={branch.id}>{editingBranchId === branch.id ? <form className="prototype-branch-edit" onSubmit={saveBranchEdit}><label className="prototype-field">Branch name<input autoFocus maxLength={80} value={editingBranchName} onChange={(event) => setEditingBranchName(event.target.value)} /></label><button className="primary-button" type="submit" disabled={saving}>Save</button><button className="secondary-button" type="button" onClick={() => { setEditingBranchId(''); setBranchError('') }}>Cancel</button></form> : <><div className="prototype-branch-symbol"><Building2 size={17} /></div><div className="prototype-branch-info"><b>{branch.name}</b><small>{transfers.filter((transfer) => transfer.destinationBranchId === branch.id).length} recorded transfer(s)</small></div><button type="button" className="prototype-menu-button" aria-label={`Rename ${branch.name}`} onClick={() => { setEditingBranchId(branch.id); setEditingBranchName(branch.name); setBranchError('') }}><Pencil size={16} /></button></>}</article>)}</div><form className="prototype-add-branch" onSubmit={submitBranch}><label className="prototype-field">New branch name<input maxLength={80} value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="For example, Branch 3" /></label><button type="submit" className="secondary-button" disabled={saving}><Plus size={16} /> Add Branch</button></form>{branchError && <p className="prototype-feedback error" role="alert">{branchError}</p>}</section>}

    {formOpen && <section className="prototype-panel" aria-labelledby="new-transfer-title"><div className="prototype-panel-heading"><div><span className="prototype-kicker">Goods dispatch</span><h2 id="new-transfer-title">{editingTransfer ? `Edit ${editingTransfer.reference}` : 'New transfer'}</h2><p>Inventory changes commit with the transfer record. Editing reverses the old effect and applies only the difference.</p></div><button type="button" className="icon-button" onClick={() => { setFormOpen(false); setEditingTransfer(null); setFormError('') }} aria-label="Close transfer form"><X /></button></div>
      <form className="prototype-form" onSubmit={submitTransfer} noValidate>
        <label className="prototype-field">Transfer date and time <span className="required-mark">*</span><input type="datetime-local" value={draft.transferDate} onChange={(event) => setDraft((current) => ({ ...current, transferDate: event.target.value }))} /></label>
        <label className="prototype-field">Destination branch <span className="required-mark">*</span><select value={draft.destinationBranchId} onChange={(event) => setDraft((current) => ({ ...current, destinationBranchId: event.target.value }))}><option value="">Select destination</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <label className="prototype-field">Source location<input maxLength={100} value={draft.sourceLocation} onChange={(event) => setDraft((current) => ({ ...current, sourceLocation: event.target.value }))} /></label>
        <div className="prototype-field prototype-field-wide prototype-lines-block"><div className="prototype-lines-heading"><div><b>Stock products <span className="prototype-optional">optional when manual items are present</span></b><small>Only these selected or explicitly confirmed lines affect inventory.</small></div><button type="button" className="secondary-button" onClick={() => setDraft((current) => ({ ...current, lines: [...current.lines, { productId: '', unit: 'units', quantity: '', unitsPerCarton: '' }] }))} disabled={draft.lines.length >= 30}><Plus size={15} /> Add product</button></div>
          <div className="prototype-line-list">{draft.lines.map((line, index) => { const product = products.find((item) => String(item.id) === line.productId); const stockUnits = getLineStockUnits(line); const alreadyRequested = draft.lines.slice(0, index).filter((other) => other.productId === line.productId).reduce((total, other) => total + (getLineStockUnits(other) ?? 0), 0); const remaining = product ? product.stock - alreadyRequested - (stockUnits ?? 0) : null; return <div className="prototype-transfer-line prototype-transfer-line-rich" key={`line-${index}`}>
              <label className="prototype-field">Product<SearchableProductSelect products={products} value={line.productId} onChange={(productId) => updateLine(index, 'productId', productId)} disabled={productsLoading || !!productsError || saving} includeOutOfStock={!!editingTransfer} label={`Transfer product row ${index + 1}`} /></label>
              <label className="prototype-field">Unit<select value={line.unit} onChange={(event) => updateLine(index, 'unit', event.target.value)}><option value="units">Individual units</option><option value="cartons">Cartons</option></select></label>
              <label className="prototype-field">Quantity<input type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateLine(index, 'quantity', event.target.value)} placeholder="0" /></label>
              {line.unit === 'cartons' && <label className="prototype-field">Units / carton<input type="number" min="1" step="1" value={line.unitsPerCarton} onChange={(event) => updateLine(index, 'unitsPerCarton', event.target.value)} placeholder="Set per transfer" /></label>}
              <button type="button" className="prototype-remove-line" aria-label={`Remove product row ${index + 1}`} onClick={() => removeLine(index)}><X size={17} /></button>
              <p className={`prototype-line-stock${remaining !== null && remaining < 0 ? ' is-error' : ''}`}>{product ? `Available ${product.stock.toLocaleString()} units · transfer ${stockUnits?.toLocaleString() ?? '—'} · remaining ${remaining?.toLocaleString() ?? '—'} units` : line.manualSourceText ? `Confirmed from text: “${line.manualSourceText}”` : 'Select an available product.'}</p>
            </div> })}</div>
          {productsLoading && <p className="prototype-inline-note" role="status">Loading products…</p>}{productsError && <p className="prototype-inline-note" role="alert">{productsError}</p>}
        </div>
        <label className="prototype-field prototype-field-wide">Manual transfer items <span className="prototype-optional">optional · no stock effect unless confirmed below</span><textarea rows={4} maxLength={4000} value={draft.manualItems} onChange={(event) => setDraft((current) => ({ ...current, manualItems: event.target.value }))} placeholder={'One item per line, for example:\nItem name - 5 cartons'} /></label>
        {proposals.length > 0 && <div className="prototype-manual-proposals prototype-field-wide"><b>Review possible stock matches</b><small>Exact product names and a clear quantity are parsed for your review only. Nothing deducts stock until you confirm and enter any required carton conversion.</small>{proposals.map((proposal) => <div className="prototype-manual-proposal" key={proposal.index}><span><b>{proposal.text}</b>{proposal.ambiguous ? <small>More than one exact catalog name matches; keep this as manual text or select a product above.</small> : proposal.product ? <small>Exact match: {proposal.product.name} · parsed {proposal.quantity} {proposal.unit}</small> : <small>No exact unambiguous catalog match; this will remain manual.</small>}</span>{proposal.product && <button type="button" className="secondary-button" onClick={() => addManualProposal(proposal)} disabled={draft.lines.some((line) => line.manualSourceText === proposal.text)}>{draft.lines.some((line) => line.manualSourceText === proposal.text) ? 'Confirmed' : 'Confirm match'}</button>}</div>)}</div>}
        <label className="prototype-field prototype-field-wide">Notes <span className="prototype-optional">optional</span><textarea rows={3} maxLength={1000} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Dispatch notes or reference" /></label>
        {formError && <p className="prototype-feedback error" role="alert">{formError}</p>}{formSuccess && <p className="prototype-feedback success" role="status">{formSuccess}</p>}
        <div className="prototype-form-actions prototype-field-wide"><span className="prototype-status"><i /> Atomic stock posting</span><button type="submit" className="primary-button" disabled={saving || productsLoading || (!!productsError && draft.lines.some((line) => line.productId || line.quantity.trim() || line.unitsPerCarton.trim()))}>{saving ? 'Saving…' : editingTransfer ? 'Save transfer changes' : 'Save transfer'}</button></div>
      </form>
    </section>}

    <section className="prototype-panel"><div className="prototype-history-heading"><div><span className="prototype-kicker">Dispatch log</span><h2>Transfer history</h2><p>{transfers.length} saved transfer{transfers.length === 1 ? '' : 's'} · stock adjustments are traceable</p></div><div className="prototype-history-controls"><label className="prototype-search"><Search size={16} /><input aria-label="Search transfer history" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transfers" /></label>{records.length > 20 && <button type="button" className="secondary-button prototype-history-toggle" onClick={() => setShowHistory((value) => !value)} aria-expanded={showHistory}>{showHistory ? 'Back to Recent' : 'View History'}</button>}</div></div>
      <div className="prototype-filters"><label>Branch<select aria-label="Filter by branch" value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)}><option value="All">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label>From<input aria-label="Filter transfers from date" type="date" value={dateFrom} max={dateTo || today} onChange={(event) => setDateFrom(event.target.value)} /></label><label>To<input aria-label="Filter transfers through date" type="date" value={dateTo} min={dateFrom || undefined} max={today} onChange={(event) => setDateTo(event.target.value)} /></label><button type="button" className="prototype-detail-button" onClick={() => { setSearch(''); setBranchFilter('All'); setDateFrom(''); setDateTo('') }}>Reset filters</button></div>
      {records.length === 0 ? <div className="prototype-empty"><ArrowLeftRight size={25} /><b>{transfers.length ? 'No matching transfers' : 'No transfers recorded yet'}</b><span>{transfers.length ? 'Adjust or clear the search, branch, or date filters.' : 'Use New Transfer to post goods sent to a branch.'}</span></div> : <>
        <div className="prototype-table-wrap"><table className="prototype-table"><thead><tr><th>Reference / date</th><th>Destination</th><th>Product lines</th><th>Stock units</th><th>Actions</th></tr></thead><tbody>
          {displayedRecords.map((transfer) => <TransferTableRow key={transfer.id} transfer={transfer} branches={branches} expanded={expandedTransferId === transfer.id} menuOpen={openMenuId === transfer.id} onToggle={() => setExpandedTransferId((current) => current === transfer.id ? '' : transfer.id)} onMenu={() => setOpenMenuId((current) => current === transfer.id ? '' : transfer.id)} onCloseMenu={() => setOpenMenuId('')} onEdit={() => openEdit(transfer)} onView={() => { setExpandedTransferId(transfer.id); setOpenMenuId('') }} onHistory={() => { setExpandedTransferId(transfer.id); setOpenMenuId('') }} />)}
        </tbody></table></div>
        <div className="prototype-mobile-list">{displayedRecords.map((transfer) => <TransferCard key={transfer.id} transfer={transfer} branches={branches} expanded={expandedTransferId === transfer.id} menuOpen={openMenuId === transfer.id} onToggle={() => setExpandedTransferId((current) => current === transfer.id ? '' : transfer.id)} onMenu={() => setOpenMenuId((current) => current === transfer.id ? '' : transfer.id)} onCloseMenu={() => setOpenMenuId('')} onEdit={() => openEdit(transfer)} onView={() => { setExpandedTransferId(transfer.id); setOpenMenuId('') }} onHistory={() => { setExpandedTransferId(transfer.id); setOpenMenuId('') }} />)}</div>
        <p className="prototype-result-count">Showing {displayedRecords.length} of {records.length} matching transfers</p>
      </>}
    </section>
  </div>
}

function SummaryCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) { return <article className="prototype-stat"><div className="prototype-stat-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></article> }

function TransferMenu({ transfer, open, onToggle, onClose, onEdit, onView, onHistory }: { transfer: PrototypeTransfer; open: boolean; onToggle: () => void; onClose: () => void; onEdit: () => void; onView: () => void; onHistory: () => void }) { return <div className="prototype-record-menu-wrap"><button type="button" className="prototype-menu-button" aria-label={`Actions for ${transfer.reference}`} aria-expanded={open} onClick={onToggle}><MoreVertical size={18} /></button>{open && <div className="prototype-branch-menu prototype-record-menu" role="menu"><button type="button" role="menuitem" onClick={onEdit}><Pencil size={14} />Edit transfer</button><button type="button" role="menuitem" onClick={onView}><Eye size={14} />View details</button>{(transfer.history?.length ?? 0) > 0 && <button type="button" role="menuitem" onClick={onHistory}><History size={14} />View update history</button>}<button type="button" role="menuitem" onClick={onClose}><X size={14} />Close menu</button></div>}</div> }

function TransferTableRow({ transfer, branches, expanded, menuOpen, onToggle, onMenu, onCloseMenu, onEdit, onView, onHistory }: { transfer: PrototypeTransfer; branches: PrototypeBranch[]; expanded: boolean; menuOpen: boolean; onToggle: () => void; onMenu: () => void; onCloseMenu: () => void; onEdit: () => void; onView: () => void; onHistory: () => void }) {
  const name = branches.find((branch) => branch.id === transfer.destinationBranchId)?.name ?? transfer.destinationNameAtTransfer
  const stockUnits = transfer.lines.reduce((total, line) => total + (line.stockUnits ?? line.quantity), 0)
  return <><tr><td><b>{transfer.reference}</b><small>{formatDate(transfer.transferDate)}</small></td><td><b>{name}</b>{name !== transfer.destinationNameAtTransfer && <small>Was {transfer.destinationNameAtTransfer}</small>}</td><td>{transfer.lines.length} stock line{transfer.lines.length === 1 ? '' : 's'}{transfer.manualItems && <small>Manual items included</small>}</td><td>{stockUnits.toLocaleString()} units</td><td><TransferMenu transfer={transfer} open={menuOpen} onToggle={onMenu} onClose={onCloseMenu} onEdit={onEdit} onView={onView} onHistory={onHistory} /></td></tr>{expanded && <tr className="prototype-expanded-row"><td colSpan={5}><TransferDetails transfer={transfer} currentName={name} /></td></tr>}</>
}

function TransferCard({ transfer, branches, expanded, menuOpen, onToggle, onMenu, onCloseMenu, onEdit, onView, onHistory }: { transfer: PrototypeTransfer; branches: PrototypeBranch[]; expanded: boolean; menuOpen: boolean; onToggle: () => void; onMenu: () => void; onCloseMenu: () => void; onEdit: () => void; onView: () => void; onHistory: () => void }) {
  const name = branches.find((branch) => branch.id === transfer.destinationBranchId)?.name ?? transfer.destinationNameAtTransfer
  return <article className="prototype-record-card"><div className="prototype-record-card-heading"><span><b>{transfer.reference}</b><small>{formatDate(transfer.transferDate)}</small></span><TransferMenu transfer={transfer} open={menuOpen} onToggle={onMenu} onClose={onCloseMenu} onEdit={onEdit} onView={onView} onHistory={onHistory} /></div><div className="prototype-record-details"><span>Destination <b>{name}</b></span><span>Source <b>{transfer.sourceLocation}</b></span><span>Products <b>{transfer.lines.length} stock line(s)</b></span><span>Stock moved <b>{transfer.lines.reduce((total, line) => total + (line.stockUnits ?? line.quantity), 0).toLocaleString()} units</b></span></div><button type="button" className="prototype-detail-button" aria-expanded={expanded} onClick={onToggle}>{expanded ? 'Hide' : 'View'} details <ChevronDown size={14} /></button>{expanded && <TransferDetails transfer={transfer} currentName={name} />}</article>
}

function TransferDetails({ transfer, currentName }: { transfer: PrototypeTransfer; currentName: string }) {
  return <div className="prototype-transfer-details"><div className="prototype-transfer-meta"><span>Reference <b>{transfer.reference}</b></span><span>Date <b>{formatDate(transfer.transferDate)}</b></span><span>Destination <b>{currentName}</b></span>{currentName !== transfer.destinationNameAtTransfer && <span>Destination when recorded <b>{transfer.destinationNameAtTransfer}</b></span>}<span>Source <b>{transfer.sourceLocation}</b></span><span>Revision <b>{transfer.revision ?? 1}</b></span></div><div className="prototype-detail-lines">{transfer.lines.map((line, index) => <div key={`${line.productId}-${index}`}><span><b>{line.productName}</b><small>{line.manualSourceText ? `Confirmed from: ${line.manualSourceText}` : `${line.sku}${line.barcode ? ` · ${line.barcode}` : ''}`} · {line.quantity} {line.unit === 'cartons' ? `cartons × ${line.unitsPerCarton} units` : 'units'}</small></span><strong>−{(line.stockUnits ?? line.quantity).toLocaleString()} units</strong></div>)}</div>{transfer.manualItems && <div className="prototype-manual-text"><b>Manual item descriptions</b><p>{transfer.manualItems}</p></div>}{transfer.notes && <p className="prototype-transfer-notes"><b>Notes:</b> {transfer.notes}</p>}{(transfer.history?.length ?? 0) > 0 && <div className="prototype-update-history"><b>Update history</b>{transfer.history?.map((entry, index) => <article key={`${entry.at}-${index}`}><small>{formatDate(entry.at)}</small><span>{entry.stockAdjustments.map((adjustment) => `${adjustment.deltaUnits > 0 ? '+' : ''}${adjustment.deltaUnits} units product ${adjustment.productId}`).join(' · ') || 'No stock quantity change'}</span></article>)}</div>}</div>
}
