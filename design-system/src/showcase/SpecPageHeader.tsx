// 内部件 · SpecPageHeader。
// 展示站各组件页共用的标题区（标题 / 说明 / 备注三段），不对外承诺 API。

/** 规范页头部 Props；三段文字依次渲染为标题、说明与备注，均为必填。 */
export interface SpecPageHeaderProps {
  /** 组件页主标题，渲染为 `h2`。 */
  title: string
  /** 一句话说明该组件解决什么问题，渲染为标题下的段落。 */
  description: string
  /** 补充约定或边界（如“颜色必须配文字”），渲染为标题区的弱化说明。 */
  note: string
}

/**
 * 规范页头部：展示站组件页的标题区。
 *
 * @param props - 组件属性；字段语义见 `SpecPageHeaderProps`。
 */
export function SpecPageHeader(props: SpecPageHeaderProps) {
  const { title, description, note } = props
  return (
    <header className="spec-page__header">
      <h2>{title}</h2>
      <p>{description}</p>
      <span>{note}</span>
    </header>
  )
}
