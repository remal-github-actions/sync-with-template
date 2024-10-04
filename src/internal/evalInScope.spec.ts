import { evalInScope } from './evalInScope.js'

describe(evalInScope.name, () => {

    it('simple', () => {
        expect(evalInScope('return x + y', { x: 1, y: 2 }))
            .toStrictEqual(3)
    })

})
