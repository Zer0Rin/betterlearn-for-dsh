import { describe, expect, test, vi } from 'vitest'
import {
  DshModelSelectionResolver,
  ModelSelectionResolutionError,
} from '../src/product/model-selection-resolver.js'

describe('DshModelSelectionResolver', () => {
  test('resolves one detached effective selection through the public llm seam', async () => {
    const resolveCallConfig = vi.fn(async () => ({
      provider: 'provider-fixture',
      model: 'model-fixture',
      reasoningEffort: 'high',
      maxTokens: 8_192,
    }))
    const resolver = new DshModelSelectionResolver({ llm: { resolveCallConfig } } as never)
    const input = {
      provider: 'provider-fixture',
      model: 'model-fixture',
      reasoningEffort: 'medium',
    }

    const resolved = await resolver.resolve(input)

    expect(resolveCallConfig).toHaveBeenCalledWith({
      provider: 'provider-fixture',
      model: 'model-fixture',
      reasoningEffort: 'medium',
      maxTokens: 8_192,
    }, undefined)
    expect(resolved).toEqual({
      provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'high',
    })
    expect(resolved).not.toBe(input)
    expect(resolved).not.toHaveProperty('maxTokens')
  })

  test('materializes adapter defaults and maps failures to one product error', async () => {
    const materialized = new DshModelSelectionResolver({ llm: {
      resolveCallConfig: vi.fn(async () => ({
        provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'low', maxTokens: 8_192,
      })),
    } } as never)
    await expect(materialized.resolve({
      provider: 'provider-fixture', model: 'model-fixture',
    })).resolves.toEqual({
      provider: 'provider-fixture', model: 'model-fixture', reasoningEffort: 'low',
    })

    const failed = new DshModelSelectionResolver({ llm: {
      resolveCallConfig: vi.fn(async () => { throw new Error('adapter detail') }),
    } } as never)
    const error = await failed.resolve({ provider: 'p', model: 'm' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(ModelSelectionResolutionError)
    expect(error).toMatchObject({ code: 'MODEL_SELECTION_INVALID' })
    expect(String(error)).not.toContain('adapter detail')
  })
})
