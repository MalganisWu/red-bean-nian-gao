import { z } from 'zod'

import type { PresignRequestDto } from './dto.js'

/** 下载/删除通配路由的对象 key：非空且不允许出现 `..` 段（Fastify splat 参数键为 '*'）。 */
export const objectPathSchema = z.object({
  '*': z
    .string()
    .min(1, '对象 key 不能为空')
    .refine(
      (value) => !value.split('/').some((segment) => segment === '..'),
      '对象 key 不能包含 .. 段'
    ),
})

export const presignRequestSchema: z.ZodType<PresignRequestDto> = z.object({
  key: z.string().min(1),
  expires: z.number().int().optional(),
})
