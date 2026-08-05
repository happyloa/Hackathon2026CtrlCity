import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime'
import type { BriefingFact, DashboardArtifact, HorizonKey } from '~/shared/ops'

export interface BriefingRequest {
  asOf?: string
  horizon: HorizonKey
  district?: string
}

export interface NarrativeConfig {
  provider: string
  region?: string
  modelId?: string
}

export interface BriefingResponse {
  provider: 'template' | 'bedrock'
  headline: string
  narrative: string
  citedFacts: BriefingFact[]
  recommendedDispatchIds: string[]
}

function printableFact(fact: BriefingFact): string {
  return `${fact.label}: ${fact.value}`
}

function factsForBriefing(dashboard: DashboardArtifact): BriefingFact[] {
  const facts = dashboard.briefingFacts.slice(0, 5)
  if (facts.length > 0) return facts

  return [
    { label: '高風險站點', value: dashboard.summary.highRiskNext60m },
    { label: '待處理告警', value: dashboard.alerts.filter(alert => alert.status === 'open').length },
    { label: '待人工確認調度', value: dashboard.dispatches.filter(dispatch => dispatch.status === 'proposed').length },
  ]
}

function templateBriefing(dashboard: DashboardArtifact, request: BriefingRequest): BriefingResponse {
  const openAlerts = dashboard.alerts.filter(alert => alert.status === 'open')
  const proposedDispatches = dashboard.dispatches.filter(dispatch => dispatch.status === 'proposed')
  const scope = request.district ? `${request.district}的` : ''
  const topAlert = openAlerts[0]
  const topStation = topAlert
    ? dashboard.stations.find(station => station.id === topAlert.stationId)?.name
    : undefined
  const headline = topStation
    ? `優先處理 ${topStation} 的 ${request.horizon} 分鐘風險`
    : `${scope}站點目前沒有需要立即調度的高風險告警`
  const narrative = topAlert
    ? `${scope}範圍內有 ${openAlerts.length} 筆待處理告警，${topStation} 的風險分數為 ${Math.round(topAlert.riskScore * 100)}%。建議先由已列出的鄰近供給站執行 ${proposedDispatches.length} 筆人工覆核後的調度，再於下一個資料更新週期確認成效。`
    : `${scope}範圍內目前沒有待處理告警；仍建議持續觀察未來 ${request.horizon} 分鐘預測，並由值班人員覆核任何新出現的調度建議。`

  return {
    provider: 'template',
    headline,
    narrative,
    citedFacts: factsForBriefing(dashboard),
    recommendedDispatchIds: proposedDispatches.slice(0, 3).map(dispatch => dispatch.id),
  }
}

function extractConverseText(response: ConverseCommandOutput): string {
  const content = response.output?.message?.content ?? []
  return content
    .map(part => part.text ?? '')
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
}

async function bedrockBriefing(dashboard: DashboardArtifact, request: BriefingRequest, config: NarrativeConfig): Promise<BriefingResponse | null> {
  if (config.provider !== 'bedrock' || !config.region || !config.modelId) return null

  const facts = factsForBriefing(dashboard)
  const dispatches = dashboard.dispatches
    .filter(dispatch => dispatch.status === 'proposed')
    .slice(0, 3)
    .map(dispatch => `${dispatch.id}: ${dispatch.bikeCount} 輛，${dispatch.fromStationId} -> ${dispatch.toStationId}`)
  const prompt = [
    `資料時間：${dashboard.meta.asOf}`,
    `預測時間窗：${request.horizon} 分鐘`,
    `範圍：${request.district || '全新北市'}`,
    '可引用的結構化事實：',
    ...facts.map(printableFact),
    '可建議人工覆核的調度：',
    ...(dispatches.length ? dispatches : ['無']),
    '請以繁體中文寫 2 到 3 句的營運摘要。只能根據上述事實，不能編造車輛數、站名、事故、天氣、即時狀態或已完成的動作；請明確說明調度仍須人工覆核。',
  ].join('\n')

  try {
    const client = new BedrockRuntimeClient({ region: config.region })
    const response = await client.send(new ConverseCommand({
      modelId: config.modelId,
      system: [{ text: '你是公共自行車營運輔助工具。回覆必須可追溯到提供的事實，且不得聲稱已執行調度。' }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 240, temperature: 0.2 },
    }))
    const narrative = extractConverseText(response)
    if (!narrative) return null

    return {
      provider: 'bedrock',
      headline: `${request.district ? `${request.district} ` : ''}${request.horizon} 分鐘營運摘要`,
      narrative,
      citedFacts: facts,
      recommendedDispatchIds: dashboard.dispatches.filter(dispatch => dispatch.status === 'proposed').slice(0, 3).map(dispatch => dispatch.id),
    }
  } catch (error) {
    console.warn('[briefing] Bedrock narration failed; using template fallback.', error instanceof Error ? error.message : error)
    return null
  }
}

export async function createBriefing(dashboard: DashboardArtifact, request: BriefingRequest, config: NarrativeConfig): Promise<BriefingResponse> {
  const fromBedrock = await bedrockBriefing(dashboard, request, config)
  return fromBedrock ?? templateBriefing(dashboard, request)
}
