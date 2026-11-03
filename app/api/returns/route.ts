import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from 'node:crypto'
import clientPromise from '@/lib/mongodb'
import { ensureCollections, isTransactionUnavailable } from '@/lib/inventory'
import { NextResponse } from 'next/server'

const DB = MICOMERC_DB
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type ReturnLine = { productId: number; name: string; quantity: number; condition: 'sellable' | 'damaged' | 'quarantined'; unitPriceMinor: number }
class ReturnRequestError extends Error { constructor(message: string, readonly status: number) { super(message) } }

export async function GET() {
  try {
    const client = await clientPromise()
    const rows = await client.db(DB).collection<{ _id: string; [key: string]: any }>('returns').find({}).sort({ createdAt: -1 }).limit(500).toArray()
    return NextResponse.json(rows.map(({ _id, requestHash, ...row }) => row))
  } catch (error) {
    console.error('Failed to load returns', error)
    return NextResponse.json({ message: 'Returns are unavailable' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.operationId !== 'string' || !UUID.test(body.operationId)) throw new ReturnRequestError('A valid operation ID is required', 400)
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 300 || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) throw new ReturnRequestError('Return reason and items are required', 400)
    const client = await clientPromise()
    const db = client.db(DB)
    await ensureCollections(db, ['returns'])
    const returns = db.collection<{ _id: string; [key: string]: any }>('returns')
    const hash = createHash('sha256').update(JSON.stringify({ saleId: body.saleId ?? null, reason: body.reason.trim(), notes: String(body.notes ?? '').slice(0, 2000), items: body.items })).digest('hex')
    const session = client.startSession()
    let created = false
    let record: Record<string, any> | null = null
    try {
      await session.withTransaction(async () => {
        const existing = await returns.findOne({ _id: body.operationId }, { session })
        if (existing) {
          if (existing.requestHash !== hash) throw new ReturnRequestError('Operation ID was already used for different return data', 409)
          record = existing
          return
        }
        const lines: ReturnLine[] = []
        for (const item of body.items) {
          if (!item || !Number.isSafeInteger(item.productId) || item.productId <= 0 || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1000000 || Math.abs(item.quantity * 1000 - Math.round(item.quantity * 1000)) > 0.000001) throw new ReturnRequestError('Return item quantities and product IDs must be valid', 400)
          if (!['sellable', 'damaged', 'quarantined'].includes(item.condition)) throw new ReturnRequestError('Choose a valid item condition', 400)
          const name = typeof item.name === 'string' ? item.name.trim().slice(0, 180) : ''
          let unitPriceMinor = 0
          if (typeof body.saleId === 'string' && body.saleId) {
            const sale = await db.collection('sales').findOne({ _id: body.saleId }, { session })
            if (!sale) throw new ReturnRequestError('Original sale was not found', 409)
            const saleLine = Array.isArray(sale.items) ? sale.items.find((line: { productId?: number }) => line.productId === item.productId) : null
            if (!saleLine || !Number.isSafeInteger(saleLine.unitPriceMinor) || !Number.isFinite(saleLine.quantity)) throw new ReturnRequestError('Product is not part of a valid original sale', 409)
            const previous = await returns.aggregate([{ $match: { saleId: body.saleId, status: { $ne: 'rejected' } } }, { $unwind: '$items' }, { $match: { 'items.productId': item.productId } }, { $group: { _id: null, qty: { $sum: '$items.quantity' } } }], { session }).toArray()
            const previouslyReturned = Number(previous[0]?.qty ?? 0)
            if (previouslyReturned + item.quantity > Number(saleLine.quantity)) throw new ReturnRequestError(`Return quantity exceeds the remaining eligible quantity (${Math.max(0, Number(saleLine.quantity) - previouslyReturned)})`, 409)
            unitPriceMinor = Number(saleLine.unitPriceMinor)
          } else {
            const product = await db.collection('products').findOne({ id: item.productId }, { session })
            if (!product) throw new ReturnRequestError('Product was not found', 409)
          }
          lines.push({ productId: item.productId, name, quantity: item.quantity, condition: item.condition, unitPriceMinor })
        }
        const createdAt = new Date().toISOString()
        const reference = `RET-${createdAt.slice(0, 10).replaceAll('-', '')}-${body.operationId.slice(0, 8).toUpperCase()}`
        const amountMinor = lines.reduce((sum, line) => sum + Math.round(line.unitPriceMinor * line.quantity), 0)
        if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new ReturnRequestError('Refund amount is outside the supported range', 400)
        const value = { _id: body.operationId, id: body.operationId, operationId: body.operationId, requestHash: hash, reference, saleId: typeof body.saleId === 'string' ? body.saleId : null, reason: body.reason.trim(), notes: String(body.notes ?? '').slice(0, 2000), items: lines, amountMinor, status: 'pending-review', refundStatus: 'pending', inventoryStatus: 'not-restocked', createdAt, updatedAt: createdAt, history: [{ at: createdAt, event: 'Return submitted', detail: 'Saved for review' }] }
        await returns.insertOne(value, { session })
        record = value
        created = true
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    } finally { await session.endSession() }
    if (!record) throw new Error('Return transaction completed without a record')
    const { _id, requestHash, ...response } = record as Record<string, any>
    return NextResponse.json(response, { status: created ? 201 : 200 })
  } catch (error) {
    if (error instanceof ReturnRequestError) return NextResponse.json({ message: error.message }, { status: error.status })
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: 'Return validation requires MongoDB transaction support; no record was saved' }, { status: 503 })
    console.error('Failed to create return', error)
    return NextResponse.json({ message: 'Return could not be saved' }, { status: 500 })
  }
}
