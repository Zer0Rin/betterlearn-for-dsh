import type { EvidenceSpan, KnowledgePointSnapshot, KnowledgePointType } from './types.js'

export type LearningPreviewDelivery = 'current' | 'upcoming'

export type LearningPreviewEvidence = {
  kind: 'quote'
  quote: string
  contextBefore: string
  contextAfter: string
  textStart: number
  textEnd: number
} | {
  kind: 'summary'
  text: string
}

export interface LearningPreviewOption {
  optionId: 'evidence-backed' | 'detached' | 'transfer' | 'surface-match'
  label: string
}

export interface LearningPreviewRetest {
  questionId: string
  prompt: string
  options: LearningPreviewOption[]
}

export interface LearningPreviewCheck {
  questionId: string
  prompt: string
  options: LearningPreviewOption[]
  remediation: string
  retest: LearningPreviewRetest
}

export interface LearningPreviewLesson {
  explanation: string
  workedExample: string
  supplemental: string
}

export interface LearningPreviewUnit {
  unitId: string
  knowledgePointId: string
  type: KnowledgePointType
  title: string
  objective: string
  delivery: LearningPreviewDelivery
  lesson: LearningPreviewLesson
  evidence: LearningPreviewEvidence
  check: LearningPreviewCheck
}

export interface LearningPreviewCourse {
  courseId: string
  title: string
  preview: true
  sourceText: string
  progress: {
    completed: number
    total: number
    mastery: number
  }
  units: LearningPreviewUnit[]
}

export interface LearningPreviewCourseOptions {
  courseId?: string
  title?: string
}

function previewEvidence(evidence: EvidenceSpan | undefined): LearningPreviewEvidence {
  if (evidence === undefined) {
    return {
      kind: 'summary',
      text: '当前知识点没有可定位的原文引用，本预览只展示已确认陈述。',
    }
  }
  return {
    kind: 'quote',
    quote: evidence.quote,
    contextBefore: evidence.contextBefore,
    contextAfter: evidence.contextAfter,
    textStart: evidence.textStart,
    textEnd: evidence.textEnd,
  }
}

function previewUnit(point: KnowledgePointSnapshot, index: number): LearningPreviewUnit {
  const questionId = `check-${point.knowledgePointId}`
  return {
    unitId: `unit-${point.knowledgePointId}`,
    knowledgePointId: point.knowledgePointId,
    type: point.type,
    title: point.title,
    objective: `能够用自己的话解释${point.title}，并把结论对应到原文证据。`,
    delivery: index === 0 ? 'current' : 'upcoming',
    lesson: {
      explanation: point.statement,
      workedExample: `先在材料中找到“${point.title}”对应的结论，再说明这条结论解决了什么问题。`,
      supplemental: '辅助解释：把知识点与证据成对记忆，比只记一句结论更容易迁移到新问题。',
    },
    evidence: previewEvidence(point.evidence[0]),
    check: {
      questionId,
      prompt: `关于“${point.title}”，哪一种学习方式更可靠？`,
      options: [
        { optionId: 'evidence-backed', label: '先说明结论，再指出支持它的原文证据。' },
        { optionId: 'detached', label: '只记住结论，不需要确认它来自哪里。' },
      ],
      remediation: `回到“${point.title}”的证据片段：先圈出原文支持的范围，再用自己的话复述结论。`,
      retest: {
        questionId: `retest-${point.knowledgePointId}`,
        prompt: `换一段新材料后，怎样判断它是否也支持“${point.title}”？`,
        options: [
          { optionId: 'transfer', label: '检查新材料是否给出同一关系或机制的直接依据。' },
          { optionId: 'surface-match', label: '只要出现相同关键词，就视为完全支持。' },
        ],
      },
    },
  }
}

export function createLearningPreviewCourse(
  points: KnowledgePointSnapshot[],
  sourceText: string,
  options: LearningPreviewCourseOptions = {},
): LearningPreviewCourse {
  const first = points[0]
  const defaultTitle = first === undefined
    ? '新的学习路径'
    : points.length === 1 ? `${first.title} · 学习路径` : `${first.title}等 ${points.length} 个知识点`
  return {
    courseId: options.courseId ?? (first === undefined ? 'preview-empty' : `preview-${first.knowledgePointId}`),
    title: options.title ?? defaultTitle,
    preview: true,
    sourceText,
    progress: { completed: 0, total: points.length, mastery: 0 },
    units: points.map(previewUnit),
  }
}

export function gradeLearningPreview(questionId: string, optionId: string): boolean {
  return questionId.startsWith('retest-') ? optionId === 'transfer' : optionId === 'evidence-backed'
}
