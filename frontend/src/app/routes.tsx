import { Navigate, Route, Routes as RouterRoutes } from 'react-router-dom'
import { RequireAuth } from '@/app/RequireAuth'
import { ROUTES } from '@/lib/constants'
import { LoginPage } from '@/pages/auth/LoginPage'
import { RegisterPage } from '@/pages/auth/RegisterPage'
import { AuthLayout } from '@/pages/auth/AuthLayout'
import { ChatPage } from '@/pages/chat/ChatPage'
import { ProfilePage } from '@/pages/profile/ProfilePage'
import { TasksPage } from '@/pages/tasks/TasksPage'
import { TaskDetailPage } from '@/pages/tasks/TaskDetailPage'
import { ExecutionResultPage } from '@/pages/tasks/ExecutionResultPage'

/** 应用路由表；认证页与主应用分属不同的 layout。 */
export function Routes() {
  return (
    <RouterRoutes>
      {/* Auth pages */}
      <Route element={<AuthLayout />}>
        <Route path={ROUTES.LOGIN} element={<LoginPage />} />
        <Route path={ROUTES.REGISTER} element={<RegisterPage />} />
      </Route>

      {/* Protected pages */}
      <Route element={<RequireAuth />}>
        <Route path={ROUTES.CHAT} element={<ChatPage />} />
        <Route path={ROUTES.PROFILE} element={<ProfilePage />} />
        <Route path={ROUTES.TASKS} element={<TasksPage />} />
        <Route path={ROUTES.TASK_DETAIL} element={<TaskDetailPage />} />
        <Route path={ROUTES.TASK_EXECUTION_DETAIL} element={<ExecutionResultPage />} />
      </Route>

      {/* Default redirect */}
      <Route path={ROUTES.HOME} element={<Navigate to={ROUTES.CHAT} replace />} />
    </RouterRoutes>
  )
}
