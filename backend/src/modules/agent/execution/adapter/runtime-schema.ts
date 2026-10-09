import { z } from 'zod'

import type { StoredRuntimeState } from '../model/runtime-state.js'

/** 数据库边界使用的 Runtime 状态信封 Schema；payload 由 SDK Adapter 再做深层校验。 */
export const storedRuntimeStateSchema: z.ZodType<StoredRuntimeState> = z.object({
  engine: z.literal('qing-tuan'),
  version: z.number().int().positive(),
  payload: z.record(z.string(), z.json()),
})
