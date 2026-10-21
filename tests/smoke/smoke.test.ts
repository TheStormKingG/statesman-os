import { describe, it, expect } from 'vitest'
describe('toolchain smoke', () => {
  it('runs a sync assertion', () => { expect(1 + 1).toBe(2) })
  it('runs async/await', async () => { expect(await Promise.resolve(42)).toBe(42) })
  it('reports the runtime', () => { expect(process.version).toMatch(/^v\d+/) })
})
