import type { ApiProvider, TaskParams, TaskRecord } from '../types'

type TaskLifecyclePatch = Pick<TaskRecord, 'status' | 'error' | 'finishedAt' | 'elapsed'>
type ActualParams = Partial<TaskParams>
type ImageSize = { width?: number; height?: number }

export function createTaskDonePatch(task: Pick<TaskRecord, 'createdAt' | 'startedAt'>, now: number): TaskLifecyclePatch {
  return {
    status: 'done',
    error: null,
    finishedAt: now,
    elapsed: now - (task.startedAt ?? task.createdAt),
  }
}

export function createTaskErrorPatch(task: Pick<TaskRecord, 'createdAt' | 'startedAt'>, error: string, now: number): TaskLifecyclePatch {
  return {
    status: 'error',
    error,
    finishedAt: now,
    elapsed: now - (task.startedAt ?? task.createdAt),
  }
}

export function markInterruptedOpenAIRunningTasks(tasks: TaskRecord[], now: number) {
  const interruptedTasks: TaskRecord[] = []
  const updatedTasks = tasks.map((task) => {
    const isOpenAITask = (task.apiProvider ?? 'openai') !== 'fal'
    if (task.status !== 'running' || !isOpenAITask || task.customTaskId) return task

    const updated: TaskRecord = {
      ...task,
      ...(task.outputImages.length
        ? {
            ...createTaskDonePatch(task, now),
            completionError: [task.completionError, '生成中断，已完成图片已保留；可补齐剩余图片。'].filter(Boolean).join('\n'),
            outputErrors: task.outputErrors?.length ? task.outputErrors : Array.from({ length: Math.max(0, task.params.n - task.outputImages.length) }, (_, index) => ({ requestIndex: task.outputImages.length + index, error: '请求中断，尚未完成。' })),
          }
        : createTaskErrorPatch(task, '请求中断', now)),
      falRecoverable: false,
      elapsed: Math.max(0, now - (task.startedAt ?? task.createdAt)),
    }
    interruptedTasks.push(updated)
    return updated
  })

  return { tasks: updatedTasks, interruptedTasks }
}

export function hasActualParams(params: ActualParams | undefined): params is ActualParams {
  return Boolean(params && Object.keys(params).length > 0)
}

export function firstActualParams(paramsList: Array<ActualParams | undefined> | undefined): ActualParams | undefined {
  return paramsList?.find(hasActualParams)
}

export function mapActualParamsByImage(outputIds: string[], paramsList: Array<ActualParams | undefined> | undefined) {
  const mapped = paramsList?.reduce<Record<string, ActualParams>>((acc, params, index) => {
    const imgId = outputIds[index]
    if (imgId && hasActualParams(params)) acc[imgId] = params
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}

export function hasActualSizeParam(params: ActualParams | undefined) {
  return Boolean(params?.size)
}

export function addImageSizeParam(params: ActualParams | undefined, size: ImageSize | undefined): ActualParams | undefined {
  if (hasActualSizeParam(params) || !size?.width || !size.height) return params
  return { ...(params ?? {}), size: `${size.width}x${size.height}` }
}

export function deriveAgentImageActualParams(params: ActualParams | undefined, size: ImageSize | undefined): ActualParams {
  return {
    ...(addImageSizeParam(hasActualParams(params) ? params : undefined, size) ?? {}),
    n: 1,
  }
}

export function deriveGalleryActualParams(
  provider: ApiProvider,
  isAsyncCustomTask: boolean,
  resultParams: ActualParams | undefined,
  paramsList: Array<ActualParams | undefined> | undefined,
  outputCount: number,
): ActualParams | undefined {
  if (provider === 'fal' || isAsyncCustomTask) return firstActualParams(paramsList)
  const firstParams = firstActualParams(paramsList)
  return {
    ...resultParams,
    size: resultParams?.size ?? firstParams?.size,
    n: outputCount,
  }
}

export function mapRevisedPromptsByImage(outputIds: string[], revisedPrompts: Array<string | undefined> | undefined) {
  const mapped = revisedPrompts?.reduce<Record<string, string>>((acc, prompt, index) => {
    const imgId = outputIds[index]
    if (imgId && prompt?.trim()) acc[imgId] = prompt
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}

export function getTaskRetryImageCount(task: Pick<TaskRecord, 'params' | 'outputImages' | 'outputErrors'>): number {
  if (!task.outputImages.length || !task.outputErrors?.length) return task.params.n
  return new Set(task.outputErrors.map((item) => item.requestIndex)).size
}

export function getTaskRetryLabel(task: Pick<TaskRecord, 'params' | 'outputImages' | 'outputErrors'>): string {
  return task.outputImages.length && task.outputErrors?.length
    ? `补齐剩余${getTaskRetryImageCount(task)}张`
    : '重试任务'
}

export function getTaskRetryAction(task: TaskRecord, tasks: TaskRecord[]): { task: TaskRecord; label: string; disabled: boolean } {
  const visited = new Set<string>()
  let current = task
  while (true) {
    if (visited.has(current.id)) return { task: current, label: '补齐任务关联异常', disabled: true }
    visited.add(current.id)
    const children = tasks.filter((item) => item.retryOfTaskId === current.id)
    const latest = children.reduce<TaskRecord | undefined>((selected, item) =>
      !selected || (item.startedAt ?? item.createdAt) > (selected.startedAt ?? selected.createdAt) ? item : selected,
    undefined)
    if (!latest) break
    current = latest
  }
  const isContinuation = Boolean(current.retryOfTaskId) || current.id !== task.id
  if (current.status === 'running' || current.falRecoverable || current.customRecoverable) {
    return { task: current, label: isContinuation ? '正在补齐图片' : '正在生成图片', disabled: true }
  }
  if (isContinuation && current.status === 'done' && !current.outputErrors?.length) {
    return { task: current, label: '补齐已完成', disabled: true }
  }
  return {
    task: current,
    label: isContinuation ? `补齐剩余${getTaskRetryImageCount(current)}张` : getTaskRetryLabel(current),
    disabled: false,
  }
}
