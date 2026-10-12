import type { ObjectInfo } from '../service/application/model/object-result.js'
import type { ObjectInfoDto } from './storage.dto.js'

/** 对象元信息 → wire DTO；字段名转 snake_case。 */
export function toObjectInfoDto(info: ObjectInfo): ObjectInfoDto {
  return {
    key: info.key,
    size: info.size,
    content_type: info.contentType,
    etag: info.etag,
  }
}
