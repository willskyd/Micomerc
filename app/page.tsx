'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  MoreHorizontal,
  Package,
  Printer,
  Plus,
  Search,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Store,
  Sun,
  Moon,
  UserRound,
  Users,
  WalletCards,
  X,
} from 'lucide-react'

import { Sidebar } from '../components/dashboard/Sidebar'
import { Topbar } from '../components/dashboard/Topbar'
import MobileNav from '../components/dashboard/MobileNav'
import Inbox, { persistRead } from '../components/dashboard/Inbox'
import { LoginScreen } from '../components/dashboard/LoginScreen'
import { OverviewSection } from '../components/dashboard/sections/OverviewSection'
import { StoreSection } from '../components/dashboard/sections/StoreSection'
import { TransfersSection } from '../components/dashboard/sections/TransfersSection'
import { useStoreTransfersPrototype } from '../components/dashboard/useStoreTransfersPrototype'
import { PosCart } from '../components/dashboard/PosCart'
import { ReturnsSection } from '../components/dashboard/sections/ReturnsSection'
import { PendingOrdersSection } from '../components/dashboard/sections/PendingOrdersSection'
import { SyncCenter } from '../components/dashboard/sections/SyncCenter'
import { SearchableProductSelect } from '../components/dashboard/SearchableProductSelect'
import type { Activity, Debt, PendingOrder, Product, Payment, Receipt, Sale, Section } from '../components/dashboard/types'
import { money, now, Stat, daysAgo } from '../components/dashboard/utils'
import { normalizeWorkspaceName } from '../lib/branding'
import { cacheServerCollection, reconcileServerCollection, deleteLocalRecord, listQueuedOperations, readLocalCollection, saveLocalDeletionAndOperation, saveLocalRecordAndOperation, shouldAttemptServerRequest, shouldQueueAfterServerFailure, writeLocalRecord } from '../lib/offline-queue'

function isProductList(value: unknown): value is Product[] {
  return Array.isArray(value) && value.every((item: unknown) =>
    typeof item === 'object' && item !== null &&
    'id' in item && typeof item.id === 'number' &&
    'name' in item && typeof item.name === 'string' &&
    'model' in item && typeof item.model === 'string' &&
    'sku' in item && typeof item.sku === 'string' &&
    (!('barcode' in item) || typeof item.barcode === 'string') &&
    'category' in item && typeof item.category === 'string' &&
    'stock' in item && typeof item.stock === 'number' &&
    'price' in item && typeof item.price === 'number' &&
    'status' in item && typeof item.status === 'string',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentifiedRecordList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((row) =>
    isRecord(row) && (typeof row.id === 'string' || typeof row.id === 'number'),
  )
}

export default function Page() {
  const [section, setSection] = useState<Section>('Overview')
  const [products, setProducts] = useState<Product[]>([])
  const prototypeData = useStoreTransfersPrototype((updates) => setProducts((current) => current.map((product) => updates.find((updated) => updated.id === product.id) ?? product)))
  const [productsLoading, setProductsLoading] = useState(true)
  const [productsError, setProductsError] = useState('')
  const [connectionState, setConnectionState] = useState<'checking' | 'online' | 'offline'>('checking')
  const [dashboardErrors, setDashboardErrors] = useState<string[]>([])
  const [debts, setDebts] = useState<Debt[]>([])
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([])
  const [overviewSalesMinor, setOverviewSalesMinor] = useState<number | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [deleteProduct, setDeleteProduct] = useState<Product | null>(null)
  const [deleteReceipt, setDeleteReceipt] = useState<Receipt | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [dark, setDark] = useState(false)
  const [settings, setSettings] = useState({ workspace: 'Micomerc', currency: 'NGN', notifications: 'All activity', lowStockThreshold: '30', dateFormat: 'MMM D, YYYY' })
  const settingsRevision = useRef(0)
  const [sidebar, setSidebar] = useState(() => (typeof window !== 'undefined' ? window.innerWidth > 768 : true))
  const [modal, setModal] = useState<'product' | 'debt' | 'receipt' | 'detail' | 'login' | null>(null)
  const [selectedDebt, setSelectedDebt] = useState<Debt | null>(null)
  const [toast, setToast] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [notifications, setNotifications] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)
  const [activities, setActivities] = useState<Activity[]>([])
  const [selectedInbox, setSelectedInbox] = useState<Activity | null>(null)
  const pendingPrinter = useRef<((sale: Sale) => Promise<void>) | null>(null)
  const pendingCount = pendingOrders.filter((order) => order.status === 'Pending').length

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async (response) => {
        const result: unknown = await response.json().catch(() => null)
        if (!response.ok || typeof result !== 'object' || result === null || !('authenticated' in result) || typeof result.authenticated !== 'boolean') {
          throw new Error('Admin session could not be verified')
        }
        if (!cancelled) setSignedIn(result.authenticated)
      })
      .catch((error: unknown) => {
        console.error('Could not verify admin session:', error)
        if (!cancelled) setSignedIn(false)
      })
      .finally(() => { if (!cancelled) setAuthChecking(false) })
    return () => { cancelled = true }
  }, [])

  const refreshProducts = async () => {
  const response = await fetch('/api/products', { cache: 'no-store' })
  const result: unknown = await response.json().catch(() => null)

  if (!response.ok || !isProductList(result)) {
    throw new Error('Inventory could not be refreshed. Reload before another stock operation.')
  }

  const records = result
  await reconcileServerCollection(
    'products',
    records as Array<Product & Record<string, unknown>>,
  )

  const merged = await readLocalCollection<Product>('products')

  setProducts(merged)
  setProductsError('')

  return merged
}

 useEffect(() => {
  if (authChecking || !signedIn) return
  let cancelled = false

  async function hydrateLocalData() {
    try {
      const [cachedProducts, cachedDebts, cachedReceipts, cachedActivities, cachedSettings, cachedPendingOrders] = await Promise.all([
        readLocalCollection<Product>('products'),
        readLocalCollection<Debt>('debts'),
        readLocalCollection<Receipt>('receipts'),
        readLocalCollection<Activity>('activities'),
        readLocalCollection<{ id: string; settings: typeof settings; revision?: number }>('settings'),
        readLocalCollection<PendingOrder>('pendingOrders'),
      ])
      if (cancelled) return
      setProducts(cachedProducts); setDebts(cachedDebts); setReceipts(cachedReceipts); setActivities(cachedActivities)
      setPendingOrders(cachedPendingOrders)
      if (cachedSettings[0]?.settings) { settingsRevision.current = cachedSettings[0].revision ?? 0; setSettings((current) => ({ ...current, ...cachedSettings[0].settings, workspace: normalizeWorkspaceName(cachedSettings[0].settings.workspace) })) }
      if (!navigator.onLine && cachedActivities.length) setSelectedInbox(cachedActivities[0])
    } catch (error) {
      console.error('Could not hydrate local dashboard data:', error)
      if (!cancelled) setDashboardErrors((items) => [...items, 'Local cache is unavailable; changes cannot be stored offline in this browser.'])
    } finally {
      if (!cancelled) setProductsLoading(false)
    }
  }

  async function loadOtherDashboardData() {
    if (!navigator.onLine) { setConnectionState('offline'); return }
    setConnectionState('online')
    const errors: string[] = []
    const loadCollection = async <T extends Record<string, unknown>>(path: string, collection: string, apply: (rows: T[]) => void, validate: (value: unknown) => value is T[]) => {
      try {
        const response = await fetch(path, { cache: 'no-store' })
        if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
        const body: unknown = await response.json()
        if (!validate(body) || !isIdentifiedRecordList(body)) throw new Error(`${path} returned invalid data`)
        const records = body
        await reconcileServerCollection(collection, records)

        const merged = await readLocalCollection<T>(collection)
        if (!cancelled) apply(merged)
      } catch (error) {
        console.warn(`Dashboard refresh failed for ${collection}; keeping the local cache`, error)
        try {
          const cached = await readLocalCollection<T>(collection)
          if (!cancelled) apply(cached)
        } catch (cacheError) {
          console.error(`Could not read the local ${collection} cache:`, cacheError)
        }
        errors.push(collection)
      }
    }
    await Promise.all([
      loadCollection('/api/products', 'products', (rows) => { setProducts(rows); setProductsError('') }, isProductList as (value: unknown) => value is Array<Product & Record<string, unknown>>),
      loadCollection('/api/debts', 'debts', setDebts, Array.isArray),
      loadCollection('/api/receipts', 'receipts', setReceipts, Array.isArray),
      loadCollection('/api/activities', 'activities', (rows) => { setActivities(rows); if (rows.length) setSelectedInbox((current) => current ?? rows[0]) }, Array.isArray),
      loadCollection('/api/pending-orders', 'pendingOrders', setPendingOrders, Array.isArray),
      (async () => {
        try {
          const response = await fetch('/api/settings', { cache: 'no-store' })
          if (!response.ok) throw new Error(`Settings returned HTTP ${response.status}`)
          const value = await response.json()
          if (!value || typeof value !== 'object') throw new Error('Settings response is invalid')
          settingsRevision.current = typeof value.revision === 'number' ? value.revision : 0
          const { revision, ...settingsValue } = value
          await cacheServerCollection('settings', [{ id: 'workspace', settings: settingsValue, revision: settingsRevision.current }])
          const mergedSettings = await readLocalCollection<{ id: string; settings: typeof settings; revision?: number }>('settings')
          if (mergedSettings[0]?.revision !== undefined) settingsRevision.current = mergedSettings[0].revision
          const nextSettings = mergedSettings[0]?.settings ?? settingsValue
          if (!cancelled) setSettings((current) => ({ ...current, ...nextSettings, workspace: normalizeWorkspaceName(nextSettings.workspace) }))
        } catch (error) { console.warn('Settings refresh failed; retaining local settings', error); errors.push('settings') }
      })(),
    ])
    if (!cancelled) {
      setDashboardErrors(errors.length ? [`Some server data could not refresh (${errors.join(', ')}); cached records remain available.`] : [])
      if (errors.includes('products') && products.length === 0) setProductsError('Inventory is not cached and the server could not be reached.')
    }
  }

  const onOnline = () => { void loadOtherDashboardData() }
  const onOffline = () => setConnectionState('offline')
  const onLocalChange = () => {
    void Promise.all([readLocalCollection<Product>('products'), readLocalCollection<Debt>('debts'), readLocalCollection<Receipt>('receipts'), readLocalCollection<Activity>('activities'), readLocalCollection<{ id: string; settings: typeof settings; revision?: number }>('settings'), readLocalCollection<PendingOrder>('pendingOrders')]).then(([localProducts, localDebts, localReceipts, localActivities, localSettings, localPendingOrders]) => {
      if (cancelled) return
    setProducts(localProducts); setDebts(localDebts); setReceipts(localReceipts); setActivities(localActivities)
      setPendingOrders(localPendingOrders)
      if (localSettings[0]?.settings) { settingsRevision.current = localSettings[0].revision ?? settingsRevision.current; setSettings((current) => ({ ...current, ...localSettings[0].settings, workspace: normalizeWorkspaceName(localSettings[0].settings.workspace) })) }
    }).catch((error) => console.error('Could not refresh local dashboard records:', error))
  }
  window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline)
  window.addEventListener('micomerc-queue-changed', onLocalChange)
  void hydrateLocalData().then(() => { if (!cancelled) return loadOtherDashboardData() })
  return () => { cancelled = true; window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); window.removeEventListener('micomerc-queue-changed', onLocalChange) }
}, [authChecking, signedIn])

useEffect(() => {
  if (authChecking || !signedIn || section !== 'Overview') return
  let cancelled = false
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  void readLocalCollection<Sale>('sales').then((sales) => {
    const localTotal = sales.filter((sale) => { const date = new Date(sale.createdAt); return date >= from && date < to }).reduce((sum, sale) => sum + sale.totalMinor, 0)
    if (!cancelled) setOverviewSalesMinor(localTotal)
  }).catch((error) => console.warn('Could not read cached sales for Overview:', error))
  const params = new URLSearchParams({ paged: '1', limit: '1', from: from.toISOString(), to: to.toISOString() })
  if (!navigator.onLine) return () => { cancelled = true }
  fetch(`/api/sales?${params.toString()}`, { cache: 'no-store' })
    .then(async (response) => {
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok || typeof result !== 'object' || result === null || !('summary' in result) || typeof result.summary !== 'object' || result.summary === null || !('totalMinor' in result.summary) || typeof result.summary.totalMinor !== 'number' || !Number.isSafeInteger(result.summary.totalMinor)) {
        throw new Error('Today’s sales total is unavailable')
      }
      if (!cancelled) setOverviewSalesMinor(result.summary.totalMinor)
    })
    .catch((error: unknown) => {
      console.error('Failed to load today’s sales total:', error)
      if (!cancelled) setOverviewSalesMinor(null)
    })
  return () => { cancelled = true }
}, [authChecking, signedIn, section])

const notify = async (
  text: string,
  detail?: string,
  important = false,
  extra: Partial<Activity> = {}
) => {
  if (settings.notifications === 'Disabled') {
    return
  }

  if (
    settings.notifications === 'Important only' &&
    !important
  ) {
    return
  }

  setToast(text)

  const operationId = crypto.randomUUID()
  const activity: Activity = {
    id: Number.parseInt(operationId.replaceAll('-', '').slice(0, 12), 16),
    text, detail, time: now(), read: false, ...extra,
  }
  try {
    const queueActivity = async () => {
      await saveLocalRecordAndOperation('activities', activity.id, activity, {
        id: operationId, type: 'activity.create', label: text, target: '/api/activities', method: 'POST',
        payload: { operationId, ...activity }, recordCollection: 'activities', recordId: activity.id,
      })
      setActivities((items) => [activity, ...items.filter((item) => item.id !== activity.id)])
      window.dispatchEvent(new Event('micomerc-queue-changed'))
    }
    let response: Response | null = null
    if (shouldAttemptServerRequest()) {
      try { response = await fetch('/api/activities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId, ...activity }) }) }
      catch (error) {
        if (!(error instanceof TypeError)) throw error
        await queueActivity()
        return
      }
    }
    if (!response) { await queueActivity(); return }
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(typeof result?.message === 'string' ? result.message : `Activity save failed (${response.status})`)
    const saved = result && typeof result === 'object' ? result as Activity : activity
    await writeLocalRecord('activities', saved.id, saved, false)
    setActivities((items) => [saved, ...items.filter((item) => item.id !== saved.id)])
  } catch (error) {
    console.error('Could not save activity locally:', error)
    setToast(error instanceof Error ? `Activity was not saved: ${error.message}` : 'Activity was not saved')
  }

  window.setTimeout(() => setToast(''), 2600)
}



  const outstanding = debts
    .filter((d) => !d.paidAt)
    .reduce((sum, d) => sum + Math.max(0, d.amount - d.payments.reduce((a, p) => a + p.amount, 0)), 0)

  const filteredProducts = useMemo(
    () => products.filter(
      (p) => `${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(query.toLowerCase()) && (statusFilter === 'All' || p.status === statusFilter),
    ),
    [products, query, statusFilter],
  )

  const visibleDebts = useMemo(
    () => debts
      .filter((d) => (section === 'Paid' ? !!d.paidAt : !d.paidAt))
      .filter((d) => `${d.customer} ${d.invoice} ${d.receiptNumber ?? ''}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => {
        const byCreatedAt = (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
        return byCreatedAt || String(b.id).localeCompare(String(a.id), undefined, { numeric: true })
      }),
    [debts, query, section],
  )

  const closeOverlays = () => {
    setModal(null)
    setSelectedDebt(null)
    setDeleteProduct(null)
    setDeleteReceipt(null)
    setNotifications(false)
    setMenuOpen(false)

    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      setSidebar(false)
    }
  }

  const go = (s: Section) => {
    closeOverlays()
    setSection(s)
    setQuery('')
    setStatusFilter('All')
  }

  const openInbox = () => {
    closeOverlays()
    setSection('Inbox')
    if (!selectedInbox && activities[0]) setSelectedInbox(activities[0])
  }

  const viewNotification = async (activity: Activity) => {
  setActivities((items) =>
    items.map((item) =>
      item.id === activity.id
        ? { ...item, read: true }
        : item
    )
  )

  setSelectedInbox({ ...activity, read: true })
  closeOverlays()
  setSection('Inbox')

  try {
    await persistRead(activity)
  } catch (error) {
    console.error('Failed to mark notification as read:', error)
  }
}
  const signOut = async () => {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string'
          ? result.message
          : 'Sign out failed')
      }
      setSignedIn(false)
      setMenuOpen(false)
      setToast('Signed out successfully')
    } catch (error) {
      console.error('Could not sign out:', error)
      setToast(error instanceof Error ? error.message : 'Sign out failed')
    }
  }

  // Keep the sidebar visible on large screens and only allow mobile open/close toggling.
  useEffect(() => {
    function update() {
      setSidebar(window.innerWidth > 768)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  if (authChecking) return null
  if (!signedIn) return <LoginScreen onSignIn={async (identifier, password) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    })
    const result: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string'
        ? result.message
        : 'Sign-in failed')
    }
    setSignedIn(true)
    setToast('Welcome back')
  }} />


   const updateProduct = async (current: Product, updates: Partial<Product>) => {
  if (typeof updates.stock === 'number' && updates.stock < Number(current.reservedStock ?? 0)) throw new Error('Stock cannot be reduced below quantities reserved for pending orders.')
  const operationId = crypto.randomUUID()
  const payload = { ...updates, operationId, expectedRevision: current.revision ?? 0 }
  const earlier = (await listQueuedOperations()).filter((operation) => operation.type.startsWith('product.') && operation.recordId === current.id && operation.status !== 'synchronized').at(-1)
  const saveLocally = async () => {
    const updated: Product = { ...current, ...updates, revision: (current.revision ?? 0) + 1 }
    await saveLocalRecordAndOperation('products', current.id, updated, {
      id: operationId, type: 'product.update', label: `Update product ${current.name}`, target: `/api/products/${current.id}`, method: 'PATCH', payload,
      ...(earlier ? { dependsOn: earlier.id } : {}), recordCollection: 'products', recordId: current.id,
    })
    setProducts((items) => items.map((product) => product.id === current.id ? updated : product))
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    return { product: updated, queued: true }
  }
  if (earlier || !shouldAttemptServerRequest()) return saveLocally()
  let response: Response
  try {
    response = await fetch(`/api/products/${current.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return saveLocally()
  }
  if (!response.ok) {
    if (await shouldQueueAfterServerFailure(response)) return saveLocally()
    const result = await response.json().catch(() => null)
    throw new Error(typeof result?.message === 'string' ? result.message : 'Failed to update product')
  }
  const updated = await response.json() as Product
  return { product: updated, queued: false }
}

const refreshPosProducts = async (): Promise<Product[]> => {
  const response = await fetch('/api/products')
  if (!response.ok) throw new Error('Could not refresh inventory after checkout validation')
  const result: unknown = await response.json()
  if (!isProductList(result)) throw new Error('Inventory returned invalid product data')
  const records = result
  await cacheServerCollection('products', records as Array<Product & Record<string, unknown>>)
  setProducts(records)
  setProductsError('')
  return records
}

const deleteProductOnServer = async (id: number, operationId: string) => {
  const response = await fetch(`/api/products/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId }),
  })

  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new Error(typeof result?.message === 'string' ? result.message : `Failed to delete product (${response.status})`)
  }

  return response.json()
}

const formatCurrency = (amount: number) => {
  const currencySymbols: Record<string, string> = {
    NGN: '₦',
    USD: '$',
    EUR: '€',
    GBP: '£',
  }

  const symbol = currencySymbols[settings.currency] || '₦'

  return `${symbol}${amount.toLocaleString()}`
}

  const addProduct = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault()

  const f = new FormData(e.currentTarget)
  const stock = Number(f.get('stock'))
  const model = String(f.get('model') || '').trim()
  const barcode = String(f.get('barcode') || '').trim()

  const name = String(f.get('name') || '').trim()
  const sku = model || `NEW-${String(Date.now()).slice(-4)}`
  const category = String(f.get('category') || '').trim()
  const price = Number(f.get('price'))
  if (!name || !category || !Number.isFinite(stock) || stock < 0 || !Number.isFinite(price) || price < 0 || barcode.length > 128 || /[\u0000-\u001f\u007f]/.test(barcode)) {
    setToast('Enter a product name, category, valid stock and price, and a valid barcode')
    return
  }
  if (barcode && products.some((product) => (product.barcode ?? '').trim().toLowerCase() === barcode.toLowerCase())) {
    setToast('That barcode is already assigned to another product')
    return
  }
  const operationId = crypto.randomUUID()
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  const newProduct: Product = {
    id,
    name,
    model: model || `ITEM-${String(Date.now()).slice(-5).toUpperCase()}`,
    sku,
    barcode,
    category,
    stock,
    price,
    status: stock === 0
      ? 'Out of stock'
      : stock <= Math.max(0, Number(settings.lowStockThreshold) || 0)
        ? 'Low stock'
        : 'In stock',
    revision: 1,
  }

  const payload = { ...newProduct, operationId }
  const saveLocally = async () => {
    await saveLocalRecordAndOperation('products', id, newProduct, {
      id: operationId, type: 'product.create', label: `Add product ${name}`, target: '/api/products', method: 'POST', payload,
      recordCollection: 'products', recordId: id,
    })
    setProducts((current) => [newProduct, ...current.filter((item) => item.id !== id)])
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    return newProduct
  }

  try {
    let savedProduct: Product = newProduct
    let queued = false
    let response: Response | null = null
    if (shouldAttemptServerRequest()) {
      try { response = await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
      catch (error) {
        if (!(error instanceof TypeError)) throw error
        savedProduct = await saveLocally(); queued = true
      }
    } else {
      savedProduct = await saveLocally(); queued = true
    }
    if (!queued && response && !response.ok) {
      if (await shouldQueueAfterServerFailure(response)) {
        savedProduct = await saveLocally()
        queued = true
      } else {
        const result = await response.json().catch(() => null)
        throw new Error(typeof result?.message === 'string' ? result.message : `Failed to add product (${response.status})`)
      }
    }
    if (!queued && response) {
      savedProduct = await response.json() as Product
      await writeLocalRecord('products', id, savedProduct, false)
      setProducts((current) => [savedProduct, ...current.filter((item) => item.id !== id)])
    }
    setModal(null)

    notify(
  `Product added to stock: ${savedProduct.name}`,
      `New product added. Model: ${savedProduct.model}. SKU: ${savedProduct.sku}. Category: ${savedProduct.category}. Stock: ${savedProduct.stock} units. Price: ${money(savedProduct.price, settings.currency)}.${queued ? ' Saved locally and awaiting manual synchronization.' : ''}`,
  true,
  {
    type: 'product',
    product: savedProduct.name,
    quantity: savedProduct.stock,
    currency: settings.currency,
  }
    )
    if (queued) setToast('Product saved on this device · waiting for Sync Now')
  } 
  
  catch (error) {
    console.error(error)
    setToast(error instanceof Error ? error.message : 'Failed to add product')
  }
}




  const addDebt = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const customer = String(form.get('customer') || '').trim()
    const item = String(form.get('item') || '').trim()
    const receiptNumber = String(form.get('receiptNumber') || '').trim()
    const amount = Number(form.get('amount'))
    const idempotencyKey = String(form.get('idempotencyKey') || '') || crypto.randomUUID()

    if (!customer || !item || !Number.isFinite(amount) || amount <= 0) {
      setToast('Enter a customer, items bought, and a valid amount')
      return
    }

    try {
      const createdAt = new Date().toISOString()
      const invoice = `DEBT-${Date.now().toString(36).toUpperCase()}-${idempotencyKey.slice(0, 6).toUpperCase()}`
      const payload = { idempotencyKey, customer, item, receiptNumber, amount, invoice, due: '30 days', createdAt }
      const localDebt: Debt = { id: `offline-${idempotencyKey}`, customer, invoice, ...(receiptNumber ? { receiptNumber } : {}), items: [{ name: item, price: amount }], amount: Number(amount.toFixed(2)), payments: [], due: '30 days', createdAt }
      const queueDebt = async () => {
        await saveLocalRecordAndOperation('debts', localDebt.id, localDebt, {
          id: idempotencyKey, type: 'debt.create', label: `Create debt ${invoice}`, target: '/api/debts', method: 'POST', payload,
          recordCollection: 'debts', recordId: localDebt.id,
        })
      }
      let savedDebt = localDebt
      let queued = false
    let response: Response | null = null
    if (shouldAttemptServerRequest()) {
      try { response = await fetch('/api/debts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
      catch (error) {
        if (!(error instanceof TypeError)) throw error
        await queueDebt(); queued = true
      }
    } else {
      await queueDebt(); queued = true
    }
    if (!queued && response) {
      if (!response.ok) {
        if (await shouldQueueAfterServerFailure(response)) {
          await queueDebt()
          queued = true
        } else {
          const result = await response.json().catch(() => null)
          throw new Error(typeof result?.message === 'string' ? result.message : `Debt save failed (${response.status})`)
        }
      } else {
        const result = await response.json().catch(() => null)
        savedDebt = result as Debt
        await writeLocalRecord('debts', savedDebt.id, savedDebt, false)
      }
      }
      setDebts((current) => [savedDebt, ...current.filter((debt) => debt.id !== savedDebt.id)])
      setModal(null)
      if (queued) window.dispatchEvent(new Event('micomerc-queue-changed'))
      notify(
        queued ? `Debt saved locally for ${savedDebt.customer}` : `Debt saved for ${savedDebt.customer}`,
        `Invoice: ${savedDebt.invoice}. ${savedDebt.receiptNumber ? `Receipt RN: ${savedDebt.receiptNumber}. ` : ''}Total: ${money(savedDebt.amount, settings.currency)}.${queued ? ' Pending manual synchronization.' : ''}`,
        true,
        { type: 'debt', amount: savedDebt.amount, currency: settings.currency, customer: savedDebt.customer, invoice: savedDebt.invoice, remaining: savedDebt.amount },
      )
      setToast(queued ? 'Debt saved on this device · waiting for Sync Now' : 'Debt saved to MongoDB')
    } catch (error) {
      console.error('Failed to save debt:', error)
      setToast(error instanceof Error ? error.message : 'Debt could not be saved')
    }
  }

 const addReceipt = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault()

  const f = new FormData(e.currentTarget)

  const newReceipt = {
    name: String(f.get('name') || '').trim(),
    model: String(f.get('model') || '').trim(),
    quantity: Number(f.get('quantity')) || 0,
    invoice: String(f.get('invoice') || '').trim(),
    date: now(),
  }
  if (!newReceipt.name || !newReceipt.model || !newReceipt.invoice || !Number.isFinite(newReceipt.quantity) || newReceipt.quantity < 0) {
    setToast('Enter a product name, model, invoice, and valid non-negative quantity')
    return
  }
  const operationId = crypto.randomUUID()
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  const localReceipt: Receipt = { ...newReceipt, id, revision: 1 }
  const payload = { ...localReceipt, operationId }
  const saveLocally = async () => {
    const prior = (await listQueuedOperations()).filter((operation) => operation.type === 'receipt.create' && operation.status !== 'synchronized').at(-1)
    await saveLocalRecordAndOperation('receipts', id, localReceipt, {
      id: operationId, type: 'receipt.create', label: `Record stock receipt ${newReceipt.invoice}`, target: '/api/receipts', method: 'POST', payload,
      ...(prior ? { dependsOn: prior.id } : {}), recordCollection: 'receipts', recordId: id,
    })
    setReceipts((current) => [localReceipt, ...current.filter((item) => item.id !== id)])
    window.dispatchEvent(new Event('micomerc-queue-changed'))
    return localReceipt
  }

  const deleteReceiptOnServer = async (id: number) => {
  const response = await fetch(`/api/receipts/${id}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error('Failed to delete stock')
  }

  return response.json()
}

  try {
    let savedReceipt: Receipt = localReceipt
    let queued = false
  let response: Response | null = null
  if (shouldAttemptServerRequest()) {
    try { response = await fetch('/api/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
    catch (error) {
      if (!(error instanceof TypeError)) throw error
      savedReceipt = await saveLocally(); queued = true
    }
  } else {
    savedReceipt = await saveLocally(); queued = true
  }
  if (!queued && response && !response.ok) {
    if (await shouldQueueAfterServerFailure(response)) {
      savedReceipt = await saveLocally()
      queued = true
    } else {
      const result = await response.json().catch(() => null)
      throw new Error(typeof result?.message === 'string' ? result.message : `Failed to record stock receipt (${response.status})`)
    }
  }
  if (!queued && response) {
    savedReceipt = await response.json() as Receipt
    await writeLocalRecord('receipts', id, savedReceipt, false)
    setReceipts((current) => [savedReceipt, ...current.filter((item) => item.id !== id)])
    }

    setModal(null)

    notify(
  `New stock recorded: ${savedReceipt.name} (${savedReceipt.quantity} units)`,
  `Incoming stock recorded. Model: ${savedReceipt.model}. Invoice: ${savedReceipt.invoice}. Quantity: ${savedReceipt.quantity} units. Received: ${savedReceipt.date}.${queued ? ' Saved locally and awaiting manual synchronization.' : ''}`,
  true,
  {
    type: 'stock',
    product: savedReceipt.name,
    quantity: savedReceipt.quantity,
  }
)
    if (queued) setToast('Stock receipt saved on this device · waiting for Sync Now')
  } catch (error) {
    console.error('Failed to record stock receipt:', error)
    setToast(error instanceof Error ? error.message : 'Failed to record stock receipt')
  }
}

  const sectionHeading = section

  return (
    <div className={dark ? 'app-shell dark' : 'app-shell'}>
      <Sidebar section={section} sidebar={sidebar} settings={settings} pendingCount={pendingCount} onGo={go} onClose={() => setSidebar(false)} onSignOut={signOut} />

      <main className="main-content">
        <Topbar
          section={section}
          dark={dark}
          notifications={notifications}
          menuOpen={menuOpen}
          activities={activities}
          pendingCount={pendingCount}
          onToggleTheme={() => setDark(!dark)}
          onToggleNotifications={() => {
            setNotifications((open) => !open)
            setMenuOpen(false)
          }}
          onOpenInbox={openInbox}
          onOpenSection={go}
          onToggleMenu={() => {
            setMenuOpen((open) => !open)
            setNotifications(false)
          }}
          onSignOut={signOut}
          onViewNotification={viewNotification}
        />

        <div className="page-wrap">
          {connectionState === 'offline' && <div className="offline-banner" role="status">Offline mode · showing this device’s saved business data. Changes remain local until you confirm Sync Now.</div>}
          {dashboardErrors.map((message) => <div className="dashboard-data-warning" role="status" key={message}>{message}</div>)}
          {section !== 'POS' && <div className="page-heading">
            <div>
              <div className="eyebrow">{section === 'Overview' ? 'Micomerc workspace' : 'Workspace'}</div>
              <h1>{sectionHeading}</h1>
              <p>
                {section === 'Overview' ? 'A clear view of your market, stock, and customer accounts.' : section === 'Debt' ? 'Stay on top of outstanding customer balances.' : section === 'Paid' ? 'A record of completed customer payments.' : section === 'Pending' ? 'Review supplied orders and confirm payment or release reservations.' : section === 'Returns' ? 'Review customer returns, inspection decisions, and refunds.' : section === 'Sync Center' ? 'Review local operations and synchronize only after confirmation.' : section === 'Settings' ? 'Manage workspace preferences and access.' : section === 'Team members' ? 'People with access to this workspace.' : section === 'New Stocks' ? 'Review incoming inventory and recent receipts.' : section === 'Store' ? 'Receive, check, and record deliveries at your main store.' : section === 'Transfers' ? 'Record goods dispatched from the main store to a branch.' : 'Keep an eye on your products and stock levels.'}
              </p>
            </div>
            {!['Overview', 'Paid', 'Settings', 'Team members', 'Inbox', 'Store', 'Transfers', 'Pending', 'Returns', 'Sync Center'].includes(section) && (
              <button className="primary-button" onClick={() => setModal(section === 'Debt' ? 'debt' : section === 'New Stocks' ? 'receipt' : 'product')}>
                <Plus />
                {section === 'Debt' ? 'Add debt' : section === 'New Stocks' ? 'Record stock' : 'Add product'}
              </button>
            )}
          </div>}

             {section === 'Overview' && (
              <OverviewSection outstanding={outstanding} salesMinor={overviewSalesMinor} currency={settings.currency} productCount={products.length} receiptCount={receipts.length} onGo={go} />
              )}
              
          {section === 'Pending' && <PendingOrdersSection
            orders={pendingOrders}
            setOrders={setPendingOrders}
            setProducts={setProducts}
            currency={settings.currency}
            workspace={settings.workspace}
            onPrint={async (sale) => { if (pendingPrinter.current) await pendingPrinter.current(sale); else setToast('Receipt printer is not ready yet') }}
            onActivity={(text, detail) => { void notify(text, detail, true, { type: 'system' }) }}
          />}

          {section === 'Returns' && <ReturnsSection currency={settings.currency} />}
          {section === 'Sync Center' && <SyncCenter currency={settings.currency} />}

          <PosCart active={section === 'POS'} products={products} productsLoading={productsLoading} productsError={productsError} currency={settings.currency} workspace={settings.workspace} lowStockThreshold={Math.max(0, Number(settings.lowStockThreshold) || 0)} onLocalSale={(stockUpdates) => setProducts(stockUpdates)} onRefreshProducts={refreshPosProducts} onOpen={() => go('POS')} onOrderCreated={(order) => { setPendingOrders((current) => [order, ...current.filter((item) => item.id !== order.id)]); void notify('New pending order', `${order.reference} · ${order.customerName || 'Walk-in customer'} · ${money(order.totalMinor / 100, settings.currency)}`, true, { type: 'system' }) }} onRegisterPrint={(print) => { pendingPrinter.current = print }} />

          {section === 'Stocks' && (
            <>
              <div className="stat-grid">
                <Stat icon={<Package />} label="Total products" value={products.length.toLocaleString()} />
             <Stat
               icon={<TrendingUpIcon />}
               label="Total stock value"
               value={money(
               products.reduce((a, p) => a + p.stock * p.price, 0),
               settings.currency
                )}
                />               
          <Stat icon={<CircleAlert />} label="Low stock items" value={products.filter((p) => p.status === 'Low stock').length.toString()} change="Needs attention" />
                <Stat icon={<WalletCards />} label="Out of stock" value={products.filter((p) => p.stock === 0).length.toString()} />
              </div>
              <section className="panel mb-20 ">
                <Toolbar query={query} setQuery={setQuery} statusFilter={statusFilter} setStatusFilter={setStatusFilter} options={['All', 'In stock', 'Low stock', 'Out of stock']} />
                <ProductTable
                  products={filteredProducts}
                  onNotify={notify}

                  lowStockThreshold={Math.max(0, Number(settings.lowStockThreshold) || 0)}
                  onSaveEdit={async (id, updates) => {
                    const currentProduct = products.find((p) => p.id === id)

                    if (!currentProduct) {
                      throw new Error('Product not found')
                    }

                    const stock = Math.max(
                      0,
                      Number(updates.stock ?? currentProduct.stock) || 0
                    )
                    const price = Math.max(
                      0,
                      Number(updates.price ?? currentProduct.price) || 0
                    )
                    const threshold = Math.max(
                      0,
                      Number(settings.lowStockThreshold) || 0
                    )

                    const status =
                      updates.status === 'Discontinued' ||
                      (updates.status !== 'Automatic' && currentProduct.status === 'Discontinued')
                        ? 'Discontinued'
                        : stock === 0
                          ? 'Out of stock'
                          : stock <= threshold
                            ? 'Low stock'
                            : 'In stock'

                    try {
                      const updateResult = await updateProduct(currentProduct, {
                        ...updates,
                        stock,
                        price,
                        status,
                      })
                      const updatedProduct = updateResult.product

                      setProducts((items) =>
                        items.map((p) => p.id === id ? updatedProduct : p)
                      )
                      if (!updateResult.queued) await writeLocalRecord('products', id, updatedProduct, false)

                      if (stock !== currentProduct.stock) {
                        notify(
                          `${updatedProduct.name} stock updated`,
                          `Stock changed from ${currentProduct.stock} to ${stock} units. Status: ${status}.`,
                          true,
                          {
                            type: 'stock',
                            product: updatedProduct.name,
                            quantity: stock,
                          }
                        )
                      }

                      if (price !== currentProduct.price) {
                        notify(
                          `${updatedProduct.name} price updated`,
                          `Price changed from ${money(currentProduct.price, settings.currency)} to ${money(price, settings.currency)}.`,
                          true,
                          {
                            type: 'product',
                            product: updatedProduct.name,
                            currency: settings.currency,
                          }
                        )
                      }

                      setToast(updateResult.queued ? 'Stock changes saved on this device · waiting for Sync Now' : 'Stock changes saved')
                    } catch (error) {
                      console.error('Failed to save stock changes:', error)
                      setToast(error instanceof Error ? error.message : 'Failed to save stock changes')
                      throw error
                    }
                  }}
                  onDelete={(id) => setDeleteProduct(products.find((p) => p.id === id) ?? null)}
                />
              </section>
            </>
          )}

          {section === 'New Stocks' && (
  <section className="panel mb-20">
    <Toolbar
      query={query}
      setQuery={setQuery}
      statusFilter={statusFilter}
      setStatusFilter={setStatusFilter}
      options={['All', 'Completed']}
    />

   <Receipts
  receipts={receipts}
  query={query}
  statusFilter={statusFilter}
  onEdit={async (id, updates) => {
    try {
      const current = receipts.find((item) => item.id === id)
      if (!current) throw new Error('Stock receipt was not found')
      const operationId = crypto.randomUUID()
      const payload = { ...updates, operationId, expectedRevision: current.revision ?? 0 }
      const prior = (await listQueuedOperations()).filter((operation) => operation.type.startsWith('receipt.') && operation.recordId === id && operation.status !== 'synchronized').at(-1)
      const updatedLocal: Receipt = { ...current, ...updates, revision: (current.revision ?? 0) + 1 }
      const saveLocally = async () => {
        await saveLocalRecordAndOperation('receipts', id, updatedLocal, {
          id: operationId, type: 'receipt.update', label: `Update stock receipt ${current.invoice}`, target: `/api/receipts/${id}`, method: 'PATCH', payload,
          ...(prior ? { dependsOn: prior.id } : {}), recordCollection: 'receipts', recordId: id,
        })
        window.dispatchEvent(new Event('micomerc-queue-changed'))
        return updatedLocal
      }
      let updatedReceipt: Receipt
      let queued = false
      if (prior || !shouldAttemptServerRequest()) { updatedReceipt = await saveLocally(); queued = true }
      else {
        let response: Response | null = null
        try { response = await fetch(`/api/receipts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
        catch (error) {
          if (!(error instanceof TypeError)) throw error
          updatedReceipt = await saveLocally(); queued = true
        }
        if (!queued && response && !response.ok) {
          if (await shouldQueueAfterServerFailure(response)) {
            updatedReceipt = await saveLocally()
            queued = true
          } else {
            const result = await response.json().catch(() => null)
            throw new Error(typeof result?.message === 'string' ? result.message : `Failed to update stock (${response.status})`)
          }
        }
        if (!queued && response) {
          updatedReceipt = await response.json() as Receipt
          await writeLocalRecord('receipts', id, updatedReceipt, false)
        }
      }
      setReceipts((items) =>
        items.map((item) =>
          item.id === updatedReceipt.id
            ? updatedReceipt
            : item
        )
      )
      setToast(queued ? 'Stock receipt updated locally · waiting for Sync Now' : 'Stock receipt updated')
    } catch (error) {
      console.error('Failed to update stock:', error)
      setToast('Failed to update stock')
      throw error
    }
  }}
  onDelete={(id) => {
    const stock = receipts.find((r) => r.id === id)

    if (stock) {
      setDeleteReceipt(stock)
    }
  }}
/>
  </section>
)}

          {section === 'Store' && <StoreSection
            products={products}
            productsLoading={productsLoading}
            productsError={productsError}
            persistenceError={prototypeData.persistenceError}
            records={prototypeData.receivingRecords}
            onCreate={async (record) => { const saved = await prototypeData.addReceivingRecord(record); if (shouldAttemptServerRequest()) try { await refreshProducts() } catch (error) { setToast(error instanceof Error ? error.message : 'Inventory refresh failed') } return saved }}
            onUpdate={async (id, record, revision) => { const saved = await prototypeData.updateReceivingRecord(id, record, revision); if (shouldAttemptServerRequest()) try { await refreshProducts() } catch (error) { setToast(error instanceof Error ? error.message : 'Inventory refresh failed') } return saved }}
          />}

          {section === 'Transfers' && <TransfersSection
            products={products}
            productsLoading={productsLoading}
            productsError={productsError}
            persistenceError={prototypeData.persistenceError}
            branches={prototypeData.branches}
            transfers={prototypeData.transfers}
            onCreate={async (transfer) => { const saved = await prototypeData.addTransfer(transfer); if (shouldAttemptServerRequest()) try { await refreshProducts() } catch (error) { setToast(error instanceof Error ? error.message : 'Inventory refresh failed') } return saved }}
            onUpdate={async (id, transfer, revision) => { const saved = await prototypeData.updateTransfer(id, transfer, revision); if (shouldAttemptServerRequest()) try { await refreshProducts() } catch (error) { setToast(error instanceof Error ? error.message : 'Inventory refresh failed') } return saved }}
            onAddBranch={prototypeData.addBranch}
            onRenameBranch={prototypeData.renameBranch}
          />}

          {(section === 'Debt' || section === 'Paid') && (
            <>
              <div className="debt-total">
                <div>
                  <span>{section === 'Paid' ? 'Total paid history' : 'Total Outstanding Debt'}</span>
                  <strong>
                    {section === 'Paid'
                      ? money(
                     debts
                     .filter((d) => d.paidAt)
                     .reduce((a, d) => a + d.amount, 0),
                     settings.currency
                     )
                    : money(outstanding, settings.currency)}
                  {/* {section === 'Paid'
                    ? money(
                    debts
                     .filter((d) => d.paidAt)
                     .reduce((a, d) => a + d.amount, 0) + pendingOrders.filter((order) => order.status === 'Accepted').reduce((sum, order) => sum + order.totalMinor / 100, 0),
                  settings.currency
                     )
                  : money(outstanding, settings.currency)} */}
                  </strong>               
             </div>
                <CircleDollarSign />
              </div>
              <section className="panel mb-20">
                <Toolbar query={query} setQuery={setQuery} statusFilter={statusFilter} setStatusFilter={setStatusFilter} options={['All']} />
                <DebtTable debts={visibleDebts} paid={section === 'Paid'} onOpen={(d) => { setSelectedDebt(d); setModal('detail')  }} currency={settings.currency} />
              </section>
              {/* {section === 'Paid' && <section className="panel paid-orders-panel"><div className="panel-heading"><div><h2>Accepted supply orders</h2><p>Completed sales created from Pending Orders.</p></div></div>
              {pendingOrders.filter((order) => order.status === 'Accepted').length ? <div className="table-wrap"><table><thead><tr><th>Receipt</th><th>Customer</th><th>Items</th><th>Total paid</th><th>Date</th><th /></tr></thead><tbody>
              {pendingOrders.filter((order) => order.status === 'Accepted').map((order) => <tr key={order.id}><td><b>{order.sale?.receiptNumber ?? order.reference}</b></td><td>
              {order.customerName || 'Walk-in customer'}<small>{order.customerPhone}</small></td><td>{order.items.length}</td><td>{money(order.totalMinor / 100, settings.currency)}</td><td>
              {new Date(order.sale?.createdAt ?? order.createdAt).toLocaleString()}</td><td>{order.sale && <button className="secondary-button" onClick={() => { if (pendingPrinter.current) void pendingPrinter.current(order.sale!); else setToast('Receipt printer is not ready yet') }}><Printer /> Print receipt</button>}
              </td></tr>)}</tbody></table></div> : <div className="empty"><CircleDollarSign /><b>No accepted supply orders</b><span>Accepted orders will appear here as paid sales.</span></div>}</section>}
               */}
            </>
          )}

          {section === 'Inbox' && (
            <Inbox
              activities={activities}
              selectedInbox={selectedInbox}
              setSelectedInbox={(a) => setSelectedInbox(a)}
              setActivities={setActivities}
            />
          )}

   {section === 'Settings' && (
  <SettingsPage
    settings={settings}
    setSettings={setSettings}
    onSave={async () => {
      const operationId = crypto.randomUUID()
      const expectedRevision = settingsRevision.current
      const payload = { ...settings, operationId, expectedRevision }
      const queuedSettings = (await listQueuedOperations()).filter((operation) => operation.type === 'settings.update' && operation.status !== 'synchronized')
      const queueSettings = async () => {
        const localValue = { id: 'workspace', settings, revision: expectedRevision + 1 }
        await saveLocalRecordAndOperation('settings', 'workspace', localValue, {
          id: operationId, type: 'settings.update', label: 'Update workspace settings', target: '/api/settings', method: 'PATCH',
          payload, ...(queuedSettings.length ? { dependsOn: queuedSettings.map((operation) => operation.id) } : {}), recordCollection: 'settings', recordId: 'workspace',
        })
        settingsRevision.current = expectedRevision + 1
        window.dispatchEvent(new Event('micomerc-queue-changed'))
        setToast('Settings saved on this device · waiting for Sync Now')
      }
      try {
        if (queuedSettings.length || !shouldAttemptServerRequest()) return await queueSettings()
      let response: Response
      try { response = await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
        catch (error) { if (!(error instanceof TypeError)) throw error; return await queueSettings() }
        if (!response.ok) {
          const result = await response.json().catch(() => null)
          throw new Error(typeof result?.message === 'string' ? result.message : `Settings update failed (${response.status})`)
        }
        const savedSettings = await response.json()
        settingsRevision.current = typeof savedSettings.revision === 'number' ? savedSettings.revision : expectedRevision + 1
        const { revision, ...settingsValue } = savedSettings
        setSettings((current) => ({ ...current, ...settingsValue, workspace: normalizeWorkspaceName(settingsValue.workspace) }))
        await cacheServerCollection('settings', [{ id: 'workspace', settings: settingsValue, revision: settingsRevision.current }])
        notify('Workspace settings saved')
      } catch (error) {
        console.error('Failed to save settings:', error)
        setToast(error instanceof Error ? error.message : 'Failed to save settings')
      }
    }}
  />
)}          
      
      {/* {section === 'Team members' && <TeamPage />} */}
        </div>

        <MobileNav section={section} go={go} />

        {modal && modal !== 'detail' && (
          <RecordModal
           type={modal}
           onClose={() => setModal(null)}
           onSubmit={
              modal === 'product'
              ? addProduct
              : modal === 'debt'
               ? addDebt
          : addReceipt
           }
          />
        )}

        {modal === 'detail' && selectedDebt && (
          <DebtDetail
            debt={selectedDebt}
            readOnly={section === 'Paid'}
            onClose={() => { setModal(null); setSelectedDebt(null) }}
            onSave={async (draft, fullyPaid) => {
              const operationId = crypto.randomUUID()
              const updatedDebt = {
                ...draft,
                paidAt: fullyPaid ? now() : draft.paidAt,
              }
              const savedDebt: Debt = { ...updatedDebt, revision: (selectedDebt?.revision ?? 0) + 1 }
              const payload = { ...updatedDebt, operationId, expectedRevision: selectedDebt?.revision ?? 0 }
              const priorOperations = (await listQueuedOperations()).filter((operation) => operation.recordId === savedDebt.id && operation.type.startsWith('debt.') && operation.status !== 'synchronized')
              const queueDebtUpdate = async () => saveLocalRecordAndOperation('debts', savedDebt.id, savedDebt, {
                id: operationId, type: 'debt.payment', label: `Update debt ${savedDebt.invoice}`, target: `/api/debts/${encodeURIComponent(String(savedDebt.id))}`, method: 'PATCH', payload,
                ...(priorOperations.length ? { dependsOn: priorOperations.map((operation) => operation.id) } : {}), recordCollection: 'debts', recordId: savedDebt.id,
              })
              let confirmedDebt = savedDebt
              let queued = false
              if (priorOperations.length || !shouldAttemptServerRequest()) { await queueDebtUpdate(); queued = true }
              else {
                let response: Response
                try { response = await fetch(`/api/debts/${encodeURIComponent(String(savedDebt.id))}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
                catch (error) {
                  if (!(error instanceof TypeError)) throw error
                  await queueDebtUpdate(); queued = true
                  response = null as unknown as Response
                }
                if (!queued) {
                  if (!response.ok) {
                    if (await shouldQueueAfterServerFailure(response)) {
                      await queueDebtUpdate()
                      queued = true
                    } else {
                      const result = await response.json().catch(() => null)
                      throw new Error(typeof result?.message === 'string' ? result.message : `Debt update failed (${response.status})`)
                    }
                  } else {
                    const result = await response.json().catch(() => null)
                    confirmedDebt = result as Debt
                    await writeLocalRecord('debts', confirmedDebt.id, confirmedDebt, false)
                  }
                }
              }
              const previousPaidAmount = (selectedDebt.payments ?? []).reduce((total, payment) => total + Number(payment.amount), 0)
              const newPaidAmount = (confirmedDebt.payments ?? []).reduce((total, payment) => total + Number(payment.amount), 0)
              const lastPaymentAmount = Number((confirmedDebt.payments ?? []).slice(-1)[0]?.amount ?? Math.max(0, newPaidAmount - previousPaidAmount) ?? 0)
              const remaining = Math.max(0, confirmedDebt.amount - newPaidAmount)
              setDebts((items) => items.map((item) => item.id === confirmedDebt.id ? confirmedDebt : item))
              if (queued) window.dispatchEvent(new Event('micomerc-queue-changed'))
              setModal(null)
              setSelectedDebt(null)
              notify(
                queued ? (remaining === 0 ? `Debt for ${confirmedDebt.customer} marked fully paid locally` : `Payment saved locally for ${confirmedDebt.customer}`) : (remaining === 0 ? `Debt for ${confirmedDebt.customer} marked fully paid` : `Payment saved for ${confirmedDebt.customer}`),
                remaining === 0 ? `Debt fully paid. Total paid: ${money(newPaidAmount, settings.currency)}${queued ? '. Waiting for Sync Now.' : '.'}` : `Payment of ${money(lastPaymentAmount, settings.currency)} received from ${confirmedDebt.customer}. Remaining balance: ${money(remaining, settings.currency)}${queued ? '. Waiting for Sync Now.' : '.'}`,
                true,
                { type: 'payment', amount: lastPaymentAmount, currency: settings.currency, customer: savedDebt.customer, invoice: savedDebt.invoice, remaining },
              )
              return confirmedDebt
            }}
          />
        )}

        {deleteProduct && (
          <div className="confirm-backdrop" role="presentation">
            <section className="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="delete-stock-title">
              <div className="confirm-icon"><CircleAlert /></div>
              <div>
                <span className="eyebrow">Stock management</span>
                <h2 id="delete-stock-title">Delete this stock?</h2>
                <p>Are you sure you want to remove <b>{deleteProduct.name}</b> from your inventory? This action cannot be undone.</p>
              </div>
              <div className="confirm-actions">
                <button className="secondary-button" onClick={() => setDeleteProduct(null)}>Cancel</button>
                <button className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700" 
                onClick={async () => {
                  if (deleteProduct) {
                    const target = deleteProduct
                    try {
                    const operationId = crypto.randomUUID()
                    const payload = { id: target.id, operationId }
                    const queuedOperations = await listQueuedOperations()
                    const dependencies = queuedOperations.filter((operation) => {
                      if (operation.status === 'synchronized') return false
                      if (operation.recordId === target.id && operation.type.startsWith('product.')) return true
                      if (operation.payload.productId === target.id) return true
                      return ['items', 'lines'].some((key) => {
                        const items = operation.payload[key]
                        return Array.isArray(items) && items.some((item) => item && typeof item === 'object' && 'productId' in item && item.productId === target.id)
                      })
                    }).map((operation) => operation.id)
                    const queueDelete = async () => {
                      await saveLocalDeletionAndOperation('products', target.id, {
                        id: operationId, type: 'product.delete', label: `Delete product ${target.name}`, target: `/api/products/${target.id}`, method: 'DELETE', payload,
                        ...(dependencies.length ? { dependsOn: dependencies } : {}), recordCollection: 'products', recordId: target.id,
                      })
                      setProducts((items) => items.filter((product) => product.id !== target.id))
                      window.dispatchEvent(new Event('micomerc-queue-changed'))
                    }
                let queued = false
                if (dependencies.length || !shouldAttemptServerRequest()) { await queueDelete(); queued = true }
                else {
                  try { await deleteProductOnServer(target.id, operationId) }
                  catch (error) {
                    if (!(error instanceof TypeError)) throw error
                    await queueDelete(); queued = true
                  }
                  if (!queued) {
                    await deleteLocalRecord('products', target.id)
                    setProducts((items) => items.filter((product) => product.id !== target.id))
                  }
                }
               notify(
                `Product deleted: ${target.name}`,
                `Product was removed from inventory. Model: ${target.model}. SKU: ${target.sku}. Category: ${target.category}. Last recorded stock: ${target.stock} units.${queued ? ' Saved locally and awaiting manual synchronization.' : ''}`,
                true,
                   {
                type: 'product',
            product: target.name,
            quantity: target.stock,
  }
)
              if (queued) setToast('Product deletion saved on this device · waiting for Sync Now')
              setDeleteProduct(null)
               } catch (error) {
               console.error(error)
             setToast(error instanceof Error ? error.message : 'Failed to delete product')
             }
            }
                   }}>Delete stock</button>
              </div>
            </section>
          </div>
        )}

        {deleteReceipt && (
  <div
    className="modal-backdrop"
    onMouseDown={(e) => {
      if (e.currentTarget === e.target) {
        setDeleteReceipt(null)
      }
    }}
  >
    <div className="modal">
      <div className="modal-header">
        <div>
          <div className="eyebrow">Delete stock</div>

          <h2>Delete stock?</h2>

          <p className="mt-2 text-sm text-slate-500">
            Are you sure you want to delete{' '}
            <strong>{deleteReceipt.name}</strong>?
            This action cannot be undone.
          </p>
        </div>

        <button
          className="icon-button"
          onClick={() => setDeleteReceipt(null)}
        >
          <X />
        </button>
      </div>

      <div className="modal-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => setDeleteReceipt(null)}
        >
          Cancel
        </button>

       <button
  type="button"
  className="primary-button"
  onClick={async () => {
    if (!deleteReceipt) return

    try {
      const receiptId = deleteReceipt.id
      const operationId = crypto.randomUUID()
      const payload = { id: receiptId, operationId }
      const earlier = (await listQueuedOperations()).filter((operation) => operation.type.startsWith('receipt.') && operation.recordId === receiptId && operation.status !== 'synchronized')
      let queued = false
      if (earlier.length || !shouldAttemptServerRequest()) {
        await saveLocalDeletionAndOperation('receipts', receiptId, {
          id: operationId, type: 'receipt.delete', label: `Delete stock receipt ${deleteReceipt.invoice}`, target: `/api/receipts/${receiptId}`, method: 'DELETE', payload,
          dependsOn: earlier.map((operation) => operation.id), recordCollection: 'receipts', recordId: receiptId,
        })
        queued = true
      } else {
        let response: Response | null = null
        try { response = await fetch(`/api/receipts/${receiptId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
        catch (error) { if (!(error instanceof TypeError)) throw error }
        if (response && !response.ok) {
          const result = await response.json().catch(() => null)
          throw new Error(typeof result?.message === 'string' ? result.message : `Failed to delete stock receipt (${response.status})`)
        }
        if (!response) {
          await saveLocalDeletionAndOperation('receipts', receiptId, {
            id: operationId, type: 'receipt.delete', label: `Delete stock receipt ${deleteReceipt.invoice}`, target: `/api/receipts/${receiptId}`, method: 'DELETE', payload,
            recordCollection: 'receipts', recordId: receiptId,
          })
          queued = true
        } else await deleteLocalRecord('receipts', receiptId)
      }
      setReceipts((items) =>
        items.filter((item) => item.id !== receiptId)
      )
      if (queued) { setToast('Stock receipt deletion saved on this device · waiting for Sync Now'); window.dispatchEvent(new Event('micomerc-queue-changed')) }
      setDeleteReceipt(null)
    } catch (error) {
      console.error('Failed to delete stock:', error)
      setToast(error instanceof Error ? error.message : 'Failed to delete stock')
    }
  }}
      >
  Delete stock
      </button>
      </div>
    </div>
  </div>
)}

        <footer className="dashboard-footer">
          <strong>Micomerc</strong>
          <span>Stock, sales, and customer accounts in one place.</span>
          <small>© {new Date().getFullYear()} Micomerc</small>
        </footer>
        {toast && <div className="toast"><Check />{toast}</div>}
      </main>
    </div>
  )
}

function TrendingUpIcon() { return <ArrowUpRight /> }

function Toolbar({ query, setQuery, statusFilter, setStatusFilter, options }: { query: string; setQuery: (s: string) => void; statusFilter: string; setStatusFilter: (s: string) => void; options: string[] }) {
  return <div className="toolbar"><div className="search"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products, customers..." /></div><div className="filter-select"><SlidersHorizontal /><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter"><option value="All">All filters</option>{options.filter((x) => x !== 'All').map((x) => <option key={x}>{x}</option>)}</select></div></div>
}

function ProductTable({
  products,
  onNotify,
  onSaveEdit,
  onDelete,
  lowStockThreshold,
}: {
  products: Product[]
  onNotify: (s: string) => void
  onSaveEdit: (
    id: number,
    updates: Partial<Pick<Product, 'name' | 'model' | 'barcode' | 'category' | 'stock' | 'price' | 'status'>>
  ) => Promise<void>
  onDelete: (id: number) => void
  lowStockThreshold: number
}) {
  const [openId, setOpenId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Product | null>(null)
  const [saving, setSaving] = useState(false)
  const sortedProducts = useMemo(
    () => [...products].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [products],
  )

  const startEditing = (product: Product) => {
    setDraft({ ...product })
    setOpenId(null)
  }

  const updateDraft = (
    key: 'name' | 'model' | 'barcode' | 'category' | 'stock' | 'price' | 'status',
    value: string
  ) => {
    setDraft((current) => {
      if (!current) return current

      if (key === 'stock' || key === 'price') {
        const numberValue = Number(value)
        return {
          ...current,
          [key]: Number.isFinite(numberValue)
            ? Math.max(0, numberValue)
            : 0,
        }
      }

      return { ...current, [key]: value }
    })
  }

  const saveDraft = async () => {
    if (!draft || saving) return

    if (!draft.name.trim()) {
      onNotify('Product name cannot be empty')
      return
    }

    setSaving(true)
    try {
      await onSaveEdit(draft.id, {
        name: draft.name.trim(),
        model: draft.model.trim(),
        barcode: draft.barcode?.trim() ?? '',
        category: draft.category.trim(),
        stock: draft.stock,
        price: draft.price,
        status: draft.status === 'Discontinued' ? 'Discontinued' : 'Automatic',
      })
      setDraft(null)
    } catch {
      // Keep the draft open so the user can retry.
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`table-wrap record-list-scroll record-scroll-30${sortedProducts.length > 30 ? ' is-scrollable' : ''}`}>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Category</th>
            <th>In stock</th>
            <th>Unit price</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sortedProducts.map((product) => {
            const isEditing = draft?.id === product.id
            const row = isEditing && draft ? draft : product

            const status =
              row.status === 'Discontinued'
                ? 'Discontinued'
                : row.stock === 0
                  ? 'Out of stock'
                  : row.stock <= lowStockThreshold
                    ? 'Low stock'
                    : 'In stock'

            return (
              <tr key={product.id}>
                <td>
                  <div className="product-name">
                    <div className="product-thumb"><Package /></div>
                    {isEditing ? (
                      <div className="flex w-full flex-col gap-2">
                        <input
                          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                          value={row.name}
                          onChange={(e) => updateDraft('name', e.target.value)}
                          aria-label={`Name for ${product.name}`}
                        />
                        <input
                          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                          value={row.model}
                          onChange={(e) => updateDraft('model', e.target.value)}
                          aria-label={`Model for ${product.name}`}
                        />
                        <input
                          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                          value={row.barcode ?? ''}
                          onChange={(e) => updateDraft('barcode', e.target.value)}
                          aria-label={`Barcode for ${product.name}`}
                          placeholder="Barcode (optional)"
                        />
                      </div>
                    ) : (
                      <div>
                        <b>{product.name}</b>
                        <span>{product.model || product.sku}</span>
                        {product.barcode && <span>Barcode: {product.barcode}</span>}
                      </div>
                    )}
                  </div>
                </td>

                <td>
                  {isEditing ? (
                    <input
                      className="table-number"
                      value={row.category}
                      onChange={(e) => updateDraft('category', e.target.value)}
                      aria-label={`Category for ${product.name}`}
                    />
                  ) : product.category}
                </td>

                <td>
                  {isEditing ? (
                    <input
                      className="table-number"
                      type="number"
                      min="0"
                      step="1"
                      value={row.stock}
                      onChange={(e) => updateDraft('stock', e.target.value)}
                      aria-label={`Stock for ${product.name}`}
                    />
                  ) : product.stock}
                  {' '}units
                </td>

                <td>
                  {isEditing ? (
                    <input
                      className="table-number price"
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.price}
                      onChange={(e) => updateDraft('price', e.target.value)}
                      aria-label={`Price for ${product.name}`}
                    />
                  ) : product.price}
                </td>

                <td>
                  {isEditing ? (
                    <select
                      className="status-control"
                      value={row.status === 'Discontinued' ? 'Discontinued' : 'Automatic'}
                      onChange={(e) => updateDraft('status', e.target.value)}
                      aria-label={`Availability for ${product.name}`}
                    >
                      <option value="Automatic">Automatic</option>
                      <option value="Discontinued">Discontinued</option>
                    </select>
                  ) : (
                    <span className="status-pill">{status}</span>
                  )}
                </td>

                <td className="row-actions">
                  {isEditing ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="primary-button"
                        disabled={saving}
                        onClick={saveDraft}
                      >
                        {saving ? 'Saving...' : 'Save Changes'}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={saving}
                        onClick={() => setDraft(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        className="more-button"
                        onClick={() =>
                          setOpenId(openId === product.id ? null : product.id)
                        }
                        aria-label={`More actions for ${product.name}`}
                        aria-expanded={openId === product.id}
                      >
                        <MoreHorizontal />
                      </button>

                      {openId === product.id && (
                        <div className="stock-menu">
                          <button
                            onClick={() => {
                              onNotify(`${product.name} has ${product.stock} units available`)
                              setOpenId(null)
                            }}
                          >
                            View stock details
                          </button>
                          <button onClick={() => startEditing(product)}>
                            Edit Stock
                          </button>
                          <button
                            onClick={() => {
                              setOpenId(null)
                              onDelete(product.id)
                            }}
                          >
                            Delete stock
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {!products.length && (
        <div className="empty">
          <Package />
          <b>No products found</b>
          <span>Adjust your search or add a new item.</span>
        </div>
      )}
    </div>
  )
}

function Receipts({
  receipts,
  query,
  statusFilter,
  onEdit,
  onDelete,
}: {
  receipts: Receipt[]
  query: string
  statusFilter: string
  onEdit: (
    id: number,
    updates: Partial<Pick<Receipt, 'name' | 'model' | 'quantity' | 'invoice'>>
  ) => Promise<void>
  onDelete: (id: number) => void
}) {
  const [editing, setEditing] = useState<Record<number, Receipt>>({})
  const [saving, setSaving] = useState<number | null>(null)
  const visibleReceipts = useMemo(() => receipts
    .filter((receipt) => `${receipt.name} ${receipt.model} ${receipt.invoice}`.toLowerCase().includes(query.toLowerCase()))
    .filter(() => statusFilter === 'All' || statusFilter === 'Completed')
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.id - a.id), [receipts, query, statusFilter])

  const startEditing = (receipt: Receipt) => {
    setEditing((current) => ({
      ...current,
      [receipt.id]: { ...receipt },
    }))
  }

  const updateEditing = (
    id: number,
    key: 'name' | 'model' | 'quantity' | 'invoice',
    value: string
  ) => {
    setEditing((current) => ({
      ...current,
      [id]: {
        ...current[id],
        [key]:
          key === 'quantity'
            ? Number(value) || 0
            : value,
      },
    }))
  }

  const saveEditing = async (id: number) => {
    const draft = editing[id]

    if (!draft) return

    try {
      setSaving(id)

      await onEdit(id, {
        name: draft.name,
        model: draft.model,
        quantity: draft.quantity,
        invoice: draft.invoice,
      })

      setEditing((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className={`receipt-list record-list-scroll record-scroll-30${visibleReceipts.length > 30 ? ' is-scrollable' : ''}`}>
      {visibleReceipts.map((r) => {
        const draft = editing[r.id]
        const current = draft ?? r

        return (
          <details className="receipt-row" key={r.id}>
            <summary>
              <div className="receipt-icon">
                <ArrowDownLeft />
              </div>

              <div className="receipt-info">
                <b>{r.name}</b>
                <span>
                  Invoice #{r.invoice} · {daysAgo(r.date)}
                </span>
              </div>

              <strong>+{r.quantity} items</strong>

              <span className="status-pill success">
                Completed
              </span>

              <ChevronDown />
            </summary>

            <div className="receipt-details">
              <label>
                Stock name
                <input
                  value={current.name}
                  onFocus={() => startEditing(r)}
                  onChange={(e) =>
                    updateEditing(
                      r.id,
                      'name',
                      e.target.value
                    )
                  }
                />
              </label>

              <label>
                Model number
                <input
                  value={current.model}
                  onFocus={() => startEditing(r)}
                  onChange={(e) =>
                    updateEditing(
                      r.id,
                      'model',
                      e.target.value
                    )
                  }
                />
              </label>

              <label>
                Quantity
                <input
                  type="number"
                  min="0"
                  value={current.quantity}
                  onFocus={() => startEditing(r)}
                  onChange={(e) =>
                    updateEditing(
                      r.id,
                      'quantity',
                      e.target.value
                    )
                  }
                />
              </label>

              <label>
                Invoice
                <input
                  value={current.invoice}
                  onFocus={() => startEditing(r)}
                  onChange={(e) =>
                    updateEditing(
                      r.id,
                      'invoice',
                      e.target.value
                    )
                  }
                />
              </label>

              <div className="flex gap-2">
                {draft && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={saving === r.id}
                    onClick={() => saveEditing(r.id)}
                  >
                    {saving === r.id
                      ? 'Saving...'
                      : 'Save changes'}
                  </button>
                )}

                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-200"
                  onClick={() => onDelete(r.id)}
                >
                  Delete stock
                </button>
              </div>
            </div>
          </details>
        )
      })}
      {!visibleReceipts.length && <div className="empty"><Package /><b>No matching stock receipts</b><span>Adjust your search or filters to find a receiving record.</span></div>}
    </div>
  )
}

function DebtTable({ debts, paid, onOpen, currency }: { debts: Debt[]; paid: boolean; onOpen: (d: Debt) => void; currency: string }) {
  return <div className={`table-wrap record-list-scroll record-scroll-30${debts.length > 30 ? ' is-scrollable' : ''}`}><table><thead><tr><th>Customer</th><th>Invoice</th><th>Receipt RN</th><th>Amount</th><th>Remaining</th>
  <th>{paid ? 'Paid at' : 'Due'}</th></tr></thead><tbody>{debts.map((d) => {
    const paidAmount = d.payments.reduce((a, p) => a + p.amount, 0)
    return <tr key={d.id} onClick={() => onOpen(d)} className="clickable-row"><td><div className="customer">
      <div className="avatar customer-avatar">{d.customer.slice(0, 2).toUpperCase()}</div><b>{d.customer}</b></div></td>
      <td>{d.invoice}</td><td>{d.receiptNumber || '—'}</td><td><b>{money(d.amount, currency )}</b></td>
      <td><b>{money(Math.max(0, d.amount - paidAmount), currency )}</b>
      <span className="progress"><i style={{ width: `${Math.min(100, (paidAmount / d.amount) * 100)}%` }} /></span></td>
      <td><span className="status-pill success">{paid ? d.paidAt : 'Open · ' + d.due}</span></td></tr>
  })}</tbody></table>{!debts.length && <div className="empty"><CircleDollarSign />
  <b>{paid ? 'No paid debts' : 'No outstanding debts'}</b>
  <span>{paid ? 'Completed payments will appear here.' : 'All customer balances are clear.'}</span></div>}</div>
}

function DebtDetail({
  debt,
  readOnly,
  onClose,
  onSave,
}: {
  debt: Debt
  readOnly: boolean
  onClose: () => void
  onSave: (draft: Debt, fullyPaid: boolean) => Promise<Debt>
}) {
  const [draft, setDraft] = useState<Debt>(JSON.parse(JSON.stringify(debt)) as Debt)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isSavedDebt = Boolean(debt.id)
  const originalPaymentIds = useMemo(() => new Set((debt.payments ?? []).map((payment) => payment.id)), [debt.payments])
  const paidTotal = (draft.payments ?? []).reduce((total, payment) => total + Math.max(0, Number(payment.amount) || 0), 0)
  const balance = Math.max(0, (Number(draft.amount) || 0) - paidTotal)

  const updateItemDescription = (index: number, value: string) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item, row) =>
        row === index ? { ...item, name: value } : item
      ),
    }))
  }

  const saveDraft = async () => {
    if (readOnly || saving) return

    const normalizedDraft: Debt = {
      ...draft,
      customer: draft.customer.trim(),
      items: (draft.items ?? []).map((item) => ({
        ...item,
        name: String(item.name ?? '').trim(),
        price: Math.max(0, Number(item.price) || 0),
        date: item.date ?? now(),
      })),
      amount: Math.max(0, Number(draft.amount) || 0),
      payments: (draft.payments ?? []).map((payment) => ({
        ...payment,
        amount: Math.max(0, Number(payment.amount) || 0),
      })),
    }

    setSaving(true)
    setError('')

    try {
      await onSave(normalizedDraft, balance <= 0)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Debt could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal wide debt-detail-modal">
        <div className="modal-header">
          <div>
            <div className="eyebrow">Debt detail</div>
            <h2>{draft.customer}</h2>
            <p>Invoice: {draft.invoice} · Receipt RN: {draft.receiptNumber || '—'} · Created {draft.createdAt}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close debt details">
            <X />
          </button>
        </div>

        <div className="debt-detail-body modal-scroll-body">
          <div className="detail-grid">
            <label>
              Customer name
              <input disabled={readOnly || isSavedDebt} value={draft.customer} onChange={(event) => setDraft({ ...draft, customer: event.target.value })} />
            </label>
            <label>
              Original debt amount
              <input type="number" disabled={readOnly || isSavedDebt} value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: Number(event.target.value) })} />
            </label>
            <label>
              Receipt number (RN)
              <input disabled={readOnly} value={draft.receiptNumber ?? ''} onChange={(event) => setDraft({ ...draft, receiptNumber: event.target.value })} maxLength={100} placeholder="Enter receipt number" />
            </label>
          </div>

          <h3>Items bought</h3>
          <div className="debt-item-notes">
            {draft.items.map((item, index) => {
              const isOriginalSavedItem = isSavedDebt && index < debt.items.length

              return (
                <div className="debt-item-note-row" key={`debt-item-${index}`}>
                  <textarea
                    aria-label={`Item details ${index + 1}`}
                    disabled={readOnly || isOriginalSavedItem}
                    value={item.name ?? ''}
                    onChange={(event) => updateItemDescription(index, event.target.value)}
                    rows={2}
                    maxLength={4000}
                    placeholder="Describe the items bought"
                  />
                </div>
              )
            })}
          </div>

          <h3>Part payments</h3>
          <div className="payment-list">
            {draft.payments.map((payment, index) => {
              const isLocked = readOnly || originalPaymentIds.has(payment.id)
              return <div className="editable-row" key={String(payment.id ?? `${payment.date}-${index}`)}>
                <input type="number" disabled={isLocked} value={payment.amount} onChange={(event) => setDraft((current) => ({ ...current, payments: current.payments.map((item, row) => row === index ? { ...item, amount: Number(event.target.value) } : item) }))} />
                <span>{payment.date}</span>
              </div>
            })}
            {!readOnly && <button type="button" className="secondary-button" onClick={() => setDraft((current) => ({ ...current, payments: [...current.payments, { id: Date.now(), amount: 0, date: now() }] }))}><Plus />Add payment</button>}
          </div>
        </div>

        <div className="summary-row">
          <div>
            <span>{readOnly ? 'Paid in full' : 'Balance'}</span>
            <strong>{readOnly ? money(draft.amount) : money(balance)}</strong>
          </div>

          {!readOnly && (
            <>
              {error && <small className="field-error">{error}</small>}
              <button
                className="primary-button"
                onClick={() => void saveDraft()}
                disabled={saving}
              >
                {saving ? 'Saving…' : balance <= 0 ? 'Mark as paid' : 'Save changes'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}


function DebtComposer({ onClose, onSubmit }: {
  onClose: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  const [customer, setCustomer] = useState('')
  const [item, setItem] = useState('')
  const [amount, setAmount] = useState('')
  const idempotencyRef = useRef<HTMLInputElement>(null)

  const amountValue = Number(amount)
  const canSubmit = customer.trim().length > 0 && item.trim().length > 0 &&
    amount.trim() !== '' && Number.isFinite(amountValue) && amountValue > 0

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    if (!canSubmit) {
      event.preventDefault()
      return
    }
    if (idempotencyRef.current && !idempotencyRef.current.value) {
      idempotencyRef.current.value = window.crypto.randomUUID()
    }
    onSubmit(event)
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
    <div className="modal debt-create-modal">
      <div className="modal-header">
        <div>
          <div className="eyebrow">Workspace action</div>
          <h2>Add customer debt</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close debt form"><X /></button>
      </div>
      <form onSubmit={submit} noValidate>
        <label>Customer name
          <input name="customer" value={customer} onChange={(event) => { setCustomer(event.target.value); if (idempotencyRef.current) idempotencyRef.current.value = '' }} maxLength={120} required placeholder="Customer name" />
        </label>
        <label>Items bought
          <textarea name="item" value={item} onChange={(event) => { setItem(event.target.value); if (idempotencyRef.current) idempotencyRef.current.value = '' }} required rows={5} maxLength={4000} placeholder="Describe the items bought" />
        </label>
        <label>Receipt number (RN)
          <input name="receiptNumber" maxLength={100} placeholder="Enter receipt number" onChange={() => { if (idempotencyRef.current) idempotencyRef.current.value = '' }} />
        </label>
        <label>Amount
          <input name="amount" type="number" min="0.01" max="1000000000" step="0.01" value={amount} onChange={(event) => { setAmount(event.target.value); if (idempotencyRef.current) idempotencyRef.current.value = '' }} required placeholder="0.00" />
        </label>
        <input type="hidden" name="idempotencyKey" ref={idempotencyRef} defaultValue="" />
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={!canSubmit}><Check />Save record</button>
        </div>
      </form>
    </div>
  </div>
}

function RecordModal({ type, onClose, onSubmit }: { type: 'product' | 'debt' | 'receipt' | 'login' | 'detail'; onClose: () => void; onSubmit: (e: React.FormEvent<HTMLFormElement>) => void }) {
  if (type === 'debt') return <DebtComposer onClose={onClose} onSubmit={onSubmit} />
  return <div className="modal-backdrop" onMouseDown={(e) => e.currentTarget === e.target && onClose()}>
    <div className="modal">
      <div className="modal-header"><div><div className="eyebrow">Workspace action</div><h2>{type === 'product' ? 'Add new product' : type === 'receipt' ? 'Record stock receipt' : 'Workspace action'}</h2></div><button className="icon-button" onClick={onClose}><X /></button></div>
      <form onSubmit={onSubmit}>
        <label>Name or reference<input name="name" required placeholder="Product or receipt name" /></label>
        {type === 'product' && <div className="form-row">
          <label>Category<input name="category" required placeholder="Product category" /></label>
          <label>Model number<input name="model" placeholder="Model number" /></label>
          <label>Barcode (optional)<input name="barcode" type="text" inputMode="text" autoComplete="off" maxLength={128} placeholder="Keep leading zeroes" /></label>
          <label>Price<input name="price" type="number" min="0" step="0.01" required /></label>
          <label>Quantity<input name="stock" type="number" min="0" required /></label>
        </div>}
        {type === 'receipt' && <><label>Model number<input name="model" required placeholder="Model number" /></label><div className="form-row"><label>Quantity<input name="quantity" type="number" min="0" required /></label><label>Invoice<input name="invoice" required placeholder="Invoice number" /></label></div></>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit"><Check />Save record</button></div>
      </form>
    </div>
  </div>
}

function SettingsPage({ settings, setSettings, onSave }: { settings: { workspace: string; currency: string; notifications: string; lowStockThreshold: string; dateFormat: string }; setSettings: React.Dispatch<React.SetStateAction<typeof settings>>; onSave: () => void }) {
  return <div className="settings-page mb-20">
    <div className="settings-card"><Settings /><div><h2>Workspace settings</h2><p>Control preferences, alerts, and defaults for your team.</p></div></div><label>Workspace name<input value={settings.workspace} onChange={(e) => setSettings((s) => ({ ...s, workspace: e.target.value }))} /></label><label>Default currency<select value={settings.currency} onChange={(e) => setSettings((s) => ({ ...s, currency: e.target.value }))}><option value="NGN">₦ — Nigerian Naira</option><option value="USD">$ — US Dollar</option><option value="EUR">€ — Euro</option><option value="GBP">£ — Pound Sterling</option></select></label><label>Notifications<select value={settings.notifications} onChange={(e) => setSettings((s) => ({ ...s, notifications: e.target.value }))}><option>All activity</option><option>Important only</option><option>Disabled</option></select></label><label>Low stock alert threshold<input type="number" value={settings.lowStockThreshold} onChange={(e) => setSettings((s) => ({ ...s, lowStockThreshold: e.target.value }))} /></label><label>Date format<select value={settings.dateFormat} onChange={(e) => setSettings((s) => ({ ...s, dateFormat: e.target.value }))}><option>MMM D, YYYY</option><option>DD/MM/YYYY</option><option>YYYY-MM-DD</option></select></label><button className="primary-button" onClick={onSave}><Check/>Save changes</button></div>
}

// function TeamPage() {
//   return <div className="team-grid mb-20">{[['Alex Morgan', 'Administrator', 'AM'], ['Jordan Lee', 'Sales representative', 'JL'], ['Priya Shah', 'Sales representative', 'PS'], ['Sam Wilson', 'Inventory manager', 'SW']].map(([name, role, initials]) => <div className="team-card" key={name}><div className="avatar team-avatar">{initials}</div><div><b>{name}</b><span>{role}</span></div><span className="status-pill success">Active</span></div>)}</div>
// }
