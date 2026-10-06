/**
 * 窑炉与料液状态管理（Pinia）
 * 维护窑炉列表、料液批次及剩余量；取料由技师记在作品的「取料」道次上，
 * 月底对账时按取料先后扣减批次余量，低于阈值高亮提示补料。
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
  reconcileBatchDraws,
  removeBatch,
  removeFurnace,
  type ReconcileResult,
} from '../utils/db'
import { pendingDrawsOfBatch, reconcileMessage, type PendingDraw } from '../utils/ledger'
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
  const pieces = ref<{ id: string; batchId: string; name: string }[]>([])
  const steps = ref<Step[]>([])
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

  /** 全部待入账取料笔数（跨批次汇总，用于顶部统计） */
  const pendingDrawCount = computed<number>(() =>
    batches.value.reduce((acc, batch) => acc + pendingDrawsOf(batch.id).length, 0),
  )

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
            pieces.value = pieceRows.map((row) => ({ id: row.id, batchId: row.batchId, name: row.name }))
            steps.value = stepRows
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

  /** 某批次名下的待入账取料（技师账，跨作品，未排序） */
  function pendingDrawsOf(batchId: string): PendingDraw[] {
    return pendingDrawsOfBatch(batchId, pieces.value, steps.value)
  }

  /**
   * 月底对账：按取料先后扣余量；轮到哪件不够就只退回那一件（留在技师账上等重交），
   * 前面已入账的照旧，熔化工的余量不往回倒。
   */
  async function reconcile(batchId: string): Promise<ReconcileResult | null> {
    const result = await reconcileBatchDraws(batchId)
    revision.value += 1
    const batch = batches.value.find((row) => row.id === batchId)
    if (result !== null && batch !== undefined) {
      lastMessage.value = reconcileMessage(
        { ...batch, remainKg: result.remainKg },
        result.postedCount,
        result.postedKg,
        result.rejectedCount,
      )
    }
    return result
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
    pendingDrawCount,
    stats,
    visibleFurnaces,
    statOf,
    batchesOf,
    loadAll,
    setFilters,
    resetFilters,
    createFurnace,
    updateFurnace,
    deleteFurnace,
    createBatch,
    updateBatch,
    deleteBatch,
    pendingDrawsOf,
    reconcile,
    refill,
    refreshCounts,
  }
})
