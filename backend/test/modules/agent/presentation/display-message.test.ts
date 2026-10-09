import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type DisplayMessage } from '../../../../src/modules/agent/presentation/model/display-message.js'
import { serializeDisplayMessage } from '../../../../src/modules/agent/presentation/presenter/display-message-presenter.js'

void describe('display message JSON contract', () => {
  void it('preserves the complete persisted wire shape', () => {
    const message: DisplayMessage = {
      role: 'assistant',
      content: '完成',
      cards: [{ type: 'notice', data: { ok: true } }],
      sections: [{ type: 'content', content: '完成', timestamp: 20 }],
      source: 'agent',
      meta: {
        scheduledTask: {
          taskId: 'task-1',
          taskName: '提醒',
          status: 'completed',
          executionId: 'exec-1',
          scheduledAt: 30,
          completedAt: 40,
        },
        runStartedAt: 5,
      },
      timestamp: 50,
    }

    assert.equal(
      JSON.stringify(serializeDisplayMessage(message)),
      '{"role":"assistant","content":"完成","cards":[{"type":"notice","data":{"ok":true}}],"sections":[{"type":"content","content":"完成","timestamp":20}],"source":"agent","meta":{"scheduled_task":{"task_id":"task-1","task_name":"提醒","status":"completed","execution_id":"exec-1","scheduled_at":30,"completed_at":40},"run_started_at":5},"timestamp":50}'
    )
  })

  void it('omits optional fields while retaining required zero values', () => {
    assert.equal(
      JSON.stringify(serializeDisplayMessage({ role: 'user', timestamp: 1 })),
      '{"role":"user","timestamp":1}'
    )
  })
})
