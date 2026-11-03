import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from 'node:crypto'
import clientPromise from '@/lib/mongodb'
import { ensureCollections, isTransactionUnavailable, MOVEMENT_COLLECTION, recordStockMovement } from '@/lib/inventory'
import { NextResponse } from 'next/server'

const DB = MICOMERC_DB
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type CompanyReturnRecord = {
  _id: string
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
  replacements: Array<{ id: string; productId: number; productName: string; quantityReceived: number; receivedAt: string; condition: 'New' | 'Used' | 'Damaged'; notes: string; createdAt: string }>
  createdAt: string
  updatedAt: string
  history: Array<{ at: string; event: string; detail: string }>
  requestHash: string
}

class CompanyReturnRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export async function GET() {
  try {
    const client = await clientPromise()
    const db = client.db(DB)
    const rows = await db.collection<CompanyReturnRecord>('companyReturns').find({}).sort({ createdAt: -1 }).limit(500).toArray()
    return NextResponse.json(rows.map(({ _id, requestHash, ...row }) => row))
  } catch (error) {
    console.error('Failed to load company returns', error)
    return NextResponse.json({ message: 'Company returns are unavailable' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new CompanyReturnRequestError('Company return payload is required', 400)
    }
    if (typeof body.operationId !== 'string' || !UUID.test(body.operationId)) {
      throw new CompanyReturnRequestError('A valid operation ID is required', 400)
    }
    if (typeof body.supplierName !== 'string' || !body.supplierName.trim()) {
      throw new CompanyReturnRequestError('Supplier name is required', 400)
    }
    if (!Number.isSafeInteger(body.productId) || body.productId <= 0) {
      throw new CompanyReturnRequestError('A valid product is required', 400)
    }
    if (!Number.isFinite(body.quantityReturned) || body.quantityReturned <= 0 || body.quantityReturned > 1_000_000) {
      throw new CompanyReturnRequestError('Return quantity must be greater than zero', 400)
    }
    if (!Number.isFinite(body.unitCostMinor) || body.unitCostMinor <= 0 || body.unitCostMinor > 1_000_000_000) {
      throw new CompanyReturnRequestError('A valid unit cost is required', 400)
    }
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 300) {
      throw new CompanyReturnRequestError('Return reason is required', 400)
    }
    if (typeof body.returnDate !== 'string' || !body.returnDate.trim()) {
      throw new CompanyReturnRequestError('Return date is required', 400)
    }

    const client = await clientPromise()
    const db = client.db(DB)
    await ensureCollections(db, ['companyReturns', MOVEMENT_COLLECTION])
    const collection = db.collection<CompanyReturnRecord>('companyReturns')
    const hash = createHash('sha256').update(JSON.stringify({
      supplierName: body.supplierName,
      productId: body.productId,
      quantityReturned: body.quantityReturned,
      unitCostMinor: body.unitCostMinor,
      reason: body.reason,
      returnDate: body.returnDate,
      notes: String(body.notes ?? '').slice(0, 2000),
    })).digest('hex')

    const session = client.startSession()
    try {
      await session.withTransaction(async () => {
        const existing = await collection.findOne({ _id: body.operationId }, { session })
        if (existing) {
          if (existing.requestHash !== hash) {
            throw new CompanyReturnRequestError('This operation ID was already used for different company return data', 409)
          }
          return
        }

        const now = new Date().toISOString()
        const reference = `CR-${now.slice(0, 10).replace(/-/g, '')}-${body.operationId.slice(0, 8).toUpperCase()}`
        const value: CompanyReturnRecord = {
          _id: body.operationId,
          id: body.operationId,
          reference,
          supplierName: body.supplierName.trim(),
          productId: Number(body.productId),
          productName: typeof body.productName === 'string' ? body.productName.trim() : '',
          quantityReturned: Number(body.quantityReturned),
          unitCostMinor: Number(body.unitCostMinor),
          reason: body.reason.trim(),
          returnDate: body.returnDate,
          notes: String(body.notes ?? '').slice(0, 2000),
          status: 'Awaiting Replacement',
          outstandingQuantity: Number(body.quantityReturned),
          totalReceived: 0,
          replacements: [],
          createdAt: now,
          updatedAt: now,
          history: [{ at: now, event: 'Return recorded', detail: 'Logged and awaiting replacement goods' }],
          requestHash: hash,
        }
        if (!value.productName) {
          const product = await db.collection('products').findOne({ id: value.productId }, { session })
          if (!product) throw new CompanyReturnRequestError('The selected product could not be found', 409)
          value.productName = String(product.name)
        }
        await collection.insertOne(value, { session })
        await recordStockMovement(db, session, {
          id: `company-return:${value.id}`,
          productId: value.productId,
          delta: -value.quantityReturned,
          type: 'company-return-outbound',
          sourceId: value.id,
          at: new Date(now),
          description: `Supplier return ${value.reference} recorded for ${value.productName}`,
        })
        const product = await db.collection('products').findOne({ id: value.productId }, { session })
        if (!product) throw new CompanyReturnRequestError('Stock movement could not be linked to a product', 409)
        const stock = Number(product.stock ?? 0)
        const settings = await db.collection<{ lowStockThreshold?: number }>('settings').findOne({ key: 'workspace' }, { session })
        const lowStockThreshold = Number(settings?.lowStockThreshold ?? 30)
        const nextStock = stock - value.quantityReturned
        await db.collection('products').updateOne({ id: value.productId, stock }, { $set: { stock: nextStock, status: nextStock <= 0 ? 'Out of stock' : nextStock <= lowStockThreshold ? 'Low stock' : 'In stock' } }, { session })
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    } finally {
      await session.endSession()
    }

    const persistedRecord = await collection.findOne({ _id: body.operationId })
    if (!persistedRecord) throw new Error('Company return transaction completed without a record')
    const response: Omit<CompanyReturnRecord, '_id' | 'requestHash'> = {
      id: persistedRecord.id,
      reference: persistedRecord.reference,
      supplierName: persistedRecord.supplierName,
      productId: persistedRecord.productId,
      productName: persistedRecord.productName,
      quantityReturned: persistedRecord.quantityReturned,
      unitCostMinor: persistedRecord.unitCostMinor,
      reason: persistedRecord.reason,
      returnDate: persistedRecord.returnDate,
      notes: persistedRecord.notes,
      status: persistedRecord.status,
      outstandingQuantity: persistedRecord.outstandingQuantity,
      totalReceived: persistedRecord.totalReceived,
      replacements: persistedRecord.replacements,
      createdAt: persistedRecord.createdAt,
      updatedAt: persistedRecord.updatedAt,
      history: persistedRecord.history,
    }
    return NextResponse.json(response, { status: 201 })
  } catch (error) {
    if (error instanceof CompanyReturnRequestError) return NextResponse.json({ message: error.message }, { status: error.status })
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: 'Company return stock changes require MongoDB transaction support; no changes were applied' }, { status: 503 })
    console.error('Failed to create company return', error)
    return NextResponse.json({ message: 'Company return could not be saved' }, { status: 500 })
  }
}
