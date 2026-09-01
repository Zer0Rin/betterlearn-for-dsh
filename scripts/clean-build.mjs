import { rm } from 'node:fs/promises'

await rm('lib', { recursive: true, force: true })
