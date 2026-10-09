import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { ToolCallContext } from 'red-bean-qing-tuan/pipeline'
import { DefaultRestorer } from 'red-bean-qing-tuan/pipeline'
import { FILE_UNCHANGED_STUB, UnrestrictedReadTool } from 'red-bean-qing-tuan/tools'

const CONTEXT: ToolCallContext = Object.freeze({
  threadId: 'thread-1',
  userId: 'user-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  callId: 'call-1',
  checkpointRevision: 1n,
  fencingToken: 1n,
})
const SIGNAL = new AbortController().signal

void describe('Runtime read-to-restore integration', () => {
  let directory = ''
  let file = ''

  before(async (): Promise<void> => {
    directory = await mkdtemp(path.join(tmpdir(), 'rbng-restore-'))
    file = path.join(directory, 'context.txt')
    await writeFile(file, 'hello restore chain\n第二行内容', 'utf8')
  })

  after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true })
  })

  void it('restores preserved file content after compaction', async () => {
    const tool = new UnrestrictedReadTool()
    const result = await tool.execute({ file_path: file }, CONTEXT, SIGNAL)
    assert.equal(result.preserve?.kind, 'file')
    assert.equal(result.preserve?.key, file)

    const attachments = await new DefaultRestorer().buildAttachments(
      result.preserve === undefined ? [] : [result.preserve],
      SIGNAL
    )
    assert.equal(attachments.length, 1)
    assert.match(attachments[0]?.content ?? '', /<tool_use>Read\("/)
    assert.match(attachments[0]?.content ?? '', /hello restore chain/)
  })

  void it('does not preserve an unchanged read stub', async () => {
    const tool = new UnrestrictedReadTool()
    const first = await tool.execute({ file_path: file }, CONTEXT, SIGNAL)
    assert.ok(first.preserve)
    const second = await tool.execute({ file_path: file }, CONTEXT, SIGNAL)
    assert.equal(second.content, FILE_UNCHANGED_STUB)
    assert.equal(second.preserve, undefined)
  })
})
