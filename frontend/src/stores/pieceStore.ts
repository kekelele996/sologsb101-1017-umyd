/**
 * 作品与工序状态管理（Pinia）
 * 维护作品列表、当前作品与当前作品的工序；工序状态由 db.syncPieceState 联动作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Craft, Piece, PieceDraft, PieceState } from '../types/piece'
import type { Step, StepDraft } from '../types/step'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  db,
  initDatabase,
  putPiece,
  putStep,
  removePiece,
  removeStep,
  reorderSteps,
  retryGatherStep,
  syncPieceState,
} from '../utils/db'
import { buildStepProgress, type StepProgress } from '../hooks/useStepProgress'
import { nowIso, uuid } from '../utils/id'

/** 作品筛选条件 */
export interface PieceFilters {
  keyword: string
  craft: Craft | 'all'
  state: PieceState | 'all'
}

const EMPTY_FILTERS: PieceFilters = { keyword: '', craft: 'all', state: 'all' }

const CURRENT_PIECE_KEY = 'gbglassblow:currentPieceId'

function readCurrentPieceId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PIECE_KEY)
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

function writeCurrentPieceId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PIECE_KEY, id ?? '')
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

let subscribed = false

export const usePieceStore = defineStore('piece', () => {
  const pieces = ref<Piece[]>([])
  const steps = ref<Step[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const currentPieceId = ref<string | null>(readCurrentPieceId())
  const filters = reactive<PieceFilters>({ ...EMPTY_FILTERS })

  const currentPiece = computed<Piece | null>(
    () => pieces.value.find((row) => row.id === currentPieceId.value) ?? null
  )

  const visiblePieces = computed<Piece[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return pieces.value.filter((piece) => {
      if (filters.craft !== 'all' && piece.craft !== filters.craft) return false
      if (filters.state !== 'all' && piece.state !== filters.state) return false
      if (keyword === '') return true
      return (
        piece.name.toLowerCase().includes(keyword) ||
        piece.artist.toLowerCase().includes(keyword) ||
        piece.craft.toLowerCase().includes(keyword)
      )
    })
  })

  function stepsOf(pieceId: string): Step[] {
    return steps.value.filter((row) => row.pieceId === pieceId).sort((a, b) => a.seq - b.seq)
  }

  function progressOf(pieceId: string): StepProgress {
    return buildStepProgress(pieceId, steps.value)
  }

  const inProgressCount = computed<number>(
    () => pieces.value.filter((row) => row.state === '设计中' || row.state === '制作中').length
  )

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [pieceRows, stepRows] = await Promise.all([db.pieces.toArray(), db.steps.toArray()])
          return { pieceRows, stepRows }
        }).subscribe({
          next: ({ pieceRows, stepRows }) => {
            const sorted = [...pieceRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            pieces.value = sorted
            steps.value = [...stepRows].sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
            loading.value = false
            ready.value = true
            error.value = ''
            const stillExists =
              currentPieceId.value !== null && sorted.some((row) => row.id === currentPieceId.value)
            if (!stillExists) {
              selectPiece(sorted.length > 0 ? sorted[0].id : null)
            }
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取作品数据失败'
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

  function selectPiece(pieceId: string | null): void {
    currentPieceId.value = pieceId
    writeCurrentPieceId(pieceId)
  }

  function setFilters(patch: Partial<PieceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createPiece(draft: PieceDraft): Promise<Piece> {
    const stamp = nowIso()
    const row: Piece = {
      id: uuid('piece'),
      name: draft.name.trim() || '未命名作品',
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putPiece(row)
    selectPiece(row.id)
    revision.value += 1
    lastMessage.value = `已登记作品「${row.name}」，可继续录入吹制工序`
    return row
  }

  async function updatePiece(pieceId: string, draft: PieceDraft): Promise<void> {
    const existing = pieces.value.find((row) => row.id === pieceId)
    if (existing === undefined) return
    await putPiece({
      ...existing,
      name: draft.name.trim() || existing.name,
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
    })
    revision.value += 1
  }

  async function deletePiece(pieceId: string): Promise<void> {
    await removePiece(pieceId)
    if (currentPieceId.value === pieceId) selectPiece(null)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '作品及其工序、退火与检验记录已删除'
  }

  /* ------------------------------ 工序 ------------------------------ */

  /** 把表单草稿映射为工序行；非取料道次清空取料字段，取料道次先落「待记账」等熔化工对账 */
  function buildStepFromDraft(draft: StepDraft, stamp: string, id: string): Step {
    if (draft.name !== '取料') {
      return {
        id,
        pieceId: draft.pieceId,
        seq: draft.seq,
        name: draft.name,
        tempC: draft.tempC,
        durationMin: draft.durationMin,
        operator: draft.operator.trim(),
        remark: draft.remark.trim(),
        state: draft.state,
        gatherKg: 0,
        gatherBatchId: '',
        gatherAt: '',
        gatherState: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }
    }
    return {
      id,
      pieceId: draft.pieceId,
      seq: draft.seq,
      name: draft.name,
      tempC: draft.tempC,
      durationMin: draft.durationMin,
      operator: draft.operator.trim(),
      remark: draft.remark.trim(),
      state: draft.state,
      gatherKg: draft.gatherKg,
      gatherBatchId: draft.gatherBatchId,
      gatherAt: draft.gatherAt || stamp,
      // 技师这笔先挂「待记账」：熔化工按取料先后对账，过账后才扣余量
      gatherState: '待记账',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
  }

  async function createStep(draft: StepDraft): Promise<Step> {
    const stamp = nowIso()
    const row = buildStepFromDraft(draft, stamp, uuid('step'))
    await putStep(row)
    revision.value += 1
    return row
  }

  async function updateStep(stepId: string, draft: StepDraft): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    const stamp = nowIso()
    if (draft.name !== '取料') {
      await putStep({
        ...existing,
        seq: draft.seq,
        name: draft.name,
        tempC: draft.tempC,
        durationMin: draft.durationMin,
        operator: draft.operator.trim(),
        remark: draft.remark.trim(),
        state: draft.state,
        gatherKg: 0,
        gatherBatchId: '',
        gatherAt: '',
        gatherState: '',
      })
      revision.value += 1
      return
    }
    // 已记账的取料量 / 批次 / 时间是熔化工那本账的扣减凭据：保持不可变，只允许改登记信息
    const wasPosted = existing.gatherState === '已记账'
    await putStep({
      ...existing,
      seq: draft.seq,
      name: draft.name,
      tempC: draft.tempC,
      durationMin: draft.durationMin,
      operator: draft.operator.trim(),
      remark: draft.remark.trim(),
      state: draft.state,
      gatherKg: wasPosted ? existing.gatherKg : draft.gatherKg,
      gatherBatchId: wasPosted ? existing.gatherBatchId : draft.gatherBatchId,
      gatherAt: wasPosted ? existing.gatherAt : draft.gatherAt || stamp,
      // 未过账的编辑（待记账 / 待重交）保持原对账状态，由页面决定是否重新提交
      gatherState: wasPosted ? '已记账' : existing.gatherState === '' ? '待记账' : existing.gatherState,
    })
    revision.value += 1
  }

  /**
   * 技师提交单笔取料与熔化工批次台账对账：
   * 余量够 → 过账「已记账」并扣余量；余量不够 → 只退回这笔「待重交」，熔化工余量不回倒。
   * 返回结果供页面给出成功 / 失败提示。
   */
  async function submitGather(stepId: string): Promise<boolean> {
    const ok = await retryGatherStep(stepId)
    revision.value += 1
    const step = steps.value.find((row) => row.id === stepId)
    if (step !== undefined) {
      lastMessage.value = ok
        ? `第 ${step.seq} 道取料 ${step.gatherKg} kg 已提交记账，批次余量已扣减`
        : `第 ${step.seq} 道取料 ${step.gatherKg} kg 提交失败：批次余量不足，这笔先留着等重交，熔化工余量不回倒`
    }
    return ok
  }

  /** 「待重交」的取料补料后重交：余量够则过账，不够继续保留 */
  async function retryGather(stepId: string): Promise<boolean> {
    const ok = await retryGatherStep(stepId)
    revision.value += 1
    const step = steps.value.find((row) => row.id === stepId)
    if (step !== undefined) {
      lastMessage.value = ok
        ? `第 ${step.seq} 道取料已重交过账，批次余量已扣减`
        : `批次余量仍不足，第 ${step.seq} 道取料继续保留「待重交」等补料`
    }
    return ok
  }

  async function deleteStep(stepId: string): Promise<void> {
    await removeStep(stepId)
    revision.value += 1
    lastMessage.value = '工序已删除，作品状态已重新推导'
  }

  /** 推进工序状态：未开始 → 进行中 → 已完成 */
  async function advanceStep(stepId: string): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    const flow: Step['state'][] = ['未开始', '进行中', '已完成']
    const index = flow.indexOf(existing.state)
    if (index < 0 || index >= flow.length - 1) {
      lastMessage.value = '该工序已处于「已完成」状态'
      return
    }
    const next = flow[index + 1]
    await putStep({ ...existing, state: next })
    revision.value += 1
    const piece = pieces.value.find((row) => row.id === existing.pieceId)
    lastMessage.value = `第 ${existing.seq} 道「${existing.name}」已推进为「${next}」${
      piece === undefined ? '' : `（作品：${piece.name}）`
    }`
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveStepBefore(pieceId: string, fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return
    const list = stepsOf(pieceId)
    const fromIndex = list.findIndex((row) => row.id === fromId)
    const toIndex = list.findIndex((row) => row.id === toId)
    if (fromIndex < 0 || toIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    await reorderSteps(list.map((row) => row.id))
    revision.value += 1
    lastMessage.value = `已调整工序顺序：「${moved.name}」移动到第 ${toIndex + 1} 道`
  }

  /** 按序号升序重排（拖拽置顶/置底等场景） */
  async function moveStepToIndex(pieceId: string, stepId: string, targetIndex: number): Promise<void> {
    const list = stepsOf(pieceId)
    const fromIndex = list.findIndex((row) => row.id === stepId)
    if (fromIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    const index = Math.max(0, Math.min(list.length, targetIndex))
    list.splice(index, 0, moved)
    await reorderSteps(list.map((row) => row.id))
    revision.value += 1
    lastMessage.value = `已把「${moved.name}」调整到第 ${index + 1} 道`
  }

  /** 依工序与退火记录重新推导作品状态 */
  async function resyncPieceState(pieceId: string): Promise<void> {
    const next = await syncPieceState(pieceId)
    revision.value += 1
    if (next !== null) lastMessage.value = `作品状态已重新推导为「${next}」`
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    pieces,
    steps,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    currentPieceId,
    currentPiece,
    visiblePieces,
    inProgressCount,
    stepsOf,
    progressOf,
    loadAll,
    selectPiece,
    setFilters,
    resetFilters,
    createPiece,
    updatePiece,
    deletePiece,
    createStep,
    updateStep,
    deleteStep,
    submitGather,
    retryGather,
    advanceStep,
    moveStepBefore,
    moveStepToIndex,
    resyncPieceState,
    refreshCounts,
  }
})
