/**
 * 吹制工序（Step）
 * 逐道记录温度、时长与操作人；任一前序未完成则阻断进入退火排位。
 *
 * 取料道次（name = '取料'）同时是技师侧的取料账：
 * - gatherKg 记录取料量、gatherBatchId 记录料液归属、gatherAt 记录取料时间；
 * - gatherState 跟踪与熔化工批次台账的对账状态（待记账 → 已记账 / 待重交）。
 * 熔化工侧的余量始终只存在 GlassBatch.remainKg 上，对账失败不回倒。
 */

/** 工序名称 */
export type StepName = '取料' | '吹制' | '塑形' | '开模' | '收口'

/** 工序执行状态 */
export type StepState = '未开始' | '进行中' | '已完成'

/** 取料对账状态（仅取料道次使用） */
export type GatherState = '待记账' | '已记账' | '待重交'

export const STEP_NAME_OPTIONS: StepName[] = ['取料', '吹制', '塑形', '开模', '收口']
export const STEP_STATE_OPTIONS: StepState[] = ['未开始', '进行中', '已完成']
export const GATHER_STATE_OPTIONS: GatherState[] = ['待记账', '已记账', '待重交']

/** 历史取料道次未记取料量时，迁移补填的技师侧历史默认值（kg） */
export const DEFAULT_HISTORY_GATHER_KG = 5

/** 取料对账状态的展示元信息 */
export const GATHER_STATE_META: Record<GatherState, { label: string; tone: 'info' | 'success' | 'danger' }> = {
  待记账: { label: '待记账', tone: 'info' },
  已记账: { label: '已记账', tone: 'success' },
  待重交: { label: '待重交', tone: 'danger' },
}

export interface Step {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 工序序号，从 1 开始 */
  seq: number
  /** 工序名称 */
  name: StepName
  /** 工序温度（℃） */
  tempC: number
  /** 时长（分钟） */
  durationMin: number
  /** 操作人（取料道次即取料技师） */
  operator: string
  /** 备注 */
  remark: string
  /** 工序状态 */
  state: StepState
  /** 取料量（kg），仅 name='取料' 时有意义 */
  gatherKg: number
  /** 取料归属的料液批次；仅 name='取料' 时有意义，空串表示归属缺失 */
  gatherBatchId: string
  /** 取料时间（ISO 或 YYYY-MM-DDTHH:mm），对账按此时间先后扣余量；仅取料道次 */
  gatherAt: string
  /** 取料对账状态；非取料道次固定为 '' */
  gatherState: GatherState | ''
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑吹制工序的表单草稿 */
export interface StepDraft {
  pieceId: string
  seq: number
  name: StepName
  tempC: number
  durationMin: number
  operator: string
  remark: string
  state: StepState
  /** 取料量（kg），仅取料道次需要 */
  gatherKg: number
  /** 取料归属的料液批次，仅取料道次需要 */
  gatherBatchId: string
  /** 取料时间，仅取料道次需要 */
  gatherAt: string
}
