import { Outlet } from 'react-router-dom'
import { BrandMark } from '@/components/retroui/BrandMark'

/** 认证布局：纯色画布、无衬线字标和克制分隔线。 */
export function AuthLayout() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <div className="w-full max-w-sm p-6">
        <div className="pb-6 text-center">
          <p className="font-sans text-[22px] font-semibold text-foreground">
            红豆
            <BrandMark />
            年糕
          </p>
        </div>
        <div className="border-t border-border-strong pt-6">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
