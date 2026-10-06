/**
 * 窑炉与料液状态管理（Pinia）
 * 维护窑炉列表、料液批次余量与作品取料道次。
 * 取料量记在作品的取料道次上，余量仍归熔化工批次台账；
 * 对账按取料先后扣余量，不够的只退回这一件（待重交），熔化工余量不回倒。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Furnace, FurnaceDraft, FurnaceState, FurnaceType } from '../types/furnace'
import type { GlassBatch, GlassBatchDraft } from '../types/batch'
import type { Step } from '../types/step'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  db,
  initDatabase,
  putBatch,
  putFurnace,
  reconcileBatchGather,
  removeBatch,
  removeFurnace,
  retryGatherStep,
  type GatherReconcileResult,
} from '../utils/db'
import { isLowRemain } from '../utils/thermal'
import { nowIso, uuid } from '../utils/id'

/** 窑炉筛选条件 */
export interface FurnaceFilters {
  keyword: string
  type: FurnaceType | 'all'
  state: FurnaceState | 'all'
}

/** 单台窑炉的派生统计 */
export interface FurnaceStat {
  furnaceId: string
  batchCount: number
  totalRemainKg: number
  lowCount: number
  /** 关联作品数（通过料液批次反查） */
  pieceCount: number
}

/** 取料道次在对账面板中的行视图（关联作品名 / 色号等） */
export interface GatherLedgerRow {
  step: Step
  pieceName: string
  artist: string
  colorCode: string
}

/** 单个批次的取料台账派生数据 */
export interface BatchGatherLedger {
  /** 待过账（待记账 + 待重交），按取料时间先后排队 */
  pending: GatherLedgerRow[]
  /** 已记账（熔化工余量已扣） */
  posted: GatherLedgerRow[]
  /** 待重交道次数（pending 中对账失败被退回的部分） */
  retryCount: number
  /** 已记账取料量合计（kg，技师账） */
  postedKg: number
  /** 待过账取料量合计（kg） */
  pendingKg: number
}

const EMPTY_FILTERS: FurnaceFilters = { keyword: '', type: 'all', state: 'all' }

const EMPTY_STAT: Omit<FurnaceStat, 'furnaceId'> = {
  batchCount: 0,
  totalRemainKg: 0,
  lowCount: 0,
  pieceCount: 0,
}

let subscribed = false

export const useFurnaceStore = defineStore('furnace', () => {
  const furnaces = ref<Furnace[]>([])
  const batches = ref<GlassBatch[]>([])
  const pieces = ref<{ id: string; batchId: string; name: string; artist: string }[]>([])
  const gatherSteps = ref<Step[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<FurnaceFilters>({ ...EMPTY_FILTERS })

  const meltingFurnaces = computed<Furnace[]>(() =>
    furnaces.value.filter((row) => row.type === '熔化炉' || row.type === '坩埚炉')
  )
  const annealingFurnaces = computed<Furnace[]>(() => furnaces.value.filter((row) => row.type === '退火窑'))
  const lowRemainBatches = computed<GlassBatch[]>(() => batches.value.filter((row) => isLowRemain(row.remainKg)))

  const stats = computed<Record<string, FurnaceStat>>(() => {
    const result: Record<string, FurnaceStat> = {}
    furnaces.value.forEach((furnace) => {
      const list = batches.value.filter((row) => row.furnaceId === furnace.id)
      const batchIds = new Set(list.map((row) => row.id))
      result[furnace.id] = {
        furnaceId: furnace.id,
        batchCount: list.length,
        totalRemainKg: Math.round(list.reduce((acc, row) => acc + row.remainKg, 0) * 10) / 10,
        lowCount: list.filter((row) => isLowRemain(row.remainKg)).length,
        pieceCount: pieces.value.filter((row) => batchIds.has(row.batchId)).length,
      }
    })
    return result
  })

  const visibleFurnaces = computed<Furnace[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return furnaces.value.filter((furnace) => {
      if (filters.type !== 'all' && furnace.type !== filters.type) return false
      if (filters.state !== 'all' && furnace.state !== filters.state) return false
      if (keyword === '') return true
      return (
        furnace.code.toLowerCase().includes(keyword) ||
        furnace.type.toLowerCase().includes(keyword) ||
        furnace.fuelType.toLowerCase().includes(keyword)
      )
    })
  })

  function statOf(furnaceId: string): FurnaceStat {
    return stats.value[furnaceId] ?? { furnaceId, ...EMPTY_STAT }
  }

  function batchesOf(furnaceId: string): GlassBatch[] {
    return batches.value.filter((row) => row.furnaceId === furnaceId)
  }

  /** 作品名 / 创作者映射，供取料台账展示 */
  const pieceInfoById = computed<Record<string, { name: string; artist: string }>>(() =>
    Object.fromEntries(pieces.value.map((row) => [row.id, { name: row.name, artist: row.artist }])),
  )

  function colorOf(batchId: string): string {
    return batches.value.find((row) => row.id === batchId)?.colorCode ?? '未知色号'
  }

  /**
   * 某批次的取料台账：
   * 待过账队列（待记账 + 待重交）按取料先后排队；已记账为熔化工已扣余量的部分。
   */
  function gatherLedgerOf(batchId: string): BatchGatherLedger {
    const rows = gatherSteps.value
      .filter((step) => step.gatherBatchId === batchId)
      .sort(
        (a, b) =>
          a.gatherAt.localeCompare(b.gatherAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      )
    const toRow = (step: Step): GatherLedgerRow => ({
      step,
      pieceName: pieceInfoById.value[step.pieceId]?.name ?? '（作品已删除）',
      artist: pieceInfoById.value[step.pieceId]?.artist ?? step.operator,
      colorCode: colorOf(step.gatherBatchId),
    })
    const pending = rows
      .filter((step) => step.gatherState === '待记账' || step.gatherState === '待重交')
      .map(toRow)
    const posted = rows.filter((step) => step.gatherState === '已记账').map(toRow)
    const sumKg = (list: GatherLedgerRow[]): number =>
      Math.round(list.reduce((acc, row) => acc + row.step.gatherKg, 0) * 10) / 10
    return {
      pending,
      posted,
      retryCount: pending.filter((row) => row.step.gatherState === '待重交').length,
      postedKg: sumKg(posted),
      pendingKg: sumKg(pending),
    }
  }

  /** 全工作室待过账取料道次数（顶部徽标） */
  const pendingGatherCount = computed<number>(
    () => gatherSteps.value.filter((step) => step.gatherState === '待记账' || step.gatherState === '待重交').length,
  )

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [furnaceRows, batchRows, pieceRows, stepRows] = await Promise.all([
            db.furnaces.toArray(),
            db.batches.toArray(),
            db.pieces.toArray(),
            db.steps.toArray(),
          ])
          return { furnaceRows, batchRows, pieceRows, stepRows }
        }).subscribe({
          next: ({ furnaceRows, batchRows, pieceRows, stepRows }) => {
            furnaces.value = [...furnaceRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            batches.value = [...batchRows].sort((a, b) => b.meltDate.localeCompare(a.meltDate))
            pieces.value = pieceRows.map((row) => ({ id: row.id, batchId: row.batchId, name: row.name, artist: row.artist }))
            gatherSteps.value = stepRows
              .filter((row) => row.name === '取料')
              .sort((a, b) => a.gatherAt.localeCompare(b.gatherAt) || a.createdAt.localeCompare(b.createdAt))
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取窑炉数据失败'
            loading.value = false
          },
        })
      }
      await refreshCounts()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<FurnaceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createFurnace(draft: FurnaceDraft): Promise<Furnace> {
    const stamp = nowIso()
    const row: Furnace = {
      id: uuid('furnace'),
      code: draft.code.trim() || '未编号窑炉',
      type: draft.type,
      maxTempC: draft.maxTempC,
      fuelType: draft.fuelType,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putFurnace(row)
    revision.value += 1
    lastMessage.value =
      row.type === '退火窑' ? `已新建退火窑「${row.code}」，窑位已进入窑位池` : `已新建窑炉「${row.code}」，可挂料液批次`
    return row
  }

  async function updateFurnace(furnaceId: string, draft: FurnaceDraft): Promise<void> {
    const existing = furnaces.value.find((row) => row.id === furnaceId)
    if (existing === undefined) return
    await putFurnace({
      ...existing,
      code: draft.code.trim() || existing.code,
      type: draft.type,
      maxTempC: draft.maxTempC,
      fuelType: draft.fuelType,
      state: draft.state,
    })
    revision.value += 1
  }

  async function deleteFurnace(furnaceId: string): Promise<void> {
    await removeFurnace(furnaceId)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '窑炉及其料液批次已删除'
  }

  async function createBatch(draft: GlassBatchDraft): Promise<GlassBatch> {
    const stamp = nowIso()
    const row: GlassBatch = {
      id: uuid('batch'),
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || '未命名色号',
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      remainKg: draft.remainKg,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putBatch(row)
    revision.value += 1
    return row
  }

  async function updateBatch(batchId: string, draft: GlassBatchDraft): Promise<void> {
    const existing = batches.value.find((row) => row.id === batchId)
    if (existing === undefined) return
    await putBatch({
      ...existing,
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || existing.colorCode,
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      remainKg: draft.remainKg,
    })
    revision.value += 1
  }

  async function deleteBatch(batchId: string): Promise<void> {
    await removeBatch(batchId)
    revision.value += 1
  }

  /**
   * 熔化工按月对账：同一批次被多件作品取用时，按取料先后扣余量。
   * 轮到哪件不够就只退回这一件（待重交），前面几件照旧；熔化工余量不回倒。
   */
  async function reconcile(batchId: string): Promise<GatherReconcileResult> {
    const result = await reconcileBatchGather(batchId)
    revision.value += 1
    const batch = batches.value.find((row) => row.id === batchId)
    if (batch !== undefined) {
      if (result.postedStepIds.length > 0) {
        lastMessage.value = `${batch.colorCode} 对账过账 ${result.postedStepIds.length} 笔，扣减 ${result.deductedKg} kg，剩余 ${result.remainKg} kg`
      } else if (result.blockedStepId !== null) {
        lastMessage.value = `${batch.colorCode} 余量仅 ${result.remainKg} kg，本笔取料不足，已退回该件为「待重交」，熔化工余量不回倒`
      } else {
        lastMessage.value = `${batch.colorCode} 没有待过账的取料道次`
      }
    }
    return result
  }

  /** 技师重交单笔取料：余额够才过账扣余量，不够继续留「待重交」等补料 */
  async function retryStep(stepId: string): Promise<boolean> {
    const ok = await retryGatherStep(stepId)
    revision.value += 1
    const step = gatherSteps.value.find((row) => row.id === stepId)
    if (step !== undefined) {
      lastMessage.value = ok
        ? `取料 ${step.gatherKg} kg 已重交过账，${colorOf(step.gatherBatchId)} 余量已扣减`
        : `${colorOf(step.gatherBatchId)} 余量仍不足，取料记录保留「待重交」，熔化工余量不回倒`
    }
    return ok
  }

  /** 补料：直接增加剩余量 */
  async function refill(batchId: string, kg: number): Promise<void> {
    const batch = batches.value.find((row) => row.id === batchId)
    if (batch === undefined) return
    await putBatch({ ...batch, remainKg: Math.round((batch.remainKg + kg) * 10) / 10 })
    revision.value += 1
    lastMessage.value = `已为 ${batch.colorCode} 补料 ${kg} kg`
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    furnaces,
    batches,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    meltingFurnaces,
    annealingFurnaces,
    lowRemainBatches,
    pendingGatherCount,
    stats,
    visibleFurnaces,
    statOf,
    batchesOf,
    gatherLedgerOf,
    loadAll,
    setFilters,
    resetFilters,
    createFurnace,
    updateFurnace,
    deleteFurnace,
    createBatch,
    updateBatch,
    deleteBatch,
    reconcile,
    retryStep,
    refill,
    refreshCounts,
  }
})
