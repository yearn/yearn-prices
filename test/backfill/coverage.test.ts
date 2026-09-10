import { expect, it } from 'vitest'
import { classifyCoverage, ranges, validateCoverageChart } from '../../src/backfill/coverage'
it('separates mixed gaps and newly covered dates', () => {
  expect(classifyCoverage([1, 3, 5, 6], [2, 4, 5]).classifications).toEqual([
    'leading',
    'interior',
    'now-covered',
    'trailing'
  ])
})
it('retains incomplete investigations rather than asserting permanent absence', () => {
  expect(classifyCoverage([1], [], true)).toMatchObject({
    incomplete: true,
    first: null,
    classifications: ['no-observed-coverage']
  })
})
it('deduplicates and groups contiguous daily gaps', () => {
  expect(ranges([86399, 172799, 172799, 345599])).toEqual([
    { start: '1970-01-01', end: '1970-01-02', days: 2 },
    { start: '1970-01-04', end: '1970-01-04', days: 1 }
  ])
})

it('keeps malformed and conflicting provider records separate from missing', () => {
  expect(() => validateCoverageChart({ coins: {} }, ['a'])).not.toThrow()
  expect(() => validateCoverageChart({ coins: { a: null } }, ['a'])).toThrow()
  expect(() =>
    validateCoverageChart(
      {
        coins: {
          a: {
            prices: [
              { timestamp: 1, price: 1 },
              { timestamp: 1, price: 2 }
            ]
          }
        }
      },
      ['a']
    )
  ).toThrow('Conflicting')
})
