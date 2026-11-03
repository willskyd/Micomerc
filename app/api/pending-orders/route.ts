import { createHash } from 'node:crypto'
import type { ClientSession, Document } from 'mongodb'
import { NextResponse } from 'next/server'
import clientPromise from '@/lib/mongodb'
import { ensureCollections, InventoryError, INVENTORY_DB, isTransactionUnavailable, MOVEMENT_COLLECTION, readLowStockThreshold, recordStockMovement } from '@/lib/inventory'
import { normalizeWorkspaceName } from '@/lib/branding'

const COLLECTION = 'pendingOrders'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type OrderDoc = Document & { _id: string; id: string; requestHash: string; status: 'Pending' | 'Accepted' | 'Rejected'; items: Array<{ productId: number; name: string; sku: string; barcode: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }> }

function publicOrder(value: OrderDoc) {
  const { _id, requestHash, appliedOperations, ...order } = value
  return order
}

function parseItems(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new InventoryError('Add at least one product to the pending order')
  const quantities = new Map<number, number>()
  for (const line of value) {
    if (!line || typeof line !== 'object' || !('productId' in line) || !('quantity' in line) || typeof line.productId !== 'number' || !Number.isSafeInteger(line.productId) || line.productId <= 0 || typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 1_000_000 || Math.abs(line.quantity * 1000 - Math.round(line.quantity * 1000)) > 0.000001) throw new InventoryError('Pending order items or quantities are invalid')
    quantities.set(line.productId, Math.round(((quantities.get(line.productId) ?? 0) + line.quantity) * 1000) / 1000)
  }
  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }))
}

export async function GET() {
  try {
    const client = await clientPromise()
    const db = client.db(INVENTORY_DB)
    const rows = await db.collection<OrderDoc>(COLLECTION).find({}).sort({ createdAt: -1 }).toArray()
    const acceptedIds = rows.filter((row) => row.status === 'Accepted').map((row) => String((row as any).saleId ?? row.id))
    const sales = acceptedIds.length ? await db.collection('sales').find({ id: { $in: acceptedIds } }).toArray() : []
    const saleById = new Map(sales.map((sale) => [String(sale.id), sale]))
    return NextResponse.json(rows.map((row) => {
      const saleId = String((row as any).saleId ?? row.id)
      return { ...publicOrder(row), ...(saleById.has(saleId) ? { sale: saleById.get(saleId) } : {}) }
    }))
  } catch (error) {
    console.error('Failed to load pending orders:', error)
    return NextResponse.json({ message: 'Pending orders are unavailable' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InventoryError('Pending order details are invalid')
    const input = body as Record<string, unknown>
    const operationId = input.operationId
    if (typeof operationId !== 'string' || !UUID.test(operationId)) throw new InventoryError('A valid pending order operation ID is required')
    const customerName = typeof input.customerName === 'string' ? input.customerName.trim() : ''
    const customerPhone = typeof input.customerPhone === 'string' ? input.customerPhone.trim() : ''
    if (customerName.length > 160 || customerPhone.length > 40) throw new InventoryError('Customer details exceed the allowed length')
    const requestedItems = parseItems(input.items)
    const hash = createHash('sha256').update(JSON.stringify({ customerName, customerPhone, requestedItems })).digest('hex')
    const client = await clientPromise()
    const db = client.db(INVENTORY_DB)
    await ensureCollections(db, [COLLECTION, MOVEMENT_COLLECTION])
    const session = client.startSession()
    let saved: OrderDoc | null = null
    let replayed = false
    try {
      await session.withTransaction(async () => {
        const orders = db.collection<OrderDoc>(COLLECTION)
        const existing = await orders.findOne({ _id: operationId }, { session })
        if (existing) {
          if (existing.requestHash !== hash) throw new InventoryError('This order ID was used for different order details', 409)
          saved = existing
          replayed = true
          return
        }
        const products = db.collection('products')
        const lines: OrderDoc['items'] = []
        const now = new Date().toISOString()
        for (const requested of requestedItems) {
          const product = await products.findOne({ id: requested.productId }, { session })
          if (!product || typeof product.stock !== 'number') throw new InventoryError(`Product ${requested.productId} is no longer available`, 409)
          if (String(product.status ?? '').trim().toLowerCase() === 'discontinued') throw new InventoryError(`${product.name} is discontinued`, 409)
          if (typeof product.price !== 'number' || !Number.isFinite(product.price) || product.price < 0 || product.price > Number.MAX_SAFE_INTEGER / 100) throw new InventoryError(`${product.name} has an invalid price`, 409)
          const unitPriceMinor = Math.round(product.price * 100)
          const lineTotalMinor = Math.round(unitPriceMinor * requested.quantity)
          if (!Number.isSafeInteger(lineTotalMinor)) throw new InventoryError('Pending order total exceeds the supported amount')
          const reservation = await products.updateOne({ id: requested.productId, $expr: { $gte: [{ $subtract: ['$stock', { $ifNull: ['$reservedStock', 0] }] }, requested.quantity] }, status: { $not: /^Discontinued$/i } }, { $inc: { reservedStock: requested.quantity } }, { session })
          if (reservation.matchedCount !== 1) throw new InventoryError(`Insufficient available stock for ${product.name}`, 409)
          lines.push({ productId: requested.productId, name: String(product.name), sku: String(product.sku ?? product.model ?? ''), barcode: String(product.barcode ?? ''), quantity: requested.quantity, unitPriceMinor, lineTotalMinor })
          await recordStockMovement(db, session, { id: `pending-order:${operationId}:reserve:${requested.productId}`, productId: requested.productId, delta: 0, type: 'pending-order-reserve', sourceId: operationId, at: new Date(now), description: `Reserved ${requested.quantity} units for pending order ${operationId}` })
        }
        const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0)
        if (!Number.isSafeInteger(subtotalMinor)) throw new InventoryError('Pending order total exceeds the supported amount')
        const reference = `PO-${now.slice(0, 10).replaceAll('-', '')}-${operationId.slice(0, 8).toUpperCase()}`
        saved = { _id: operationId, id: operationId, requestHash: hash, reference, status: 'Pending', customerName, customerPhone, createdAt: now, items: lines, subtotalMinor, totalMinor: subtotalMinor, history: [{ at: now, actor: 'Workspace user', event: 'Order submitted' }] } as OrderDoc
        await orders.insertOne(saved, { session })
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    } finally { await session.endSession() }
    const savedOrder = saved as OrderDoc | null
    if (!savedOrder) throw new Error('Pending order transaction completed without a record')
    const inventory = await db.collection('products').find({ id: { $in: savedOrder.items.map((line) => line.productId) } }).toArray()
    return NextResponse.json({ order: publicOrder(savedOrder), inventory }, { status: replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status })
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: 'Pending orders require MongoDB transaction support; no order or reservation was saved' }, { status: 503 })
    console.error('Failed to create pending order:', error)
    return NextResponse.json({ message: 'Pending order could not be saved' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InventoryError('Order action is invalid')
    const input = body as Record<string, unknown>
    const orderId = input.orderId
    const operationId = input.operationId
    const action = input.action
    const requestedSaleId = input.saleId
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : ''
    if (typeof orderId !== 'string' || !UUID.test(orderId) || typeof operationId !== 'string' || !UUID.test(operationId) || !['accept', 'reject'].includes(String(action))) throw new InventoryError('Order action details are invalid')
    if (action === 'accept' && requestedSaleId !== undefined && (typeof requestedSaleId !== 'string' || !UUID.test(requestedSaleId))) throw new InventoryError('A valid sale ID is required')
    const hash = createHash('sha256').update(JSON.stringify(requestedSaleId ? { action, reason, saleId: requestedSaleId } : { action, reason })).digest('hex')
    const client = await clientPromise()
    const db = client.db(INVENTORY_DB)
    await ensureCollections(db, [COLLECTION, 'sales', MOVEMENT_COLLECTION])
    const session: ClientSession = client.startSession()
    let response: { order: OrderDoc; sale?: Record<string, unknown>; inventory: Record<string, unknown>[] } | null = null
    try {
      await session.withTransaction(async () => {
        const orders = db.collection<OrderDoc>(COLLECTION)
        const order = await orders.findOne({ _id: orderId }, { session })
        if (!order) throw new InventoryError('Pending order was not found', 404)
        const prior = (order.appliedOperations ?? []).find((operation: { id: string; hash: string }) => operation.id === operationId)
        if (prior) {
          const legacyHash = createHash('sha256').update(JSON.stringify({ action, reason })).digest('hex')
          if (prior.hash !== hash && prior.hash !== legacyHash) throw new InventoryError('This operation ID was used for a different order action', 409)
          const sale = action === 'accept' ? await db.collection('sales').findOne({ id: String((order as any).saleId ?? orderId) }, { session }) : null
          const inventory = await db.collection('products').find({ id: { $in: order.items.map((item) => item.productId) } }, { session }).toArray()
          response = { order, ...(sale ? { sale } : {}), inventory }
          return
        }
        if (order.status !== 'Pending') throw new InventoryError(`This order is already ${order.status.toLowerCase()}`, 409)
        const history = [...((order as any).history ?? [])]
        const now = new Date()
        const products = db.collection<any>('products')
        const inventory: Record<string, unknown>[] = []
        let sale: Record<string, unknown> | undefined
        if (action === 'accept') {
          const saleId = typeof requestedSaleId === 'string' ? requestedSaleId : order.id
          const threshold = await readLowStockThreshold(db, session)
          for (const line of order.items) {
            const product = await products.findOne({ id: line.productId }, { session })
            if (!product || Number(product.reservedStock ?? 0) < line.quantity || product.stock < line.quantity) throw new InventoryError(`Reserved stock changed for ${line.name}; review this conflict`, 409)
            const nextStock = Math.round((product.stock - line.quantity) * 1000) / 1000
            const reservedStock = Math.round((Number(product.reservedStock ?? 0) - line.quantity) * 1000) / 1000
            const status = nextStock <= 0 ? 'Out of stock' : nextStock <= threshold ? 'Low stock' : 'In stock'
            const changed = await products.updateOne({ id: line.productId, stock: product.stock, reservedStock: product.reservedStock ?? { $exists: false } }, { $inc: { stock: -line.quantity, reservedStock: -line.quantity }, $set: { status } }, { session })
            if (changed.matchedCount !== 1) throw new InventoryError(`Stock changed while accepting ${order.reference}`, 409)
            await recordStockMovement(db, session, { id: `pending-order:${order.id}:accept:${line.productId}`, productId: line.productId, delta: -line.quantity, type: 'pending-order-sale', sourceId: saleId, at: now, description: `Accepted ${order.reference}; sale ${saleId}` })
            inventory.push({ ...product, stock: nextStock, reservedStock, status })
          }
          const settings = await db.collection('settings').findOne({ key: 'workspace' }, { session })
          const currency = ['NGN', 'USD', 'EUR', 'GBP'].includes(String(settings?.currency)) ? String(settings?.currency) : 'NGN'
          const businessName = normalizeWorkspaceName(settings?.workspace)
          const items = order.items.map((line) => ({ ...line, lineTotalMinor: Math.round(line.unitPriceMinor * line.quantity) }))
          const totalMinor = items.reduce((sum, line) => sum + line.lineTotalMinor, 0)
          if (!Number.isSafeInteger(totalMinor)) throw new InventoryError('Order total exceeds the supported amount', 409)
          const receiptNumber = `MM-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${saleId.toUpperCase()}`
          sale = { _id: saleId, id: saleId, receiptNumber, businessName, currency, createdAt: now, items, subtotalMinor: totalMinor, discountMinor: 0, taxMinor: 0, totalMinor, payment: { method: 'cash', status: 'paid', amountTenderedMinor: totalMinor, changeMinor: 0 }, customerName: order.customerName, customerPhone: order.customerPhone, pendingOrderId: order.id, pendingOrderReference: order.reference }
          await db.collection('sales').insertOne(sale, { session })
          history.push({ at: now.toISOString(), actor: 'Workspace user', event: 'Order accepted and payment confirmed', detail: `Sale finalized as receipt ${sale.receiptNumber}` })
        } else {
          for (const line of order.items) {
            const product = await products.findOne({ id: line.productId }, { session })
            if (!product || Number(product.reservedStock ?? 0) < line.quantity) throw new InventoryError(`Reservation changed for ${line.name}; review this conflict`, 409)
            const changed = await products.updateOne({ id: line.productId, reservedStock: product.reservedStock ?? { $exists: false } }, { $inc: { reservedStock: -line.quantity } }, { session })
            if (changed.matchedCount !== 1) throw new InventoryError(`Reservation changed while rejecting ${order.reference}`, 409)
            await recordStockMovement(db, session, { id: `pending-order:${order.id}:reject:${operationId}:${line.productId}`, productId: line.productId, delta: 0, type: 'pending-order-release', sourceId: order.id, at: now, description: `Rejected ${order.reference}; released ${line.quantity} reserved units${reason ? ` · ${reason}` : ''}` })
            inventory.push({ ...product, reservedStock: Number(product.reservedStock ?? 0) - line.quantity })
          }
          history.push({ at: now.toISOString(), actor: 'Workspace user', event: 'Order rejected', ...(reason ? { detail: reason } : {}) })
        }
        const nextStatus = action === 'accept' ? 'Accepted' : 'Rejected'
        const appliedOperations = [...((order as any).appliedOperations ?? []), { id: operationId, hash }]
        const set: Record<string, unknown> = { status: nextStatus, history, appliedOperations, updatedAt: now.toISOString(), ...(action === 'accept' ? { saleId: sale?.id } : { rejectionReason: reason }) }
        const updated = await orders.findOneAndUpdate({ _id: orderId, status: 'Pending', appliedOperations: { $ne: operationId } }, { $set: set }, { returnDocument: 'after' })
        const updatedOrder = (updated as any)?.value ?? updated
        if (!updatedOrder) throw new InventoryError('Order status changed during this action', 409)
        response = { order: updatedOrder as OrderDoc, ...(sale ? { sale } : {}), inventory }
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    } finally { await session.endSession() }
    const actionResponse = response as { order: OrderDoc; sale?: Record<string, unknown>; inventory: Record<string, unknown>[] } | null
    if (!actionResponse) throw new Error('Pending order action completed without a result')
    return NextResponse.json({ order: { ...publicOrder(actionResponse.order), ...(actionResponse.sale ? { sale: actionResponse.sale } : {}) }, ...(actionResponse.sale ? { sale: actionResponse.sale } : {}), inventory: actionResponse.inventory })
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status })
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: 'Pending order actions require MongoDB transactions; no sale or stock changes were made' }, { status: 503 })
    console.error('Failed to process pending order:', error)
    return NextResponse.json({ message: 'Pending order action failed' }, { status: 500 })
  }
}
