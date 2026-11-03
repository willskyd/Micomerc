import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from 'node:crypto'
import clientPromise from '@/lib/mongodb'
import {
  applyStockDelta,
  ensureCollections,
  InventoryError,
  isTransactionUnavailable,
  MOVEMENT_COLLECTION,
  parseDate,
  parseQuantity,
  readLowStockThreshold,
  recordStockMovement,
} from '@/lib/inventory'
import { NextResponse } from 'next/server'

const DB = MICOMERC_DB
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONDITIONS = ['New', 'Used', 'Damaged'] as const

class ReplacementRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function publicRecord(record: Record<string, any>) {
  const { _id, requestHash, appliedOperations, operationHashes, ...value } = record
  return value
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!UUID.test(id)) throw new ReplacementRequestError('Invalid company return ID', 400)

    let body: Record<string, unknown>
    try {
      const parsed: unknown = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ReplacementRequestError('Replacement receipt payload is required', 400)
      }
      body = parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof ReplacementRequestError) throw error
      throw new ReplacementRequestError('Request body must be valid JSON', 400)
    }

    if (body.action !== 'receive-replacement' || typeof body.operationId !== 'string' || !UUID.test(body.operationId)) {
      throw new ReplacementRequestError('A valid replacement receipt operation is required', 400)
    }
    if (!CONDITIONS.includes(body.condition as (typeof CONDITIONS)[number])) {
      throw new ReplacementRequestError('Choose a valid replacement product condition', 400)
    }

    const quantityReceived = parseQuantity(body.quantityReceived, 'Received quantity')
    const receivedDate = parseDate(body.receivedAt, 'Date received')
    const receivedAt = receivedDate.toISOString()
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : ''
    const condition = body.condition as (typeof CONDITIONS)[number]
    const requestHash = createHash('sha256').update(JSON.stringify({
      action: 'receive-replacement',
      quantityReceived,
      condition,
      notes,
      receivedAt,
    })).digest('hex')

    const client = await clientPromise()
    const db = client.db(DB)
    await ensureCollections(db, ['companyReturns', MOVEMENT_COLLECTION])
    const returns = db.collection<{ _id: string; [key: string]: any }>('companyReturns')
    let saved: Record<string, any> | null = null

    const session = client.startSession()
    try {
      await session.withTransaction(async () => {
        const companyReturn = await returns.findOne({ _id: id }, { session })
        if (!companyReturn) throw new ReplacementRequestError('Company return was not found', 404)

        const appliedOperations: string[] = companyReturn.appliedOperations ?? []
        if (appliedOperations.includes(body.operationId as string)) {
          if (companyReturn.operationHashes?.[body.operationId as string] !== requestHash) {
            throw new ReplacementRequestError('This operation ID was already used for a different replacement receipt', 409)
          }
          saved = companyReturn
          return
        }

        if (!['Awaiting Replacement', 'Partially Replaced'].includes(companyReturn.status)) {
          throw new ReplacementRequestError('This company return is not awaiting replacement goods', 409)
        }
        const outstandingQuantity = Number(companyReturn.outstandingQuantity)
        if (!Number.isFinite(outstandingQuantity) || quantityReceived > outstandingQuantity) {
          throw new ReplacementRequestError(`Received quantity exceeds the outstanding quantity (${Math.max(0, outstandingQuantity)})`, 409)
        }
        if (body.productId !== undefined && body.productId !== companyReturn.productId) {
          throw new ReplacementRequestError('Replacement product does not match the original company return', 409)
        }
        if (body.supplierName !== undefined && body.supplierName !== companyReturn.supplierName) {
          throw new ReplacementRequestError('Supplier does not match the original company return', 409)
        }
        if (body.originalReturnReference !== undefined && body.originalReturnReference !== companyReturn.reference) {
          throw new ReplacementRequestError('Original return reference does not match', 409)
        }

        const now = new Date().toISOString()
        const replacement = {
          id: body.operationId,
          supplierName: companyReturn.supplierName,
          originalReturnReference: companyReturn.reference,
          productId: companyReturn.productId,
          productName: companyReturn.productName,
          quantityReceived,
          receivedAt,
          condition,
          notes,
          createdAt: now,
        }
        const nextOutstanding = Math.round((outstandingQuantity - quantityReceived) * 1000) / 1000
        const replacements = [...(companyReturn.replacements ?? []), replacement]
        const history = [
          ...(companyReturn.history ?? []),
          {
            at: now,
            event: 'Replacement received',
            detail: `${quantityReceived} ${companyReturn.productName} units received from ${companyReturn.supplierName}`,
          },
        ]
        const updates = {
          totalReceived: Math.round((Number(companyReturn.totalReceived ?? 0) + quantityReceived) * 1000) / 1000,
          outstandingQuantity: nextOutstanding,
          status: nextOutstanding === 0 ? 'Fully Replaced' : 'Partially Replaced',
          replacements,
          history,
          updatedAt: now,
          appliedOperations: [...appliedOperations, body.operationId],
          operationHashes: { ...(companyReturn.operationHashes ?? {}), [body.operationId as string]: requestHash },
        }

        const product = await db.collection('products').findOne({ id: companyReturn.productId }, { session })
        if (!product) throw new ReplacementRequestError('Replacement product was not found', 409)
        const threshold = await readLowStockThreshold(db, session)
        await applyStockDelta(db.collection('products') as any, product as any, quantityReceived, threshold, session)
        await recordStockMovement(db, session, {
          id: `company-replacement:${id}:${body.operationId}`,
          productId: companyReturn.productId,
          delta: quantityReceived,
          type: 'company-replacement-inbound',
          sourceId: id,
          at: receivedDate,
          description: `Replacement receipt for ${companyReturn.reference} from ${companyReturn.supplierName}`,
        })

        const changed = await returns.updateOne(
          { _id: id, updatedAt: companyReturn.updatedAt, appliedOperations: { $ne: body.operationId } },
          { $set: updates },
          { session },
        )
        if (changed.matchedCount !== 1) {
          throw new ReplacementRequestError('Company return changed while recording the replacement receipt', 409)
        }
        saved = { ...companyReturn, ...updates }
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    } finally {
      await session.endSession()
    }

    if (!saved) throw new Error('Replacement receipt transaction completed without a record')
    return NextResponse.json(publicRecord(saved))
  } catch (error) {
    if (error instanceof ReplacementRequestError || error instanceof InventoryError) {
      const status = error instanceof ReplacementRequestError ? error.status : error.status
      return NextResponse.json({ message: error.message }, { status })
    }
    if (isTransactionUnavailable(error)) {
      return NextResponse.json({ message: 'Replacement receipt requires MongoDB transaction support; no changes were applied' }, { status: 503 })
    }
    console.error('Failed to record company replacement receipt', error)
    return NextResponse.json({ message: 'Replacement receipt could not be saved' }, { status: 500 })
  }
}
