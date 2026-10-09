import { rm } from 'node:fs/promises'

for (const directory of ['dist', '.test-dist']) {
  await rm(directory, { recursive: true, force: true })
}
