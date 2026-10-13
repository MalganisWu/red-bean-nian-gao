import type { ObjectInfo } from '../service/application/model/object-result.js'
import type { ObjectInfoDto } from './storage.dto.js'

/**
 * 对象元信息 → wire DTO；字段名转 snake_case。
 *
 * 投影方向固定为「应用层模型 → wire DTO」：内部命名在此收口为契约字段名，调用方不得直接
 * 序列化应用层模型。纯映射，无校验分支、不会抛错。
 *
 * @param info - 应用层的对象元信息；仅读取字段，本层不做存在性判断
 * @returns 符合 API 契约的对象信息 DTO，可进成功信封
 */
export function toObjectInfoDto(info: ObjectInfo): ObjectInfoDto {
  return {
    key: info.key,
    size: info.size,
    content_type: info.contentType,
    etag: info.etag,
  }
}
