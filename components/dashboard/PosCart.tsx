'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Barcode, CalendarDays, Check, Clock3, FileDown, Minus, Plus, Printer, Search, ShoppingCart, Trash2, X } from 'lucide-react'

import type { PendingOrder, Product, Sale } from './types'
import { money } from './utils'
import { listQueuedOperations, readLocalCollection, saveOfflineSaleAndOperation, savePendingOrderAndOperation, shouldAttemptServerRequest, shouldQueueAfterServerFailure, writeLocalRecord } from '@/lib/offline-queue'

type CartLine = { product: Product; quantity: number }
type PendingCheckout = {
  idempotencyKey: string
  items: { productId: number; quantity: number }[]
  cashTendered: number
}
type PrintRequest = { sale: Sale; token: number }

function moneyMinor(amount: number, currency: string) {
  return money(amount / 100, currency)
}

function formatSaleDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function normalizeCode(value: string) {
  return value.trim()
}

function availableStock(product: Product) {
  return Math.max(0, product.stock - Number(product.reservedStock ?? 0))
}

function isSaleLine(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    'productId' in value && typeof value.productId === 'number' && Number.isSafeInteger(value.productId) &&
    'name' in value && typeof value.name === 'string' &&
    'sku' in value && typeof value.sku === 'string' &&
    'barcode' in value && typeof value.barcode === 'string' &&
    'quantity' in value && typeof value.quantity === 'number' &&
    'unitPriceMinor' in value && typeof value.unitPriceMinor === 'number' &&
    'lineTotalMinor' in value && typeof value.lineTotalMinor === 'number'
}

function isSale(value: unknown): value is Sale {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || typeof value.id !== 'string' || !('receiptNumber' in value) || typeof value.receiptNumber !== 'string' ||
    !('businessName' in value) || typeof value.businessName !== 'string' || !('currency' in value) || typeof value.currency !== 'string' ||
    !('createdAt' in value) || typeof value.createdAt !== 'string' || !('items' in value) || !Array.isArray(value.items) || !value.items.every(isSaleLine) ||
    !('subtotalMinor' in value) || typeof value.subtotalMinor !== 'number' || !('discountMinor' in value) || typeof value.discountMinor !== 'number' ||
    !('taxMinor' in value) || typeof value.taxMinor !== 'number' || !('totalMinor' in value) || typeof value.totalMinor !== 'number' ||
    !('payment' in value) || typeof value.payment !== 'object' || value.payment === null) return false
  const payment = value.payment
  return 'method' in payment && payment.method === 'cash' && 'status' in payment && payment.status === 'paid' &&
    'amountTenderedMinor' in payment && typeof payment.amountTenderedMinor === 'number' &&
    'changeMinor' in payment && typeof payment.changeMinor === 'number'
}

function isSaleList(value: unknown): value is Sale[] {
  return Array.isArray(value) && value.every(isSale)
}

type SalesPage = { sales: Sale[]; total: number; hasMore: boolean; nextCursor: string | null; summary: { saleCount: number; totalMinor: number; unitsSold: number } }

function isSalesPage(value: unknown): value is SalesPage {
  return typeof value === 'object' && value !== null && 'sales' in value && isSaleList(value.sales) &&
    'total' in value && typeof value.total === 'number' && 'hasMore' in value && typeof value.hasMore === 'boolean' &&
    'nextCursor' in value && (typeof value.nextCursor === 'string' || value.nextCursor === null) &&
    'summary' in value && typeof value.summary === 'object' && value.summary !== null &&
    'saleCount' in value.summary && typeof value.summary.saleCount === 'number' &&
    'totalMinor' in value.summary && typeof value.summary.totalMinor === 'number' &&
    'unitsSold' in value.summary && typeof value.summary.unitsSold === 'number'
}

type SalesPreset = 'today' | 'yesterday' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'custom'

function localMidnight(value: Date) { return new Date(value.getFullYear(), value.getMonth(), value.getDate()) }

function salesRange(preset: SalesPreset, customFrom: string, customTo: string): { from: Date | null; to: Date | null } | null {
  const today = localMidnight(new Date())
  const nextDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
  if (preset === 'custom') {
    const parse = (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
      const [year, month, day] = value.split('-').map(Number)
      const date = new Date(year, month - 1, day)
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
    }
    const from = customFrom ? parse(customFrom) : null
    const toDay = customTo ? parse(customTo) : null
    if ((customFrom && !from) || (customTo && !toDay) || (from && toDay && from > toDay)) return null
    return { from, to: toDay ? nextDay(toDay) : null }
  }
  if (preset === 'today') return { from: today, to: nextDay(today) }
  if (preset === 'yesterday') { const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1); return { from: start, to: today } }
  const weekday = (today.getDay() + 6) % 7
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekday)
  if (preset === 'this-week') return { from: weekStart, to: nextDay(today) }
  if (preset === 'last-week') return { from: new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - 7), to: weekStart }
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  if (preset === 'this-month') return { from: monthStart, to: nextDay(today) }
  return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: monthStart }
}

export function PosCart({
  active,
  products,
  productsLoading,
  productsError,
  currency,
  workspace,
  lowStockThreshold,
  onRefreshProducts,
  onLocalSale,
  onOpen,
  onOrderCreated,
  onRegisterPrint,
}: {
  active: boolean
  products: Product[]
  productsLoading: boolean
  productsError: string
  currency: string
  workspace: string
  lowStockThreshold: number
  onRefreshProducts: () => Promise<Product[]>
  onLocalSale: (products: Product[]) => void
  onOpen: () => void
  onOrderCreated: (order: PendingOrder) => void
  onRegisterPrint: (print: (sale: Sale) => Promise<void>) => void
}) {
  const [cart, setCart] = useState<CartLine[]>([])
  const cartRef = useRef<CartLine[]>([])
  const [quantityDrafts, setQuantityDrafts] = useState<Record<number, string>>({})
  const [barcode, setBarcode] = useState('')
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [scannerReady, setScannerReady] = useState(false)
  const [cashTendered, setCashTendered] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const customerNameInput = useRef<HTMLInputElement>(null)
  const customerPhoneInput = useRef<HTMLInputElement>(null)
  const [supplyLoading, setSupplyLoading] = useState(false)
  const supplyLock = useRef(false)
  const [pendingCheckout, setPendingCheckout] = useState<PendingCheckout | null>(null)
  const pendingCheckoutRef = useRef<PendingCheckout | null>(null)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const checkoutLock = useRef(false)
  const [recentSales, setRecentSales] = useState<Sale[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentError, setRecentError] = useState('')
  const [recentQuery, setRecentQuery] = useState('')
  const [salesPreset, setSalesPreset] = useState<SalesPreset>('today')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [periodSummary, setPeriodSummary] = useState<SalesPage['summary']>({ saleCount: 0, totalMinor: 0, unitsSold: 0 })
  const [periodLoading, setPeriodLoading] = useState(false)
  const [periodError, setPeriodError] = useState('')
  const [salesRefresh, setSalesRefresh] = useState(0)
  const [archiveSales, setArchiveSales] = useState<Sale[]>([])
  const [archiveSearch, setArchiveSearch] = useState('')
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null)
  const [archiveHasMore, setArchiveHasMore] = useState(false)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [lastSale, setLastSale] = useState<Sale | null>(null)
  const [printRequest, setPrintRequest] = useState<PrintRequest | null>(null)
  const [printError, setPrintError] = useState('')
  const [printStatus, setPrintStatus] = useState('')
  const [printing, setPrinting] = useState(false)
  const scanInputRef = useRef<HTMLInputElement>(null)
  const lastScanRef = useRef({ code: '', time: 0 })
  const printTokenRef = useRef(0)
  const printLock = useRef(false)
  const archiveRequestRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const refreshLocalSales = () => void Promise.all([readLocalCollection<Sale>('sales'), listQueuedOperations()]).then(([cachedSales, operations]) => {
      if (cancelled) return
      const queuedSales = operations.flatMap((operation) => {
        if (operation.type === 'sale.create' && operation.status !== 'synchronized' && isSale(operation.payload.localSale)) return [operation.payload.localSale]
        if (operation.type === 'pending-order.accept' && operation.status !== 'synchronized' && isSale(operation.payload.localSale)) return [operation.payload.localSale]
        return []
      })
      const localSales = [...queuedSales, ...cachedSales].filter((sale, index, all) => all.findIndex((item) => item.id === sale.id) === index)
      setRecentSales((current) => [...localSales, ...current.filter((sale) => !localSales.some((local) => local.id === sale.id))])
    }).catch(() => undefined)
    refreshLocalSales()
    window.addEventListener('micomerc-queue-changed', refreshLocalSales)
    return () => { cancelled = true; window.removeEventListener('micomerc-queue-changed', refreshLocalSales) }
  }, [])

  const updateCart = useCallback((update: (lines: CartLine[]) => CartLine[]) => {
    const next = update(cartRef.current)
    cartRef.current = next
    setCart(next)
  }, [])

  useEffect(() => {
    if (!products.length) return
    updateCart((lines) => lines.map((line) => ({ ...line, product: products.find((item) => item.id === line.product.id) ?? line.product })))
  }, [products, updateCart])

  const filteredProducts = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return []
    return products.filter((product) =>
      `${product.name} ${product.sku} ${product.model} ${product.barcode ?? ''}`.toLowerCase().includes(value),
    ).slice(0, 8)
  }, [products, query])

  const subtotalMinor = cart.reduce((sum, line) => {
    const unitPriceMinor = Math.round(line.product.price * 100)
    return sum + Math.round(unitPriceMinor * line.quantity)
  }, 0)
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0)
  const pending = pendingCheckout !== null
  const cartLocked = pending || checkoutLoading
  const selectedRange = useMemo(() => salesRange(salesPreset, customFrom, customTo), [salesPreset, customFrom, customTo])
  const normalizedReceiptQuery = recentQuery.trim().toLocaleLowerCase()
  const matchingRecentSales = recentSales.filter((sale) => sale.receiptNumber.toLocaleLowerCase().includes(normalizedReceiptQuery))
  const recentSaleIds = new Set(recentSales.map((sale) => sale.id))
  const visibleArchiveSales = archiveSearch === recentQuery ? archiveSales.filter((sale) => !recentSaleIds.has(sale.id)) : []
  const visibleReceipts = [...matchingRecentSales, ...visibleArchiveSales]

  useEffect(() => {
    if (!active) return
    if (!selectedRange) { setPeriodLoading(false); setPeriodError('Enter a valid custom date range.'); setPeriodSummary({ saleCount: 0, totalMinor: 0, unitsSold: 0 }); return }
    const params = new URLSearchParams({ paged: '1', limit: '10' })
    if (selectedRange.from) params.set('from', selectedRange.from.toISOString())
    if (selectedRange.to) params.set('to', selectedRange.to.toISOString())
    let cancelled = false
    setPeriodLoading(true); setPeriodError('')
    fetch(`/api/sales?${params.toString()}`, { cache: 'no-store' })
      .then(async (response) => {
        const result: unknown = await response.json().catch(() => null)
        if (!response.ok || !isSalesPage(result)) throw new Error(typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string' ? result.message : 'Sales summary is unavailable')
        if (!cancelled) setPeriodSummary(result.summary)
      })
      .catch((error: unknown) => { if (!cancelled) setPeriodError(error instanceof Error ? error.message : 'Sales summary is unavailable') })
      .finally(() => { if (!cancelled) setPeriodLoading(false) })
    return () => { cancelled = true }
  }, [active, selectedRange, salesRefresh])

  const loadArchivePage = useCallback(async (cursor: string | null) => {
    const requestId = ++archiveRequestRef.current
    setArchiveLoading(true); setArchiveError('')
    const params = new URLSearchParams({ paged: '1', limit: '50' })
    if (recentQuery.trim()) params.set('q', recentQuery.trim())
    if (cursor) params.set('cursor', cursor)
    try {
      const response = await fetch(`/api/sales?${params.toString()}`, { cache: 'no-store' })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok || !isSalesPage(result)) throw new Error(typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string' ? result.message : 'Receipt history is unavailable')
      if (requestId === archiveRequestRef.current) {
        setArchiveSales((current) => cursor ? [...current, ...result.sales.filter((sale) => !current.some((item) => item.id === sale.id))] : result.sales)
        setArchiveSearch(recentQuery)
        setArchiveCursor(result.nextCursor)
        setArchiveHasMore(result.hasMore)
      }
    } catch (error) {
      if (requestId === archiveRequestRef.current) setArchiveError(error instanceof Error ? error.message : 'Receipt history is unavailable')
    } finally {
      if (requestId === archiveRequestRef.current) setArchiveLoading(false)
    }
  }, [recentQuery])

  useEffect(() => {
    if (!active) return
    setArchiveSales([])
    setArchiveSearch(recentQuery)
    setArchiveCursor(null)
    setArchiveHasMore(false)
    const timer = window.setTimeout(() => { void loadArchivePage(null) }, 250)
    return () => window.clearTimeout(timer)
  }, [active, recentQuery, salesRefresh, loadArchivePage])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setRecentLoading(true)
    setRecentError('')
    fetch('/api/sales?limit=10&paged=1', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Saved sales history is unavailable')
        const result: unknown = await response.json()
        if (!isSalesPage(result)) throw new Error('Saved sales history returned invalid data')
        if (!cancelled) {
          await Promise.all(result.sales.map((sale) => writeLocalRecord('sales', sale.id, sale, false)))
          const [queued, cachedSales] = await Promise.all([listQueuedOperations().catch(() => []), readLocalCollection<Sale>('sales').catch(() => [])])
          const queuedSales = queued.filter((operation) => operation.type === 'sale.create' && operation.status !== 'synchronized').map((operation) => operation.payload.localSale).filter(isSale)
          const localSales = [...queuedSales, ...cachedSales].filter((sale, index, all) => all.findIndex((item) => item.id === sale.id) === index)
          setRecentSales([...localSales, ...result.sales.filter((sale) => !localSales.some((item) => item.id === sale.id))].slice(0, 20))
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load saved sales:', error)
        if (!cancelled) setRecentError(error instanceof Error ? error.message : 'Saved sales history is unavailable')
      })
      .finally(() => { if (!cancelled) setRecentLoading(false) })
    return () => { cancelled = true }
  }, [active, salesRefresh])

  useEffect(() => {
    if (!active || productsLoading || productsError || cartLocked) return
    const frame = window.requestAnimationFrame(() => scanInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [active, productsLoading, productsError, cartLocked])

  useEffect(() => {
    if (!printRequest) return
    const afterPrint = () => setPrintRequest(null)
    window.addEventListener('afterprint', afterPrint, { once: true })
    const frame = window.requestAnimationFrame(() => {
      try {
        window.print()
      } catch (error) {
        console.error('Browser print dialog failed:', error)
        setPrintError('The print dialog could not be opened. Try again from this saved sale.')
        setPrintRequest(null)
      }
    })
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('afterprint', afterPrint)
    }
  }, [printRequest])

  const setPending = (value: PendingCheckout | null) => {
    pendingCheckoutRef.current = value
    setPendingCheckout(value)
  }

  const addProduct = (product: Product) => {
    if (cartLocked) return
    const current = cartRef.current.find((line) => line.product.id === product.id)
    const nextQuantity = (current?.quantity ?? 0) + 1
    if (!Number.isFinite(product.price) || product.price < 0) {
      setMessage(`${product.name} has an invalid selling price.`)
      return
    }
    if (typeof product.status === 'string' && product.status.trim().toLowerCase() === 'discontinued') {
      setMessage(`${product.name} is discontinued and cannot be sold.`)
      return
    }
    const available = availableStock(product)
    if (!Number.isFinite(available) || available <= 0) {
      setMessage(`${product.name} is out of stock.`)
      return
    }
    if (nextQuantity > available) {
      setMessage(`Insufficient stock for ${product.name}. Available: ${available}.`)
      return
    }
    updateCart((lines) => current
      ? lines.map((line) => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line)
      : [...lines, { product, quantity: 1 }])
    setMessage(current ? `${product.name} quantity increased.` : `${product.name} added to cart.`)
  }

  const changeQuantity = (id: number, rawValue: string) => {
    setQuantityDrafts((drafts) => ({ ...drafts, [id]: rawValue }))
    const quantity = Number(rawValue)
    const line = cartRef.current.find((item) => item.product.id === id)
    if (rawValue && line && Number.isFinite(quantity) && quantity > 0 && quantity <= availableStock(line.product) &&
      Math.abs(quantity * 1000 - Math.round(quantity * 1000)) <= 0.000001) {
      updateCart((lines) => lines.map((item) => item.product.id === id ? { ...item, quantity } : item))
      setMessage('')
    }
  }

  const processBarcode = () => {
    if (cartLocked) return
    const code = normalizeCode(barcode)
    if (!code) {
      setMessage('Enter or scan a barcode before adding a product.')
      return
    }
    if (code.length > 128 || /[\u0000-\u001f\u007f]/.test(code)) {
      setBarcode('')
      setMessage('Invalid barcode. Scan or enter a valid product code.')
      return
    }
    if (productsLoading) {
      setMessage('Inventory is still loading. Wait before scanning.')
      return
    }
    if (productsError) {
      setMessage(productsError)
      return
    }

    const scanTime = Date.now()
    if (lastScanRef.current.code === code && scanTime - lastScanRef.current.time < 100) {
      setBarcode('')
      return
    }
    lastScanRef.current = { code, time: scanTime }

    const exactBarcodeMatches = products.filter((product) =>
      typeof product.barcode === 'string' && normalizeCode(product.barcode) === code,
    )
    let product: Product | undefined
    if (exactBarcodeMatches.length > 1) {
      setBarcode('')
      setMessage(`Barcode ${code} is assigned to more than one product. Resolve the duplicate in Stocks.`)
      window.setTimeout(() => scanInputRef.current?.focus(), 0)
      return
    }
    if (exactBarcodeMatches.length === 1) {
      product = exactBarcodeMatches[0]
    } else {
      const codeMatches = products.filter((item) =>
        [item.sku, item.model].some((value) => typeof value === 'string' && value.trim().toLowerCase() === code.toLowerCase()),
      )
      if (codeMatches.length > 1) {
        setBarcode('')
        setMessage(`Product code ${code} is ambiguous. Search inventory and select the product manually.`)
        window.setTimeout(() => scanInputRef.current?.focus(), 0)
        return
      }
      product = codeMatches[0]
    }

    setBarcode('')
    if (product) addProduct(product)
    else setMessage(`Product not found for barcode ${code}. Add it to inventory before selling.`)
    window.setTimeout(() => scanInputRef.current?.focus(), 0)
  }

  const commitQuantity = (id: number) => {
    const rawValue = quantityDrafts[id]
    if (rawValue === undefined) return
    const quantity = Number(rawValue)
    const line = cartRef.current.find((item) => item.product.id === id)
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.000001) {
      setMessage('Quantity must be positive and can have at most three decimal places.')
      setQuantityDrafts((drafts) => { const next = { ...drafts }; delete next[id]; return next })
      return
    }
    if (!line || quantity > availableStock(line.product)) {
      setMessage(`Insufficient stock for ${line?.product.name ?? 'this product'}. Available: ${line ? availableStock(line.product) : 0}.`)
      setQuantityDrafts((drafts) => { const next = { ...drafts }; delete next[id]; return next })
      return
    }
    updateCart((lines) => lines.map((item) => item.product.id === id ? { ...item, quantity } : item))
    setQuantityDrafts((drafts) => { const next = { ...drafts }; delete next[id]; return next })
    setMessage('')
  }

  const markSaleCompleted = async (sale: Sale, locallyQueued = false) => {
    await writeLocalRecord('sales', sale.id, sale, locallyQueued).catch((error) => console.warn('Could not cache completed sale history:', error))
    updateCart(() => [])
    setQuantityDrafts({})
    setCashTendered('')
    setPending(null)
    setLastSale(sale)
    setRecentSales((sales) => [sale, ...sales.filter((item) => item.id !== sale.id)].slice(0, 10))
    setSalesRefresh((value) => value + 1)
    setMessage(locallyQueued ? `Sale ${sale.receiptNumber} saved on this device. It is pending synchronization.` : `Sale ${sale.receiptNumber} saved.`)
    if (!locallyQueued) void printSale(sale)
    if (locallyQueued) return
    try {
      await onRefreshProducts()
    } catch (error) {
      console.error('Sale was saved but inventory refresh failed:', error)
      setMessage(`Sale ${sale.receiptNumber} completed. Inventory could not refresh; reload the dashboard. The saved receipt remains available.`)
    }
  }

  const fetchSale = async (id: string): Promise<Sale | null> => {
    const response = await fetch(`/api/sales/${encodeURIComponent(id)}`)
    if (response.status === 404) return null
    if (!response.ok) throw new Error('Could not verify the saved sale')
    const result: unknown = await response.json()
    if (!isSale(result)) throw new Error('Saved sale returned invalid data')
    return result
  }

  const submitCheckout = async () => {
    if (checkoutLock.current || checkoutLoading) return
    checkoutLock.current = true
    const savedPending = pendingCheckoutRef.current
    let request = savedPending

    if (!request) {
      const hasInvalidDraft = Object.values(quantityDrafts).some((value) => {
        const quantity = Number(value)
        return !value || !Number.isFinite(quantity) || quantity <= 0 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.000001
      })
      if (hasInvalidDraft) {
        setMessage('Fix the invalid quantity before checkout.')
        checkoutLock.current = false
        return
      }
      if (!cartRef.current.length) {
        setMessage('Add a product before checkout.')
        checkoutLock.current = false
        return
      }
      const hasCashEntry = cashTendered.trim() !== ''
      const tender = hasCashEntry ? Number(cashTendered) : subtotalMinor / 100
      if (!Number.isFinite(tender) || tender < 0 || Math.abs(tender * 100 - Math.round(tender * 100)) > 0.000001) {
        setMessage('Enter a valid cash amount with no more than two decimal places.')
        checkoutLock.current = false
        return
      }
      if (Math.round(tender * 100) < subtotalMinor) {
        setMessage('Cash received is less than the amount due.')
        checkoutLock.current = false
        return
      }
      request = {
        idempotencyKey: crypto.randomUUID(),
        items: cartRef.current.map(({ product, quantity }) => ({ productId: product.id, quantity })),
        cashTendered: tender,
      }
      setPending(request)
    }

    setCheckoutLoading(true)
    setMessage('Checkout processing…')
    setPrintError('')
    const saveOfflineCheckout = async () => {
      const localLines = cartRef.current.map(({ product, quantity }) => ({ productId: product.id, name: product.name, sku: product.sku, barcode: product.barcode ?? '', quantity, unitPriceMinor: Math.round(product.price * 100), lineTotalMinor: Math.round(Math.round(product.price * 100) * quantity) }))
      const totalMinor = localLines.reduce((sum, line) => sum + line.lineTotalMinor, 0)
      if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || localLines.some((line) => !Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0 || !Number.isSafeInteger(line.lineTotalMinor) || line.lineTotalMinor < 0)) throw new Error('The cart total is outside the supported payment range.')
      if (Math.round(request.cashTendered * 100) < totalMinor) throw new Error('Cash received is less than the amount due.')
      const localSale: Sale = { id: request.idempotencyKey, receiptNumber: `LOCAL-${request.idempotencyKey.slice(0, 8).toUpperCase()}`, businessName: workspace, currency, createdAt: new Date().toISOString(), items: localLines, subtotalMinor: totalMinor, discountMinor: 0, taxMinor: 0, totalMinor, payment: { method: 'cash', status: 'paid', amountTenderedMinor: Math.round(request.cashTendered * 100), changeMinor: Math.max(0, Math.round(request.cashTendered * 100) - totalMinor) } }
      const queuedOperations = await listQueuedOperations()
      const productDependencies = queuedOperations.filter((operation) => {
        if (operation.status === 'synchronized') return false
        const referencedIds = new Set<number>()
        if (operation.type.startsWith('product.') && typeof operation.recordId === 'number') referencedIds.add(operation.recordId)
        if (typeof operation.payload.productId === 'number') referencedIds.add(operation.payload.productId)
        for (const key of ['items', 'lines']) {
          const rows = operation.payload[key]
          if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === 'object' && 'productId' in row && typeof row.productId === 'number') referencedIds.add(row.productId)
        }
        return localLines.some((line) => referencedIds.has(line.productId)) && /^(product\.|store\.receipt\.|transfer\.|pending-order\.|sale\.)/.test(operation.type)
      }).map((operation) => operation.id)
      const stockUpdates = await saveOfflineSaleAndOperation(localSale, {
        id: request.idempotencyKey, type: 'sale.create', label: `POS sale ${localSale.receiptNumber}`, target: '/api/sales', method: 'POST', payload: { ...request, localSale, lowStockThreshold },
        ...(productDependencies.length ? { dependsOn: productDependencies } : {}),
      }, localLines.map((line) => ({ productId: line.productId, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor })), lowStockThreshold)
      onLocalSale(stockUpdates as unknown as Product[])
      window.dispatchEvent(new Event('micomerc-queue-changed'))
      await markSaleCompleted(localSale, true)
    }
    try {
      const queuedOperations = await listQueuedOperations()
      const dependsOnPendingInventory = queuedOperations.some((operation) => {
        if (operation.status === 'synchronized' || !/^(product\.|store\.receipt\.|transfer\.|pending-order\.|sale\.)/.test(operation.type)) return false
        const affected = new Set<number>()
        if (typeof operation.recordId === 'number' && operation.type.startsWith('product.')) affected.add(operation.recordId)
        if (typeof operation.payload.productId === 'number') affected.add(operation.payload.productId)
        for (const key of ['items', 'lines']) {
          const rows = operation.payload[key]
          if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === 'object' && 'productId' in row && typeof row.productId === 'number') affected.add(row.productId)
        }
        return request!.items.some((line) => affected.has(line.productId))
      })
      if (dependsOnPendingInventory) {
        await saveOfflineCheckout()
        return
      }
      if (!shouldAttemptServerRequest()) {
        await saveOfflineCheckout()
        return
      }
      let response: Response
      try {
        response = await fetch('/api/sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
      } catch (networkError) {
        if (!(networkError instanceof TypeError)) throw networkError
        try {
          const persistedSale = await fetchSale(request.idempotencyKey)
          if (persistedSale) { await markSaleCompleted(persistedSale); return }
        } catch (verificationError) { console.error('Could not reconcile checkout after a network error:', verificationError) }
        await saveOfflineCheckout()
        return
      }
      const queueableServerFailure = !response.ok && await shouldQueueAfterServerFailure(response)
      const result: unknown = await response.json().catch(() => null)
      if (response.ok && isSale(result)) {
        await markSaleCompleted(result)
        return
      }

      const serverMessage = typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string'
        ? result.message
        : 'Checkout was rejected. Review the cart and try again.'

      if (response.status >= 500 || response.ok) {
        try {
          const persistedSale = await fetchSale(request.idempotencyKey)
          if (persistedSale) {
            await markSaleCompleted(persistedSale)
            return
          }
        } catch (verificationError) {
          console.error('Could not reconcile checkout response:', verificationError)
        }
        if (response.ok || queueableServerFailure) {
          await saveOfflineCheckout()
          return
        }
        setMessage('Checkout could not be confirmed. Retry checkout to safely verify or complete the same sale.')
        return
      }

      setPending(null)
      setMessage(serverMessage)
      if (response.status === 409) {
        try {
          const currentProducts = await onRefreshProducts()
          const byId = new Map(currentProducts.map((product) => [product.id, product]))
          updateCart((lines) => lines.map((line) => ({ ...line, product: byId.get(line.product.id) ?? line.product })))
        } catch (refreshError) {
          console.error('Failed to refresh inventory after a rejected checkout:', refreshError)
          setMessage(`${serverMessage} Inventory could not be refreshed; reload the dashboard before retrying.`)
        }
      }
    } catch (error) {
      console.error('Checkout request failed:', error)
      setMessage(error instanceof Error ? error.message : 'Checkout failed. Retry the same checkout before changing the cart.')
    } finally {
      setCheckoutLoading(false)
      checkoutLock.current = false
    }
  }

  const submitSupply = async () => {
    if (supplyLock.current || checkoutLock.current || !cartRef.current.length) return
    if (!customerName.trim()) {
      setMessage('Fill in the customer name before supplying this order.')
      customerNameInput.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      customerNameInput.current?.focus({ preventScroll: true })
      return
    }
    if (!customerPhone.trim()) {
      setMessage('Fill in the customer phone number before supplying this order.')
      customerPhoneInput.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      customerPhoneInput.current?.focus({ preventScroll: true })
      return
    }
    const quantitiesValid = !Object.values(quantityDrafts).some((value) => {
      const quantity = Number(value)
      return !value || !Number.isFinite(quantity) || quantity <= 0 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.000001
    })
    if (!quantitiesValid) { setMessage('Fix the invalid quantity before submitting this order.'); return }
    const lines = cartRef.current.map(({ product, quantity }) => ({ product, quantity }))
    for (const line of lines) {
      const available = availableStock(line.product)
      if (line.quantity > available) { setMessage(`Insufficient available stock for ${line.product.name}. Available: ${available}.`); return }
      if (!Number.isFinite(line.product.price) || line.product.price < 0) { setMessage(`${line.product.name} has an invalid selling price.`); return }
    }
    const items = lines.map(({ product, quantity }) => ({ productId: product.id, quantity }))
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const reference = `PO-${createdAt.slice(0, 10).replaceAll('-', '')}-${id.slice(0, 8).toUpperCase()}`
    const orderItems = lines.map(({ product, quantity }) => {
      const unitPriceMinor = Math.round(product.price * 100)
      return { productId: product.id, name: product.name, sku: product.sku || product.model, barcode: product.barcode ?? '', quantity, unitPriceMinor, lineTotalMinor: Math.round(unitPriceMinor * quantity) }
    })
    const totalMinor = orderItems.reduce((sum, line) => sum + line.lineTotalMinor, 0)
    if (!Number.isSafeInteger(totalMinor) || orderItems.some((line) => !Number.isSafeInteger(line.lineTotalMinor))) { setMessage('Order total is outside the supported amount.'); return }
    const localOrder: PendingOrder = { id, reference, status: 'Pending', customerName: customerName.trim(), customerPhone: customerPhone.trim(), createdAt, items: orderItems, subtotalMinor: totalMinor, totalMinor, history: [{ at: createdAt, actor: 'You (this device)', event: 'Order submitted' }], localPending: true }
    const payload = { operationId: id, customerName: localOrder.customerName, customerPhone: localOrder.customerPhone, items }
    supplyLock.current = true; setSupplyLoading(true); setMessage('Saving supply order…')
    const saveLocally = async () => {
      const queued = await listQueuedOperations()
      const dependencies = queued.filter((item) => {
        if (item.status === 'synchronized' || !/^(product\.|store\.receipt\.|transfer\.|pending-order\.|sale\.)/.test(item.type)) return false
        const affected = new Set<number>()
        if (item.type.startsWith('product.') && typeof item.recordId === 'number') affected.add(item.recordId)
        if (typeof item.payload.productId === 'number') affected.add(item.payload.productId)
        for (const key of ['items', 'lines']) {
          const rows = item.payload[key]
          if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === 'object' && 'productId' in row && typeof row.productId === 'number') affected.add(row.productId)
        }
        return orderItems.some((line) => affected.has(line.productId))
      }).map((item) => item.id)
      const stockUpdates = await savePendingOrderAndOperation(localOrder, { id, type: 'pending-order.create', label: `Supply ${reference}`, target: '/api/pending-orders', method: 'POST', payload, ...(dependencies.length ? { dependsOn: dependencies } : {}), recordCollection: 'pendingOrders', recordId: id }, 'reserve', lowStockThreshold)
      onLocalSale(stockUpdates as Product[])
      return localOrder
    }
    try {
      let saved = localOrder
      let queued = false
      const earlierInventoryOps = await listQueuedOperations()
      const hasEarlierInventory = earlierInventoryOps.some((item) => item.status !== 'synchronized' && /^(product\.|store\.receipt\.|transfer\.|pending-order\.|sale\.)/.test(item.type) && (() => {
        const ids = new Set<number>()
        if (item.type.startsWith('product.') && typeof item.recordId === 'number') ids.add(item.recordId)
        if (typeof item.payload.productId === 'number') ids.add(item.payload.productId)
        for (const key of ['items', 'lines']) { const rows = item.payload[key]; if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === 'object' && 'productId' in row && typeof row.productId === 'number') ids.add(row.productId) }
        return items.some((line) => ids.has(line.productId))
      })())
      if (!hasEarlierInventory && shouldAttemptServerRequest()) {
        let response: Response | null = null
        try { response = await fetch('/api/pending-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
        catch (error) { if (!(error instanceof TypeError)) throw error }
        const result = response ? await response.json().catch(() => null) : null
        if (response?.ok && result?.order) {
          saved = result.order as PendingOrder
          try {
            await writeLocalRecord('pendingOrders', id, saved, false)
            if (Array.isArray(result.inventory)) {
              for (const product of result.inventory) if (product && typeof product.id === 'number') await writeLocalRecord('products', product.id, product, false)
              onLocalSale(result.inventory as Product[])
            }
          } catch (cacheError) { console.warn('Supply order was saved by the server, but its local cache could not be refreshed:', cacheError) }
        } else if (response) throw new Error(typeof result?.message === 'string' ? result.message : `Supply order failed (${response.status})`)
        else { saved = await saveLocally(); queued = true }
      } else { saved = await saveLocally(); queued = true }
      onOrderCreated(saved)
      window.dispatchEvent(new Event('micomerc-queue-changed'))
      updateCart(() => []); setQuantityDrafts({}); setCashTendered(''); setCustomerName(''); setCustomerPhone('')
      setMessage(queued ? `${reference} saved on this device and is waiting for Sync Now.` : `${reference} saved to Pending Orders.`)
    } catch (cause) {
      console.error('Could not save pending order:', cause)
      setMessage(cause instanceof Error ? cause.message : 'Supply order could not be saved')
    } finally { supplyLock.current = false; setSupplyLoading(false) }
  }

  const openReceipt = (sale: Sale) => {
    setPrintError('')
    printTokenRef.current += 1
    setPrintRequest({ sale, token: printTokenRef.current })
  }

  const printSale = async (sale: Sale) => {
    if (printLock.current) return
    printLock.current = true
    setPrinting(true)
    setPrintError('')
    setPrintStatus(`Sale ${sale.receiptNumber} saved. Sending receipt to the Bluetooth printer…`)
    const requestId = crypto.randomUUID()
    let lastError: unknown
    try {
      const base = 'http://127.0.0.1:17891'
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const grantResponse = await fetch(`${base}/authorize`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            signal: AbortSignal.timeout(5000),
          })
          const grant = await grantResponse.json().catch(() => null)
          if (!grantResponse.ok || typeof grant?.authorization !== 'string') {
            throw new Error(typeof grant?.error === 'string' ? grant.error : 'Local printer authorization failed')
          }
          const response = await fetch(`${base}/print-receipt`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.authorization}`, 'Idempotency-Key': requestId },
            body: JSON.stringify(sale), signal: AbortSignal.timeout(15000),
          })
          const result = await response.json().catch(() => null)
          if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Printer rejected the receipt')
          setPrintStatus(`Receipt ${sale.receiptNumber} sent to ${typeof result.printer === 'string' ? result.printer : 'the Bluetooth printer'}.`)
          return
        } catch (error) {
          lastError = error
          if (attempt < 3) {
            setPrintStatus(`Printer connection interrupted. Reconnecting and retrying (${attempt}/2)…`)
            await new Promise((resolve) => window.setTimeout(resolve, 1500))
          }
        }
      }
      throw lastError
    } catch (error) {
      console.error('Bluetooth receipt print failed:', error)
      setPrintStatus(`Sale ${sale.receiptNumber} is saved. The Bluetooth receipt was not confirmed.`)
      const reason = error instanceof TypeError
        ? 'Could not reach the local printer bridge. Start the MicroMec printer service and allow this site to access your local network in the browser if prompted.'
        : error instanceof Error ? error.message : 'Bluetooth printing failed.'
      setPrintError(`${reason} Retry the receipt or use the browser/PDF fallback.`)
    } finally {
      printLock.current = false
      setPrinting(false)
    }
  }

  useEffect(() => { onRegisterPrint(printSale) }, [onRegisterPrint, printSale])

  const effectiveTenderMinor = cashTendered.trim() === '' ? subtotalMinor : Math.round((Number(cashTendered) || 0) * 100)
  const roundedTenderMinor = effectiveTenderMinor
  const invalidQuantityDraft = Object.values(quantityDrafts).some((value) => {
    const quantity = Number(value)
    return !value || !Number.isFinite(quantity) || quantity <= 0 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.000001
  })
  const unavailableCartLine = cart.some(({ product, quantity }) => availableStock(product) < quantity || availableStock(product) <= 0 ||
    (typeof product.status === 'string' && product.status.trim().toLowerCase() === 'discontinued'))
  const checkoutDisabled = checkoutLoading || (!pending && (productsLoading || !!productsError || invalidQuantityDraft || unavailableCartLine || !cart.length || roundedTenderMinor < subtotalMinor))
  const supplyDisabled = supplyLoading || checkoutLoading || pending || productsLoading || !!productsError || invalidQuantityDraft || unavailableCartLine || cart.length === 0

  return <>
    <button type="button" className="pos-floating-button" onClick={onOpen} aria-label="Open point of sale cart">
      <ShoppingCart aria-hidden="true" />
      <span>Cart</span>
      {itemCount > 0 && <b className="pos-floating-count">{itemCount > 99 ? '99+' : itemCount}</b>}
    </button>

    {active && <section className="pos-page" aria-labelledby="pos-title">
      <div className="pos-header">
        <div>
          <div className="eyebrow">Sales workspace</div>
          <h2 id="pos-title">Point of Sale / Cart</h2>
          <p>Scan a product or search inventory to add it to this cart.</p>
        </div>
        <button className="secondary-button pos-clear" type="button" onClick={() => { updateCart(() => []); setQuantityDrafts({}); setMessage('Cart cleared.') }} disabled={!cart.length || cartLocked}>
          <Trash2 /> Clear cart
        </button>
      </div>

      <div className="pos-layout">
        <div className="pos-left-column">
          <section className="panel pos-tools">
            <div className="pos-scanner-status"><span className={scannerReady ? 'pos-ready-dot is-ready' : 'pos-ready-dot'} />{productsLoading ? 'Loading inventory…' : productsError ? 'Inventory unavailable' : scannerReady ? 'Scanner ready — scan a barcode now' : 'Scanner paused while another field is active'}
              <button className="pos-focus-scanner" type="button" onClick={() => scanInputRef.current?.focus()} disabled={productsLoading || !!productsError || cartLocked}><Barcode /> Focus scanner</button>
            </div>
            <label className="pos-label" htmlFor="pos-barcode">USB barcode scanner input</label>
            <div className="pos-input-wrap pos-barcode-wrap">
              <Barcode aria-hidden="true" />
              <input ref={scanInputRef} id="pos-barcode" autoFocus={active && !productsLoading && !productsError && !cartLocked} autoComplete="off" value={barcode} disabled={cartLocked || productsLoading || !!productsError}
                onFocus={() => setScannerReady(true)} onBlur={() => setScannerReady(false)}
                onChange={(event) => setBarcode(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); processBarcode() } }}
                placeholder={productsLoading ? 'Loading inventory…' : 'Ready for scanner input…'} />
              <button className="primary-button" type="button" onClick={processBarcode} disabled={cartLocked || productsLoading || !!productsError}>Add</button>
            </div>
            <label className="pos-label pos-search-label" htmlFor="pos-search">Find a product</label>
            <div className="pos-input-wrap">
              <Search aria-hidden="true" />
              <input id="pos-search" autoComplete="off" value={query} disabled={cartLocked}
                onFocus={() => setScannerReady(false)} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, SKU, or barcode" />
              {query && <button className="pos-icon-action" type="button" onClick={() => setQuery('')} aria-label="Clear product search" disabled={cartLocked}><X /></button>}
            </div>
            {query && <div className="pos-search-results" role="listbox" aria-label="Matching inventory products">
              {filteredProducts.length ? filteredProducts.map((product) => <button type="button" role="option" aria-selected="false" key={product.id} onClick={() => { addProduct(product); setQuery('') }} disabled={cartLocked}>
                <span><b>{product.name}</b><small>{product.sku || product.model} · {availableStock(product)} available</small></span><strong>{money(product.price, currency)}</strong>
              </button>) : <p>No matching inventory item. Create it in Stocks before selling.</p>}
            </div>}
            {productsLoading && <p className="pos-message" role="status">Loading current inventory before enabling scans…</p>}
            {productsError && <p className="pos-error" role="alert">{productsError}</p>}
            {message && <p className="pos-message" role="status">{message}</p>}
          </section>

          {lastSale && <section className="pos-sale-complete" aria-label="Completed sale receipt">
            <div className="pos-sale-copy"><span className="pos-success-icon"><Check /></span><div><b>Sale saved</b><small>{lastSale.receiptNumber} · {formatSaleDate(lastSale.createdAt)}</small></div></div>
            <div className="pos-print-actions"><button type="button" className="primary-button" onClick={() => void printSale(lastSale)} disabled={printing}><Printer /> {printing ? 'Printing…' : 'Print receipt'}</button><button type="button" className="secondary-button" onClick={() => openReceipt(lastSale)}><FileDown /> Save / system print</button></div>
          </section>}
          {(printStatus || printError) && <div className={`pos-print-feedback${printError ? ' has-error' : ''}`} role={printError ? 'alert' : 'status'}><span className="pos-print-feedback-icon"><Printer /></span><div><b>{printError ? 'Printer needs attention' : 'Receipt status'}</b><span>{printError || printStatus}</span></div></div>}

          <section className="panel pos-cart-panel" aria-label="Cart items">
            <div className="pos-panel-heading"><div><h3>Cart items</h3><span>{itemCount} item{itemCount === 1 ? '' : 's'}</span></div></div>
            {cart.length === 0 ? <div className="pos-empty"><ShoppingCart /><b>Your cart is empty</b><span>Scan or search for an inventory product to get started.</span></div> : <>
              <div className="pos-table-wrap"><table className="pos-table">
                <thead><tr><th>Product</th><th>Unit price</th><th>Quantity</th><th>Line total</th><th><span className="pos-visually-hidden">Actions</span></th></tr></thead>
                <tbody>{cart.map(({ product, quantity }) => <tr key={product.id}>
                  <td><b>{product.name}</b><small>{product.sku || product.model}{product.barcode ? ` · ${product.barcode}` : ''}</small></td>
                  <td>{money(product.price, currency)}</td>
                  <td><div className="pos-quantity"><button type="button" aria-label={`Decrease ${product.name} quantity`} disabled={cartLocked} onClick={() => { setQuantityDrafts((drafts) => { const next = { ...drafts }; delete next[product.id]; return next }); quantity <= 1 ? updateCart((lines) => lines.filter((line) => line.product.id !== product.id)) : updateCart((lines) => lines.map((line) => line.product.id === product.id ? { ...line, quantity: line.quantity - 1 } : line)) }}><Minus /></button>
                    <input aria-label={`${product.name} quantity`} type="number" min="0.001" step="0.001" value={quantityDrafts[product.id] ?? quantity} disabled={cartLocked} onChange={(event) => changeQuantity(product.id, event.target.value)} onBlur={() => commitQuantity(product.id)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
                    <button type="button" aria-label={`Increase ${product.name} quantity`} disabled={cartLocked || quantity + 1 > availableStock(product)} onClick={() => { setQuantityDrafts((drafts) => { const next = { ...drafts }; delete next[product.id]; return next }); updateCart((lines) => lines.map((line) => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line)) }}><Plus /></button></div></td>
                  <td><b>{moneyMinor(Math.round(Math.round(product.price * 100) * quantity), currency)}</b></td>
                  <td><button className="pos-icon-action pos-remove" type="button" disabled={cartLocked} onClick={() => updateCart((lines) => lines.filter((line) => line.product.id !== product.id))} aria-label={`Remove ${product.name}`}><Trash2 /></button></td>
                </tr>)}</tbody>
              </table></div>
            </>}
          </section>
        </div>
        <aside className="pos-right-column">
          <section className="panel pos-side-summary">
            <div className="pos-panel-heading"><div><h3>Checkout</h3><span>Cash payment</span></div></div>
            <div className="pos-side-total"><span>Subtotal</span><b>{moneyMinor(subtotalMinor, currency)}</b></div>
            <div className="pos-side-total"><span>Tax</span><b>{moneyMinor(0, currency)}</b></div>
            <div className="pos-side-total"><span>Discount</span><b>{moneyMinor(0, currency)}</b></div>
            <div className="pos-side-grand"><span>Amount due</span><strong>{moneyMinor(subtotalMinor, currency)}</strong></div>
            <label className="pos-cash-label" htmlFor="pos-cash-tendered">Cash received</label>
            <div className="pos-cash-input"><span>{currency}</span><input id="pos-cash-tendered" type="number" min="0" step="0.01" value={cashTendered} disabled={cartLocked} onChange={(event) => setCashTendered(event.target.value)} placeholder="0.00" /></div>
            <div className="pos-change-row"><span>Change</span><b>{moneyMinor(Math.max(0, roundedTenderMinor - subtotalMinor), currency)}</b></div>
            <p>Receipts print automatically to the connected Bluetooth ESC/POS printer after checkout. You can reprint any saved receipt below.</p>
            <div className="pos-supply-customer"><label>Customer name *<input ref={customerNameInput} value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={160} disabled={cartLocked || supplyLoading} placeholder="Customer or business" required /></label><label>Phone number *<input ref={customerPhoneInput} value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} maxLength={40} disabled={cartLocked || supplyLoading} placeholder="Phone number" required /></label></div>
            <button type="button" className="primary-button pos-checkout-button" onClick={submitCheckout} disabled={checkoutDisabled}>
              {checkoutLoading ? 'Processing…' : pending ? 'Retry payment & print' : 'Payment & print'}
            </button>
            <button type="button" className="primary-button pos-checkout-button pos-supply-button" onClick={() => void submitSupply()} disabled={supplyDisabled}><Clock3 /> {supplyLoading ? 'Saving order…' : 'Supply'}</button>
            {pending && !checkoutLoading && <small className="pos-pending-note">The previous request could not be confirmed. Retry it before changing the cart.</small>}
          </section>

          <section className="panel pos-todays-sales" aria-labelledby="todays-sales-title">
            <div className="pos-panel-heading"><div><h3 id="todays-sales-title">Today’s Sales</h3><span>Summary for the selected date range</span></div></div>
            <SalesRangeControls preset={salesPreset} setPreset={setSalesPreset} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
            <div className="pos-sales-metrics"><div><span>Completed sales</span><b>{periodSummary.saleCount.toLocaleString()}</b></div><div><span>Sales value</span><b>{moneyMinor(periodSummary.totalMinor, currency)}</b></div><div><span>Units sold</span><b>{periodSummary.unitsSold.toLocaleString(undefined, { maximumFractionDigits: 3 })}</b></div></div>
            {periodLoading && <p className="pos-history-footnote" role="status">Updating sales summary…</p>}
            {periodError && <p className="pos-error pos-history-footnote" role="alert">{periodError}</p>}
          </section>

          <section className="panel pos-recent-sales">
            <div className="pos-panel-heading pos-receipts-heading"><div><h3>Recent receipts</h3><span>All saved sales · newest first</span></div><label className="pos-recent-search"><Search size={14} /><input value={recentQuery} onChange={(event) => setRecentQuery(event.target.value)} placeholder="Receipt no." aria-label="Search receipts by receipt number" /><span className="pos-visually-hidden">Search receipts by receipt number</span></label></div>
            <div className="pos-receipts-scroll" aria-live="polite">
              {recentLoading && recentSales.length === 0 && <p className="pos-history-empty">Loading receipts…</p>}
              {recentError && <p className="pos-error pos-history-empty" role="alert">{recentError}</p>}
              {visibleReceipts.map((sale) => <SaleHistoryRow key={sale.id} sale={sale} currency={currency} printing={printing} onReprint={() => void printSale(sale)} onOpen={() => openReceipt(sale)} />)}
              {archiveLoading && <p className="pos-history-empty" role="status">Loading receipts…</p>}
              {archiveError && <p className="pos-error pos-history-empty" role="alert">{archiveError}</p>}
              {!recentLoading && !archiveLoading && visibleReceipts.length === 0 && <p className="pos-history-empty">{normalizedReceiptQuery ? 'No receipts match that number.' : 'Completed receipts will appear here.'}</p>}
              {archiveHasMore && archiveSearch === recentQuery && <div className="pos-history-load-more"><button type="button" className="secondary-button" onClick={() => void loadArchivePage(archiveCursor)} disabled={archiveLoading}>{archiveLoading ? 'Loading…' : 'Load older receipts'}</button></div>}
            </div>
          </section>
        </aside>
      </div>

      {printRequest && <div className="receipt-print">
        <header><h1><span>Micomerc</span></h1><p className="receipt-document-title">SALES RECEIPT</p></header>
        <div className="receipt-meta"><span>Receipt: {printRequest.sale.receiptNumber}</span><span>{formatSaleDate(printRequest.sale.createdAt)}</span>{printRequest.sale.customerName && <span>Customer: {printRequest.sale.customerName}{printRequest.sale.customerPhone ? ` · ${printRequest.sale.customerPhone}` : ''}</span>}{printRequest.sale.pendingOrderReference && <span>Order: {printRequest.sale.pendingOrderReference}</span>}{printRequest.sale.localPending && <strong>Pending synchronization</strong>}</div>
        <table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>
          {printRequest.sale.items.map((item) => <tr key={item.productId}><td>{item.name}<small>{item.sku}{item.barcode ? ` · ${item.barcode}` : ''}</small></td><td>{item.quantity}</td><td>{moneyMinor(item.unitPriceMinor, printRequest.sale.currency)}</td><td>{moneyMinor(item.lineTotalMinor, printRequest.sale.currency)}</td></tr>)}
        </tbody></table>
        <div className="receipt-total"><span>Subtotal</span><b>{moneyMinor(printRequest.sale.subtotalMinor, printRequest.sale.currency)}</b></div>
        {printRequest.sale.discountMinor > 0 && <div className="receipt-total"><span>Discount</span><b>−{moneyMinor(printRequest.sale.discountMinor, printRequest.sale.currency)}</b></div>}
        {printRequest.sale.taxMinor > 0 && <div className="receipt-total"><span>Tax</span><b>{moneyMinor(printRequest.sale.taxMinor, printRequest.sale.currency)}</b></div>}
        <div className="receipt-total receipt-final-total"><span>Total</span><b>{moneyMinor(printRequest.sale.totalMinor, printRequest.sale.currency)}</b></div>
        <div className="receipt-payment"><span><b>Payment method:</b> Cash · Paid</span><span><b>Amount received:</b> {moneyMinor(printRequest.sale.payment.amountTenderedMinor, printRequest.sale.currency)}</span><span><b>Change:</b> {moneyMinor(printRequest.sale.payment.changeMinor, printRequest.sale.currency)}</span></div>
        <p className="receipt-thanks">Thank you for your purchase.</p>
      </div>}
    </section>}
  </>
}

function SalesRangeControls({ preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo }: {
  preset: SalesPreset
  setPreset: (value: SalesPreset) => void
  customFrom: string
  setCustomFrom: (value: string) => void
  customTo: string
  setCustomTo: (value: string) => void
}) {
  return <div className="pos-sales-filters"><label><CalendarDays size={14} /><span className="pos-visually-hidden">Sales date range</span><select aria-label="Sales date range" value={preset} onChange={(event) => setPreset(event.target.value as SalesPreset)}><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="this-week">This week</option><option value="last-week">Last week</option><option value="this-month">This month</option><option value="last-month">Last month</option><option value="custom">Custom range</option></select></label>{preset === 'custom' && <><label><span className="pos-visually-hidden">Start date</span><input aria-label="Custom start date" type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label><span className="pos-visually-hidden">End date</span><input aria-label="Custom end date" type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label></>}{preset !== 'today' && <button type="button" className="pos-reset-date" onClick={() => { setCustomFrom(''); setCustomTo(''); setPreset('today') }}>Today</button>}</div>
}

function SaleHistoryRow({ sale, currency, printing, onReprint, onOpen }: { sale: Sale; currency: string; printing: boolean; onReprint: () => void; onOpen: () => void }) {
  const itemSummary = sale.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')
  return <article className="pos-history-row pos-sale-history-row"><div><b>{sale.receiptNumber}</b><small>{sale.localPending ? 'Pending synchronization · ' : ''}{formatSaleDate(sale.createdAt)} · {sale.items.length} item line{sale.items.length === 1 ? '' : 's'}{itemSummary ? ` · ${itemSummary}` : ''}</small><strong>{moneyMinor(sale.totalMinor, sale.currency || currency)}</strong><em>{sale.payment.method} · {sale.payment.status}</em></div><button className="pos-icon-action" type="button" onClick={onReprint} disabled={printing} aria-label={`Reprint saved receipt ${sale.receiptNumber} on Bluetooth printer`}><Printer /></button><button className="pos-icon-action" type="button" onClick={onOpen} aria-label={`Open saved receipt ${sale.receiptNumber} for browser printing`}><FileDown /></button></article>
}
