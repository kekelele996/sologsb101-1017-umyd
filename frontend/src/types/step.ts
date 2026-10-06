/**
 * 吹制工序（Step）
 * 逐道记录温度、时长与操作人；任一前序未完成则阻断进入退火排位。
 * 「取料」道次额外记录取料量与入账状态（技师账），月底与熔化工的批次余量对账。
 */

/** 工序名称 */
export type StepName = '取料' | '吹制' | '塑形' | '开模' | '收口'

/** 工序执行状态 */
export type StepState = '未开始' | '进行中' | '已完成'

/**
 * 取料入账状态（技师那本账）：
 * 待入账 = 技师已登记、尚未与熔化工对账；已入账 = 对账时已从批次余量扣减；
 * 待重交 = 对账时余量不足被退回，留在技师账上等修改后重新提交。
 * 非「取料」道次无取料概念，恒为「已入账」占位。
 */
export type DrawState = '待入账' | '已入账' | '待重交'

export const STEP_NAME_OPTIONS: StepName[] = ['取料', '吹制', '塑形', '开模', '收口']
export const STEP_STATE_OPTIONS: StepState[] = ['未开始', '进行中', '已完成']
export const DRAW_STATE_OPTIONS: DrawState[] = ['待入账', '已入账', '待重交']

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
  /** 操作人 */
  operator: string
  /** 备注 */
  remark: string
  /** 工序状态 */
  state: StepState
  /** 取料量（kg）：仅「取料」道次有意义，其余道次为 0 */
  drawKg: number
  /** 取料入账状态（技师账）；非「取料」道次恒为「已入账」 */
  drawState: DrawState
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
  /** 取料量（kg），仅「取料」道次需要填写 */
  drawKg: number
}
