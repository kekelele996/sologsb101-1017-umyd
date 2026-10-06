/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑；v1 → v2 为 Piece 增加 craft 索引并回填默认值
 * - 提供各表增删改查、作品状态联动、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { GatherState, Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import { DEFAULT_HISTORY_GATHER_KG } from '../types/step'
import { nowIso } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

/** kg 运算保留 1 位小数，避免 0.1 累计误差影响余量比较 */
function roundKg(value: number): number {
  return Math.round(value * 10) / 10
}

/** 比较余量时容忍的浮点误差（kg） */
const KG_EPSILON = 1e-6

/** 取料道次的对账状态中，仍在熔化工对账队列里的两种状态 */
const PENDING_GATHER_STATES: GatherState[] = ['待记账', '待重交']

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt',
      batches: 'id, furnaceId, colorCode, meltDate',
      pieces: 'id, batchId, state, artist',
      steps: 'id, pieceId, [pieceId+seq], seq',
      anneals: 'id, pieceId, kilnSlot, state, inAt',
      inspects: 'id, pieceId, date, result',
    })

    // ---------- v2：Piece 增加 craft 索引并回填默认值，补齐其余索引与字段 ----------
    this.version(2)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // craft 为 v2 新增索引
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：Piece 补齐 craft 字段（历史作品默认按吹制归类）
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        // 迁移 3：历史工序默认视为已执行完成，避免升级后被误判为待办
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })
        // 迁移 4：退火记录补齐出炉时间与曲线段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        // 迁移 5：检验记录补齐缺陷说明
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：取料量与操作人记到作品的取料道次上，余量仍归批次台账 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        // 取料道次新增批次归属与对账状态索引，供熔化工按批次过账
        steps: 'id, pieceId, [pieceId+seq], seq, state, name, gatherBatchId, gatherState',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：全部行补齐 v3 修订号
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
          })
        }
        // 迁移 2：历史作品 → 取料道次的批次归属映射（道次按归属迁移，缺归属的作品留空串）
        const pieceRows = (await tx.table('pieces').toArray()) as Array<{ id?: unknown; batchId?: unknown }>
        const batchIdByPiece = new Map<string, string>(
          pieceRows.map((row) => [String(row.id), typeof row.batchId === 'string' ? row.batchId : '']),
        )
        // 迁移 3：旧数据没记取料量的道次按归属迁移，技师那份补历史默认；历史取料一律视为已记账
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (row.name !== '取料') {
            row.gatherKg = 0
            row.gatherBatchId = ''
            row.gatherAt = ''
            row.gatherState = ''
            return
          }
          row.gatherBatchId =
            typeof row.gatherBatchId === 'string' && row.gatherBatchId !== ''
              ? row.gatherBatchId
              : batchIdByPiece.get(String(row.pieceId)) ?? ''
          // 旧数据没记取料量：技师那份补历史默认值
          if (typeof row.gatherKg !== 'number' || !Number.isFinite(row.gatherKg) || row.gatherKg <= 0) {
            row.gatherKg = DEFAULT_HISTORY_GATHER_KG
          }
          if (typeof row.gatherAt !== 'string' || row.gatherAt === '') {
            row.gatherAt = typeof row.createdAt === 'string' ? row.createdAt : nowIso()
          }
          // 历史取料已经发生过，统一视为熔化工那本账已扣过，避免升级后重复扣余量
          row.gatherState = '已记账'
        })
      })
  }
}

export const db = new GlassBlowDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.furnaces.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await db.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  await db.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除窑炉：级联清理该窑下的料液批次 */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, async () => {
    await db.batches.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await db.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/** 按归属补齐取料道次的记账字段（导入旧版存档时同样适用），非取料道次清空取料字段 */
export function normalizeStep(row: Step): Step {
  if (row.name !== '取料') {
    return { ...row, gatherKg: 0, gatherBatchId: '', gatherAt: '', gatherState: '' }
  }
  return {
    ...row,
    gatherKg: typeof row.gatherKg === 'number' && Number.isFinite(row.gatherKg) && row.gatherKg > 0 ? row.gatherKg : 0,
    gatherBatchId: typeof row.gatherBatchId === 'string' ? row.gatherBatchId : '',
    gatherAt: typeof row.gatherAt === 'string' ? row.gatherAt : row.createdAt,
    gatherState: row.gatherState === '已记账' || row.gatherState === '待记账' || row.gatherState === '待重交' ? row.gatherState : '待记账',
  }
}

/** 取料对账结果：按侧恢复——熔化工侧只反映已过账的扣减，技师侧保留失败道次等重交 */
export interface GatherReconcileResult {
  /** 成功过账的取料道次 id（按取料先后） */
  postedStepIds: string[]
  /** 累计扣减的余量（kg） */
  deductedKg: number
  /** 第一个余量不足被退回的取料道次 id；没有则为 null */
  blockedStepId: string | null
  /** 被退回时批次剩余的余量（kg） */
  remainKg: number
}

/**
 * 熔化工按批次对账（技师取料账 → 熔化工余量账）。
 * 同一批次被多件作品取用时，按取料时间 gatherAt 先后（再按 createdAt）依次扣余量：
 * - 余量够：取料道次过账为「已记账」，熔化工余量照常扣减；
 * - 轮到某件余量不够：只把这一件退回为「待重交」（前面几件照旧，后面的留队等下轮）；
 * - 按侧恢复：熔化工已扣余量不回倒，技师这笔取料记录先留着等重交。
 * 整个过程在单个读写事务内完成，保证「先过账的不回滚」。
 */
export async function reconcileBatchGather(batchId: string): Promise<GatherReconcileResult> {
  return db.transaction('rw', db.batches, db.steps, async () => {
    const batch = await db.batches.get(batchId)
    if (batch === undefined) {
      return { postedStepIds: [], deductedKg: 0, blockedStepId: null, remainKg: 0 }
    }

    const queue = (await db.steps.where('gatherBatchId').equals(batchId).toArray())
      .map(normalizeStep)
      .filter((step) => PENDING_GATHER_STATES.includes(step.gatherState as GatherState))
      .sort((a, b) => a.gatherAt.localeCompare(b.gatherAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

    let remain = batch.remainKg
    const postedStepIds: string[] = []
    let blockedStepId: string | null = null
    const stamp = nowIso()

    for (const step of queue) {
      // 轮到哪件不够就只退回这一件：立即停止，前几件照旧，后续道次保持原状等下轮
      if (roundKg(remain) + KG_EPSILON < roundKg(step.gatherKg)) {
        blockedStepId = step.id
        await db.steps.update(step.id, { gatherState: '待重交', updatedAt: stamp })
        break
      }
      remain = roundKg(remain - step.gatherKg)
      postedStepIds.push(step.id)
      await db.steps.update(step.id, { gatherState: '已记账', updatedAt: stamp })
    }

    const deductedKg = roundKg(batch.remainKg - remain)
    if (postedStepIds.length > 0) {
      await db.batches.update(batchId, { remainKg: remain, updatedAt: stamp })
    }
    return { postedStepIds, deductedKg, blockedStepId, remainKg: remain }
  })
}

/**
 * 技师重交单笔取料：余额够则该道次单独过账并扣余量；不够则继续保留「待重交」，
 * 熔化工余量不往回倒。返回是否过账成功。
 */
export async function retryGatherStep(stepId: string): Promise<boolean> {
  return db.transaction('rw', db.batches, db.steps, async () => {
    const step = await db.steps.get(stepId)
    if (step === undefined || step.name !== '取料' || step.gatherBatchId === '') return false
    const batch = await db.batches.get(step.gatherBatchId)
    if (batch === undefined) return false
    // 待记账 / 待重交 才允许重交；已记账的不重复扣余量
    if (step.gatherState !== '待记账' && step.gatherState !== '待重交') return false
    if (roundKg(batch.remainKg) + KG_EPSILON < roundKg(step.gatherKg)) {
      await db.steps.update(stepId, { gatherState: '待重交', updatedAt: nowIso() })
      return false
    }
    const stamp = nowIso()
    await db.batches.update(batch.id, { remainKg: roundKg(batch.remainKg - step.gatherKg), updatedAt: stamp })
    await db.steps.update(stepId, { gatherState: '已记账', updatedAt: stamp })
    return true
  })
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除作品：级联清理工序、退火与检验记录 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.inspects, async () => {
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/**
 * 依工序与退火、检验记录推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await db.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await db.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await db.steps.put({ ...normalizeStep(row), updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeStep(id: string): Promise<void> {
  const step = await db.steps.get(id)
  if (!step) return
  await db.steps.delete(id)
  await syncPieceState(step.pieceId)
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.steps, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
    }
  })
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.anneals.delete(id)
  await syncPieceState(row.pieceId)
}

/** 推进退火状态；「已出炉」时写回出炉时间并同步作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row) return
  await db.anneals.update(annealId, { state: next, outAt: next === '已出炉' ? outAt : row.outAt, updatedAt: nowIso() })
  await syncPieceState(row.pieceId)
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.inspects.delete(id)
  await syncPieceState(row.pieceId)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  anneals: Anneal[]
  inspects: Inspect[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
  ])
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), furnaces, batches, pieces, steps, anneals, inspects }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects], async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
    ])
    await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
    // 旧版存档的取料道次可能缺取料字段，统一按归属补齐，不自动过账（不扣余量）
    await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...normalizeStep(row), revision: ROW_REVISION })))
    await db.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
  })
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects], async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
    ])
  })
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects }
}
