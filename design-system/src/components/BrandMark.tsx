/**
 * BrandMark —— 红豆年糕的字标签名 mark。
 * 在字标里它读作一个「点」（如：红豆<mark>年糕），近看是一枚红豆瓣——圆身 + 豆脐弧线。
 * 只用品牌点（AuthLayout、SessionSidebar）；颜色随 light / dark 的品牌语义切换。
 *
 * @param props - 组件属性；`size` 为 mark 的边长（像素），缺省 13 以便与相邻文字字号齐平。
 */
export function BrandMark(props: { size?: number }) {
  const { size = 13 } = props
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      aria-hidden
      className="inline-block align-[-1px]"
    >
      {/* 豆身 */}
      <circle cx="6" cy="6" r="5.2" fill="var(--brand-indicator)" />
      {/* 豆脐弧线（微弯皱褶），造型克制，近了才读出来是豆 */}
      <path
        d="M3.3 6.6c1.1-1.1 2.5-1.4 3.9-1.1"
        stroke="var(--brand-text)"
        strokeWidth="1.1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}
