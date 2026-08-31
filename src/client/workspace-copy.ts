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

export const generationFailureCopy: Record<string, string> = {
  GENERATION_OUTPUT_LIMIT: '模型达到单次输出上限，尚未完成结果。推理也占用此上限。可用较短材料或较低推理档位新建任务。',
  GENERATION_NO_OUTPUT: '未收到可用的结构化结果。模型可能没有按格式返回，或在输出结果前已达到输出上限。',
  GENERATION_TIMEOUT: '本次提取等待超时，已停止。可用较短材料新建任务。',
  GENERATION_SCHEMA_INVALID: '模型返回的结果不符合提取格式，本次没有保存候选。',
  GENERATION_PROVIDER_ERROR: '模型调用未能正常完成，请检查模型配置和网络连接。',
}
