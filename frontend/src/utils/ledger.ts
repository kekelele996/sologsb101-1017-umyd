/**
 * 取料对账（两本账）纯函数
 * - 熔化工按料液批次记账：余量 remainKg 只在月底对账时扣减，且对账失败不回倒
 * - 技师按作品记取料：取料量与操作人落在作品的「取料」道次上，带入账状态
 * - 同一批次被多件作品取用时按取料先后扣余量；轮到哪件不够就只退回哪一件，其余照旧
 */
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import { round1 } from './thermal'

/** 历史取料道次未记取料量时的默认补录值（kg） */
export const LEGACY_DRAW_KG = 5

/**
 * 从备注文本解析取料量，如「取 G-101 料液约 6.2 kg」→ 6.2。
 * 兼容「6.2kg / 6.2 公斤 / 6.2 千克」写法；解析不到返回 null。
 */
export function parseDrawKgFromRemark(remark: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:kg|公斤|千克)/i.exec(remark)
  if (match === null) return null
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) && value > 0 ? round1(value) : null
}

/** 一笔待对账的取料（技师账视图） */
export interface PendingDraw {
  stepId: string
  pieceId: string
  /** 作品名（便于对账弹窗展示） */
  pieceName: string
  seq: number
  operator: string
  drawKg: number
  /** 取料时间（道次创建时间），取料先后的排序依据 */
  at: string
}

/** 对账预览行：在待对账取料之上标注该笔能否入账 */
export interface ReconcilePreviewRow extends PendingDraw {
  /** true = 余量够扣、将入账；false = 轮到该笔时余量不足、只退回这一笔 */
  ok: boolean
  /** 该笔处理后的批次余量（被退回时余量不变） */
  remainAfter: number
}

export interface ReconcilePreview {
  rows: ReconcilePreviewRow[]
  postedCount: number
  postedKg: number
  rejectedCount: number
  /** 全部处理完后的批次余量 */
  remainAfter: number
}

/** 按取料先后排序：取料时间 → 作品 → 道次序号，保证跨作品排序确定 */
export function sortDrawsByTime<T extends Pick<PendingDraw, 'at' | 'pieceId' | 'seq'>>(draws: T[]): T[] {
  return draws
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at) || a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

/**
 * 月底对账预览：按取料先后逐笔试扣余量。
 * 轮到哪件不够就只退回哪一件（ok = false），前面已入账的照旧，后续各笔继续独立判断。
 */
export function previewReconcile(remainKg: number, draws: PendingDraw[]): ReconcilePreview {
  let remain = remainKg
  let postedCount = 0
  let postedKg = 0
  let rejectedCount = 0
  const rows: ReconcilePreviewRow[] = sortDrawsByTime(draws).map((draw) => {
    const ok = draw.drawKg > 0 && remain >= draw.drawKg
    if (ok) {
      remain = round1(remain - draw.drawKg)
      postedCount += 1
      postedKg = round1(postedKg + draw.drawKg)
    } else {
      rejectedCount += 1
    }
    return { ...draw, ok, remainAfter: remain }
  })
  return { rows, postedCount, postedKg, rejectedCount, remainAfter: remain }
}

/**
 * 汇总某料液批次名下的待入账取料（跨作品）。
 * 归属链路：批次 ← 作品（piece.batchId）← 取料道次（step.pieceId，name = 取料）。
 */
export function pendingDrawsOfBatch(
  batchId: string,
  pieces: Array<Pick<Piece, 'id' | 'batchId' | 'name'>>,
  steps: Step[],
): PendingDraw[] {
  const pieceById = new Map(pieces.filter((row) => row.batchId === batchId).map((row) => [row.id, row]))
  return steps
    .filter(
      (row) =>
        row.name === '取料' &&
        row.drawState === '待入账' &&
        row.drawKg > 0 &&
        pieceById.has(row.pieceId),
    )
    .map((row) => ({
      stepId: row.id,
      pieceId: row.pieceId,
      pieceName: pieceById.get(row.pieceId)?.name ?? '（作品已删除）',
      seq: row.seq,
      operator: row.operator,
      drawKg: row.drawKg,
      at: row.createdAt,
    }))
}

/** 某件作品的取料道次合计（kg）；只统计取料道次，其余道次 drawKg 恒为 0 */
export function pieceDrawTotal(pieceId: string, steps: Step[]): number {
  return round1(
    steps.filter((row) => row.pieceId === pieceId && row.name === '取料').reduce((acc, row) => acc + row.drawKg, 0),
  )
}

/** 某件作品尚未入账（待入账 + 待重交）的取料合计（kg） */
export function pieceDrawPending(pieceId: string, steps: Step[]): number {
  return round1(
    steps
      .filter((row) => row.pieceId === pieceId && row.name === '取料' && row.drawState !== '已入账')
      .reduce((acc, row) => acc + row.drawKg, 0),
  )
}

/** 批次维度的待入账统计（台账列表展示用） */
export interface BatchPendingStat {
  count: number
  kg: number
}

export function pendingStatOfBatch(
  batchId: string,
  pieces: Array<Pick<Piece, 'id' | 'batchId' | 'name'>>,
  steps: Step[],
): BatchPendingStat {
  const draws = pendingDrawsOfBatch(batchId, pieces, steps)
  return { count: draws.length, kg: round1(draws.reduce((acc, row) => acc + row.drawKg, 0)) }
}

/** 对账结果汇总文案 */
export function reconcileMessage(batch: GlassBatch, postedCount: number, postedKg: number, rejectedCount: number): string {
  const base = `对账完成：${batch.colorCode} 入账 ${postedCount} 笔共 ${postedKg} kg，余量 ${batch.remainKg} kg`
  return rejectedCount === 0
    ? base
    : `${base}；退回 ${rejectedCount} 笔（余量不足），已保留在技师工序上等待重交，余量不回倒`
}
