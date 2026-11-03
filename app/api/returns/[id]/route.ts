import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from 'node:crypto'
import clientPromise from '@/lib/mongodb'
import { applyStockDelta, ensureCollections, isTransactionUnavailable, MOVEMENT_COLLECTION, readLowStockThreshold, recordStockMovement } from '@/lib/inventory'
import type { ClientSession } from 'mongodb'
import { NextResponse } from 'next/server'

const DB = MICOMERC_DB
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
class ReturnConflict extends Error {}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    if (!UUID.test(id) || !body || typeof body !== 'object' || typeof body.operationId !== 'string' || !UUID.test(body.operationId)) return NextResponse.json({ message: 'Invalid return update' }, { status: 400 })
    const client = await clientPromise()
    const db = client.db(DB)
    await ensureCollections(db, ['returns', MOVEMENT_COLLECTION])
    const returns = db.collection<{ _id: string; [key: string]: any }>('returns')
    const operationHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const session: ClientSession = client.startSession()
    let response: Record<string, any> | null = null
    try {
      await session.withTransaction(async () => {
        const returnRecord = await returns.findOne({ _id: id }, { session })
        if (!returnRecord) throw new ReturnConflict('Return not found')
        if ((returnRecord.appliedOperations ?? []).includes(body.operationId)) {
          if (returnRecord.operationHashes?.[body.operationId] !== operationHash) throw new ReturnConflict('This operation ID was already used for a different return action')
          response = returnRecord; return
        }
        const action = body.action
        const now = new Date().toISOString()
        const history = [...(returnRecord.history ?? [])]
        const updates: Record<string, unknown> = { updatedAt: now, appliedOperations: [...(returnRecord.appliedOperations ?? []), body.operationId], operationHashes: { ...(returnRecord.operationHashes ?? {}), [body.operationId]: operationHash } }
        if (action === 'approve' && returnRecord.status === 'pending-review') {
          updates.status = 'approved'; history.push({ at: now, event: 'Return approved', detail: 'Approved for next steps' })
        } else if (action === 'reject' && returnRecord.status === 'pending-review') {
          updates.status = 'rejected'; history.push({ at: now, event: 'Return rejected', detail: String(body.note ?? '').slice(0, 500) })
        } else if (action === 'inspect' && returnRecord.status === 'approved' && ['sellable', 'damaged', 'quarantined'].includes(body.condition)) {
          updates.inspectionStatus = body.condition; history.push({ at: now, event: 'Inspection recorded', detail: String(body.condition) })
        } else if (action === 'confirm-refund' && returnRecord.status === 'approved' && returnRecord.refundStatus === 'pending' && body.confirmed === true && typeof body.refundReference === 'string' && body.refundReference.trim().length > 0) {
          updates.refundStatus = 'completed'; updates.refundedAt = now; updates.refundReference = body.refundReference.trim().slice(0, 120); history.push({ at: now, event: 'Refund confirmed as processed', detail: `Amount ${returnRecord.amountMinor} minor units · ${updates.refundReference}` })
        } else if (action === 'restock' && returnRecord.status === 'approved' && returnRecord.inventoryStatus === 'not-restocked' && body.confirmed === true) {
          const sellable = (returnRecord.items ?? []).filter((item: { condition: string }) => item.condition === 'sellable' && returnRecord.inspectionStatus === 'sellable')
          if (!sellable.length) throw new ReturnConflict('Only inspected sellable items can be restocked')
          const threshold = await readLowStockThreshold(db, session)
          for (const item of sellable) {
            const product = await db.collection('products').findOne({ id: item.productId }, { session })
            if (!product) throw new ReturnConflict(`Product ${item.productId} no longer exists`)
            await applyStockDelta(db.collection('products') as any, product as any, Number(item.quantity), threshold, session)
            await recordStockMovement(db, session, { id: `return:${id}:${item.productId}`, productId: item.productId, delta: Number(item.quantity), type: 'return-restock', sourceId: id, at: new Date(now), description: `Restocked inspected sellable return ${returnRecord.reference}` })
          }
          updates.inventoryStatus = 'restocked'; updates.restockedAt = now; history.push({ at: now, event: 'Sellable items restocked', detail: `${sellable.length} item line(s)` })
        } else {
          throw new ReturnConflict('This return transition is not allowed from its current state')
        }
        updates.history = history
        const changed = await returns.updateOne({ _id: id, updatedAt: returnRecord.updatedAt, appliedOperations: { $ne: body.operationId } }, { $set: updates }, { session })
        if (changed.matchedCount !== 1) throw new ReturnConflict('Return changed while this operation was being reviewed')
        response = await returns.findOne({ _id: id }, { session })
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    } finally { await session.endSession() }
    return NextResponse.json(response)
  } catch (error) {
    if (error instanceof ReturnConflict) return NextResponse.json({ message: error.message }, { status: 409 })
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: 'Return stock changes require MongoDB transaction support; no changes were applied' }, { status: 503 })
    console.error('Failed to update return', error)
    return NextResponse.json({ message: 'Return update failed' }, { status: 500 })
  }
}
