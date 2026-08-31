// Shared wording for connection recovery and review outcomes. Reconnecting never
// starts extraction; only an explicit import/retry can request a model call.
export const workspaceCopy = {
  unavailable: '暂时无法连接 BetterLearn，请稍后再试。',
  reconnect: '重新连接',
  reconnectDetail: '重新连接会读取已保存的进度，不会重新提取或调用模型。',
  operationFailed: '暂时无法完成操作，请重试。',
  reviewUnconfirmed: '审核状态尚未同步，请重新连接以确认结果。',
  reviewSaved: '审核结果已保存。',
  reviewRecovered: '审核结果已恢复。',
  reviewChanged: '候选状态已变化，已重新加载。',
  reviewExpired: '未能恢复上次审核，请重新确认此候选。',
} as const
