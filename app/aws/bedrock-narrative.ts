import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import type { BriefingFact } from '../shared/ops'
import type { BriefingRequest, GeneratedBriefing, NarrativeProvider } from './contracts'
import { environmentValue } from './runtime-env'

export interface BedrockNarrativeOptions {
  modelId: string
  region?: string
  client?: BedrockRuntimeClient
}

/**
 * Fact-grounded Bedrock adapter. It deliberately receives already calculated
 * risk and dispatch facts rather than asking a foundation model to forecast
 * inventory or invent vehicle counts.
 */
export class BedrockNarrativeProvider implements NarrativeProvider {
  private readonly client: BedrockRuntimeClient

  constructor(private readonly options: BedrockNarrativeOptions) {
    if (!options.modelId) {
      throw new Error('BEDROCK_MODEL_ID is required when GENAI_BACKEND=bedrock')
    }

    const region = options.region || environmentValue('AWS_REGION')
    if (!region) {
      throw new Error('AWS_REGION is required when GENAI_BACKEND=bedrock')
    }

    // The default credential provider chain uses the Lambda execution role in
    // AWS and a developer's AWS SSO/profile locally. No credentials are read
    // from source code or sent to the client.
    this.client = options.client ?? new BedrockRuntimeClient({ region })
  }

  async generate(request: BriefingRequest): Promise<GeneratedBriefing> {
    const response = await this.client.send(new ConverseCommand({
      modelId: this.options.modelId,
      system: [{
        text: [
          '你是交通局內部的調度晨報助手。',
          '只能依據使用者提供的 JSON 事實撰寫繁體中文摘要。',
          '不得新增站點、預測數字、車數、時間或因果解釋。',
          '將建議描述為需由人員覆核的調度建議，不可宣稱已執行。',
        ].join(''),
      }],
      messages: [{
        role: 'user',
        content: [{ text: createBriefingPrompt(request.asOf, request.facts) }],
      }],
      inferenceConfig: {
        maxTokens: 500,
        temperature: 0.1,
      },
    }))

    const text = (response.output?.message?.content ?? [])
      .flatMap((block) => typeof block.text === 'string' ? [block.text] : [])
      .join('\n')
      .trim()

    if (!text) {
      throw new Error('Bedrock returned an empty briefing')
    }

    return {
      text,
      modelId: this.options.modelId,
      generatedAt: new Date().toISOString(),
      requestId: response.$metadata.requestId,
    }
  }
}

export function createBriefingPrompt(asOf: string, facts: BriefingFact[]): string {
  return JSON.stringify({
    asOf,
    facts: facts.map((fact) => ({
      label: fact.label,
      value: fact.value,
      stationId: fact.stationId,
      alertId: fact.alertId,
      dispatchId: fact.dispatchId,
    })),
  })
}
