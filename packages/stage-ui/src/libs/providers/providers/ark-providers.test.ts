import type { ComposerTranslation } from 'vue-i18n'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const createOpenAIMock = vi.fn((apiKey: string, baseURL: string) => ({
  apiKey,
  baseURL,
  chat: vi.fn((model: string) => ({
    apiKey,
    baseURL,
    model,
  })),
}))

vi.mock('@xsai-ext/providers/create', () => ({
  createOpenAI: createOpenAIMock,
}))

const englishT = ((key: string) => ({
  'settings.pages.providers.provider.volcengine-coding-plan.models.ark-code-latest.description': 'Uses the model selected in the Coding Plan console, including Auto. Changes apply in 3–5 minutes.',
  'settings.pages.providers.provider.volcengine-coding-plan.models.legacy.description': 'Legacy Coding Plan model scheduled for retirement. Switch to a currently supported model.',
})[key] ?? key) as unknown as ComposerTranslation

describe('ark chat provider definitions', () => {
  beforeEach(() => {
    vi.resetModules()
    createOpenAIMock.mockClear()
  })

  it('lists prefixed models and strips the prefix before chat requests', async () => {
    const { getDefinedProvider } = await import('./registry')
    await import('./volcengine-coding-plan')

    const provider = getDefinedProvider('volcengine-coding-plan')
    expect(provider).toBeDefined()

    const schema = provider!.createProviderConfig({ t: input => input }) as any
    const parsedConfig = schema.parse({
      apiKey: 'test-key',
    })

    expect(parsedConfig.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/v3')

    const providerInstance = provider!.createProvider(parsedConfig) as any
    const chatConfig = providerInstance.chat('volcengine-coding-plan/doubao-seed-2.1-turbo')
    expect(chatConfig.model).toBe('doubao-seed-2.1-turbo')

    const listedModels = await provider!.extraMethods!.listModels!(parsedConfig, providerInstance, { t: englishT })
    expect(listedModels.map(model => model.id)).toEqual([
      'volcengine-coding-plan/ark-code-latest',
      'volcengine-coding-plan/doubao-seed-2.1-turbo',
      'volcengine-coding-plan/doubao-seed-2.0-lite',
      'volcengine-coding-plan/minimax-m3',
      'volcengine-coding-plan/kimi-k2.7-code',
      'volcengine-coding-plan/glm-5.3',
      'volcengine-coding-plan/deepseek-v4-flash',
      'volcengine-coding-plan/deepseek-v4-pro',
      'volcengine-coding-plan/doubao-seed-2.0-code',
      'volcengine-coding-plan/doubao-seed-2.0-pro',
    ])

    expect(listedModels[0]).toEqual({
      description: 'Uses the model selected in the Coding Plan console, including Auto. Changes apply in 3–5 minutes.',
      id: 'volcengine-coding-plan/ark-code-latest',
      name: 'ark-code-latest',
      provider: 'volcengine-coding-plan',
    })
    expect(listedModels.slice(-2)).toEqual([
      {
        contextLength: 256000,
        deprecated: true,
        description: 'Legacy Coding Plan model scheduled for retirement. Switch to a currently supported model.',
        id: 'volcengine-coding-plan/doubao-seed-2.0-code',
        name: 'doubao-seed-2.0-code',
        provider: 'volcengine-coding-plan',
      },
      {
        contextLength: 256000,
        deprecated: true,
        description: 'Legacy Coding Plan model scheduled for retirement. Switch to a currently supported model.',
        id: 'volcengine-coding-plan/doubao-seed-2.0-pro',
        name: 'doubao-seed-2.0-pro',
        provider: 'volcengine-coding-plan',
      },
    ])
  })

  // https://github.com/moeru-ai/airi/pull/2321#discussion_r3810499979
  it('localizes Volcengine model descriptions for the PR #2321 review', async () => {
    const { getDefinedProvider } = await import('./registry')
    await import('./volcengine-coding-plan')

    const provider = getDefinedProvider('volcengine-coding-plan')
    expect(provider).toBeDefined()

    const schema = provider!.createProviderConfig({ t: input => input }) as any
    const config = schema.parse({ apiKey: 'test-key' })
    const providerInstance = provider!.createProvider(config)
    const t = vi.fn((key: string) => ({
      'settings.pages.providers.provider.volcengine-coding-plan.models.ark-code-latest.description': 'Localized alias description',
      'settings.pages.providers.provider.volcengine-coding-plan.models.legacy.description': 'Localized legacy description',
    })[key] ?? key) as unknown as ComposerTranslation

    const models = await provider!.extraMethods!.listModels!(config, providerInstance, { t })

    expect(models[0].description).toBe('Localized alias description')
    expect(models.slice(-2).map(model => model.description)).toEqual([
      'Localized legacy description',
      'Localized legacy description',
    ])
  })

  it('registers byteplus providers with the spec base urls', async () => {
    const { getDefinedProvider } = await import('./registry')
    await import('./byteplus')
    await import('./byteplus-coding-plan')

    const byteplus = getDefinedProvider('byteplus')
    const byteplusCodingPlan = getDefinedProvider('byteplus-coding-plan')

    expect(byteplus).toBeDefined()
    expect(byteplusCodingPlan).toBeDefined()

    const byteplusConfig = (byteplus!.createProviderConfig({ t: input => input }) as any).parse({ apiKey: 'test-key' })
    const byteplusCodingPlanConfig = (byteplusCodingPlan!.createProviderConfig({ t: input => input }) as any).parse({ apiKey: 'test-key' })

    expect(byteplusConfig.baseUrl).toBe('https://ark.ap-southeast.bytepluses.com/api/v3')
    expect(byteplusCodingPlanConfig.baseUrl).toBe('https://ark.ap-southeast.bytepluses.com/api/coding/v3')

    const byteplusModels = await byteplus!.extraMethods!.listModels!(byteplusConfig, byteplus!.createProvider(byteplusConfig), { t: englishT })
    const byteplusCodingPlanModels = await byteplusCodingPlan!.extraMethods!.listModels!(byteplusCodingPlanConfig, byteplusCodingPlan!.createProvider(byteplusCodingPlanConfig), { t: englishT })

    expect(byteplusModels.map(model => model.id)).toEqual([
      'byteplus/seed-2-0-pro-260328',
      'byteplus/seed-2-0-lite-260228',
      'byteplus/seed-2-0-mini-260215',
      'byteplus/kimi-k2-5-260127',
      'byteplus/glm-4-7-251222',
    ])
    expect(byteplusCodingPlanModels.map(model => model.id)).toEqual([
      'byteplus-coding-plan/dola-seed-2.0-pro',
      'byteplus-coding-plan/dola-seed-2.0-lite',
      'byteplus-coding-plan/bytedance-seed-code',
      'byteplus-coding-plan/glm-4.7',
      'byteplus-coding-plan/kimi-k2.5',
      'byteplus-coding-plan/gpt-oss-120b',
    ])
  })
})
