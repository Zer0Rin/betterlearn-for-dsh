import { describe, expect, test } from 'vitest'

import {
  assertProductSchemaAssets,
  verifyProductSchemaPackage,
} from '../scripts/verify-phase1b-core.mjs'

describe('product schema package verification', () => {
  test('accepts only the product schema source assets', async () => {
    await expect(assertProductSchemaAssets()).resolves.toEqual({ schema: '001_product.sql' })
  })

  test('includes the product schema in the published tarball', async () => {
    await expect(verifyProductSchemaPackage()).resolves.toMatchObject({ schema: '001_product.sql' })
  })
})
